/**
 * Quick-command execution engine.
 *
 * Owns one subprocess per run (serial per workspace id), keeps bounded
 * in-memory output tails with offset-based readers for incremental client
 * polls, resolves the {workspace}/{cwd}/{title} placeholders against the
 * session-bound execution context, and terminates the whole process tree on
 * kill / popup close.
 *
 * Two backends:
 *   - local: DSH's `subprocess` service (`bash -c`/`pwsh -c`, workspace cwd).
 *   - remote: when the workspace path is a dsh-ssh placeholder directory and
 *     the `sshPool` service is present, the command streams over SSH with the
 *     workspace's remote path as cwd. The client-visible behaviour (tail +
 *     offset polls) is identical for both backends.
 */
import { randomUUID } from 'node:crypto'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { QuickCommandsSettings } from '../shared/contract.js'
import {
  localPathToRemoteRef,
  resolveRemoteCwd,
  RemoteStreamExecutor,
  type SshPoolLike,
} from './remote.js'

/** Bounded in-memory tail window per output stream (bytes). */
const TAIL_MAX_BYTES = 256 * 1024

/** Optional SSH backend (duck-typed over the @dsh-ssh/dsh-ssh plugin). */
export interface RemoteBackend {
  pool: SshPoolLike
  /** Resolve one hostId to its connection config (settings `dsh-ssh-hosts`). */
  resolveHost: (hostId: string) => { id: string; [key: string]: unknown } | undefined
}

/** Lazily-resolved SSH backend: resolved per run, so load order is irrelevant. */
export type RemoteBackendResolver = () => RemoteBackend | undefined

/** One live process entry owned by the runner. */
interface LiveRun {
  runId: string
  workspaceId: string
  commandName: string
  /** Command line after placeholder substitution (display currency). */
  resolvedCommand: string
  /** Execution kind (also selects the kill strategy). */
  kind: 'local' | 'remote'
  handle: SubprocessHandle | RemoteStreamExecutor
  /** Whole-stream byte counters (offset currency for delta reads). */
  stdoutBytes: number
  stderrBytes: number
  /** In-memory tail windows (keep the TAIL on overflow). */
  stdoutTail: string
  stderrTail: string
  /** Thrown when the tail was clipped (lossy reads report it). */
  stdoutClipped: boolean
  stderrClipped: boolean
  /** Terminal exit facts; present once the process closed. */
  outcome: { exitCode: number | null; signal: string | null } | null
  /** True when kill was requested but the stream has not settled yet. */
  killRequested: boolean
  startedAt: number
}

/** A snapshot reader over one run's captured output (delta + offsets). */
export interface RunPollResult {
  kind: 'poll'
  status: 'running' | 'exited'
  exitCode: number | null
  signal: string | null
  stdoutEnd: number
  stderrEnd: number
  stdoutDelta: string
  stderrDelta: string
  stdoutLossy: boolean
  stderrLossy: boolean
}

/** The runner's exported operations. */
export interface QuickRunner {
  /**
   * Start one command for a workspace (serial: rejects when one is live).
   * Async: a remote run acquires its SSH connection before returning.
   */
  start(input: {
    workspaceId: string
    workspacePath: string
    workspaceTitle: string
    commandName: string
    command: string
    sessionCwd: string
    popupAnchor: QuickCommandsSettings['popupAnchor']
  }): Promise<{ ok: true; runId: string; remoteHost?: string; resolvedCommand: string } | { ok: false; error: string }>
  /** Read output deltas since the caller's offsets. */
  poll(runId: string, stdoutFrom: number, stderrFrom: number): RunPollResult | null
  /** Terminate the live process tree (idempotent). */
  kill(runId: string): 'ok' | 'not-found' | 'already-exited'
  /** List live runs for the workspace (for reattach / run list). */
  forWorkspace(workspaceId: string): Array<{ runId: string; commandName: string; startedAt: number; status: 'running' | 'exited' }>
}

/** Substitute supported placeholders in the command string. */
export function resolvePlaceholders(command: string, vars: {
  workspace: string
  cwd: string
  title: string
}): string {
  return command
    .replaceAll('{workspace}', vars.workspace)
    .replaceAll('{cwd}', vars.cwd)
    .replaceAll('{title}', vars.title)
}

/** Pick the shell executable for the current platform. */
export function shellCmd(): string {
  return process.platform === 'win32' ? 'pwsh' : 'bash'
}

/** Pick the `-c` inclusive switch for the current platform. */
export function shellFlag(): '-c' {
  return '-c'
}

interface SubprocessServiceLike {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

export class QuickCommandRunner implements QuickRunner {
  private readonly runs = new Map<string, LiveRun>()
  private readonly liveByWorkspace = new Map<string, string>()

  constructor(
    private readonly subprocess: SubprocessServiceLike,
    private readonly resolveRemote?: RemoteBackendResolver,
  ) {}

  /** Resolve the remote reference lazily so SSH availability is re-checked per run. */
  private resolveRemoteBackend(): RemoteBackend | undefined {
    try {
      return this.resolveRemote?.()
    } catch {
      return undefined
    }
  }

  async start(input: {
    workspaceId: string
    workspacePath: string
    workspaceTitle: string
    commandName: string
    command: string
    sessionCwd: string
    popupAnchor: QuickCommandsSettings['popupAnchor']
  }): Promise<{ ok: true; runId: string; remoteHost?: string; resolvedCommand: string } | { ok: false; error: string }> {
    const liveId = this.liveByWorkspace.get(input.workspaceId)
    if (liveId !== undefined) {
      const live = this.runs.get(liveId)
      if (live !== undefined && live.outcome === null) {
        return { ok: false, error: `a command is already running for this workspace (${live.commandName})` }
      }
      this.liveByWorkspace.delete(input.workspaceId)
    }

    // Workspace path is a dsh-ssh placeholder → remote execution.
    const ref = localPathToRemoteRef(input.workspacePath)
    if (ref !== null) {
      const backend = this.resolveRemoteBackend()
      if (backend === undefined) {
        return {
          ok: false,
          error: `workspace ${input.workspaceId} is an SSH remote workspace (host ${ref.hostId}), but the @dsh-ssh/dsh-ssh plugin (sshPool service) is not loaded`,
        }
      }
      return this.startRemote(input, ref.hostId, ref.remotePath, backend)
    }

    return this.startLocal(input)
  }

  private async startLocal(input: {
    workspaceId: string
    workspacePath: string
    workspaceTitle: string
    commandName: string
    command: string
    sessionCwd: string
    popupAnchor: QuickCommandsSettings['popupAnchor']
  }): Promise<{ ok: true; runId: string; resolvedCommand: string }> {
    const resolved = resolvePlaceholders(input.command, {
      workspace: input.workspacePath,
      cwd: input.sessionCwd,
      title: input.workspaceTitle,
    })

    const runId = randomUUID()
    const handle = this.subprocess.spawn({
      argv: [shellCmd(), shellFlag(), resolved],
      cwd: input.workspacePath,
      graceMs: 3000,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: TAIL_MAX_BYTES },
        stderr: { maxBytes: TAIL_MAX_BYTES },
      },
      env: {
        ...process.env,
        DSH_WORKSPACE: input.workspacePath,
        DSH_WORKSPACE_ID: input.workspaceId,
        DSH_WORKSPACE_TITLE: input.workspaceTitle,
      },
    })

    const live: LiveRun = {
      runId,
      workspaceId: input.workspaceId,
      commandName: input.commandName,
      resolvedCommand: resolved,
      kind: 'local',
      handle,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTail: '',
      stderrTail: '',
      stdoutClipped: false,
      stderrClipped: false,
      outcome: null,
      killRequested: false,
      startedAt: Date.now(),
    }
    this.runs.set(runId, live)
    this.liveByWorkspace.set(input.workspaceId, runId)

    // Collect stdout deltas as they arrive (offset-based; reader sees the tail).
    const stdoutReader = handle.collected?.stdout
    const stderrReader = handle.collected?.stderr
    const drain = (): void => {
      if (stdoutReader !== undefined) {
        const read = stdoutReader.readFrom(live.stdoutBytes)
        live.stdoutBytes = read.nextOffset
        live.stdoutTail += read.text
        if (live.stdoutTail.length > TAIL_MAX_BYTES) {
          live.stdoutTail = live.stdoutTail.slice(-TAIL_MAX_BYTES)
          live.stdoutClipped = true
        }
      }
      if (stderrReader !== undefined) {
        const read = stderrReader.readFrom(live.stderrBytes)
        live.stderrBytes = read.nextOffset
        live.stderrTail += read.text
        if (live.stderrTail.length > TAIL_MAX_BYTES) {
          live.stderrTail = live.stderrTail.slice(-TAIL_MAX_BYTES)
          live.stderrClipped = true
        }
      }
    }
    // Read on a short cadence while live; final drain at exit.
    const interval = setInterval(drain, 150)
    void handle.done.then((outcome) => {
      clearInterval(interval)
      drain()
      live.outcome = { exitCode: outcome.exitCode, signal: outcome.signal }
    }).catch(() => {
      clearInterval(interval)
      live.outcome = { exitCode: null, signal: null }
    })

    return { ok: true, runId, resolvedCommand: resolved }
  }

  private async startRemote(
    input: {
      workspaceId: string
      workspacePath: string
      workspaceTitle: string
      commandName: string
      command: string
      sessionCwd: string
      popupAnchor: QuickCommandsSettings['popupAnchor']
    },
    hostId: string,
    remotePath: string,
    backend: RemoteBackend,
  ): Promise<{ ok: true; runId: string; remoteHost?: string; resolvedCommand: string } | { ok: false; error: string }> {
    const cfg = backend.resolveHost(hostId)
    if (cfg === undefined) {
      return {
        ok: false,
        error: `remote host ${hostId} is not configured in dsh-ssh-hosts — add it in Settings → SSH hosts`,
      }
    }

    let conn
    try {
      conn = await backend.pool.acquire(cfg)
    } catch (error) {
      const e = error as { stage?: string; message?: string }
      return {
        ok: false,
        error: `ssh connect to host ${hostId} failed: ${e?.message ?? String(error)}`
          + (e?.stage ? ` (stage: ${e.stage})` : ''),
      }
    }

    // Remote placeholder substitution: {workspace}/{cwd} are remote paths; the
    // session cwd is re-anchored onto the remote filesystem when it sits inside
    // the placeholder workspace.
    const remoteCwd = resolveRemoteCwd(input.sessionCwd, input.workspacePath, remotePath)
    const resolved = resolvePlaceholders(input.command, {
      workspace: remotePath,
      cwd: remoteCwd,
      title: input.workspaceTitle,
    })

    const runId = randomUUID()
    const executor = new RemoteStreamExecutor(conn, backend.pool)
    const live: LiveRun = {
      runId,
      workspaceId: input.workspaceId,
      commandName: input.commandName,
      resolvedCommand: resolved,
      kind: 'remote',
      handle: executor,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTail: '',
      stderrTail: '',
      stdoutClipped: false,
      stderrClipped: false,
      outcome: null,
      killRequested: false,
      startedAt: Date.now(),
    }
    this.runs.set(runId, live)
    this.liveByWorkspace.set(input.workspaceId, runId)

    const append = (stream: 'stdout' | 'stderr', text: string): void => {
      if (stream === 'stdout') {
        live.stdoutBytes += Buffer.byteLength(text, 'utf8')
        live.stdoutTail += text
        if (live.stdoutTail.length > TAIL_MAX_BYTES) {
          live.stdoutTail = live.stdoutTail.slice(-TAIL_MAX_BYTES)
          live.stdoutClipped = true
        }
      } else {
        live.stderrBytes += Buffer.byteLength(text, 'utf8')
        live.stderrTail += text
        if (live.stderrTail.length > TAIL_MAX_BYTES) {
          live.stderrTail = live.stderrTail.slice(-TAIL_MAX_BYTES)
          live.stderrClipped = true
        }
      }
    }

    void executor.start(
      resolved,
      remoteCwd,
      append,
      (exit) => {
        if (exit.error !== undefined && exit.error !== '') {
          append('stderr', `\n[ssh] ${exit.error}\n`)
        }
        live.outcome = {
          exitCode: exit.exitCode,
          signal: live.killRequested ? 'TERM' : exit.signal,
        }
        backend.pool.release()
      },
    )

    return { ok: true, runId, remoteHost: hostId, resolvedCommand: resolved }
  }

  poll(runId: string, stdoutFrom: number, stderrFrom: number): RunPollResult | null {
    const live = this.runs.get(runId)
    if (live === undefined) return null

    // Drain pending tail first so the poll sees the freshest state.
    if (live.kind === 'local') {
      const handle = live.handle as SubprocessHandle
      const stdoutReader = handle.collected?.stdout
      const stderrReader = handle.collected?.stderr
      if (stdoutReader !== undefined) {
        const read = stdoutReader.readFrom(live.stdoutBytes)
        live.stdoutBytes = read.nextOffset
        live.stdoutTail += read.text
        if (live.stdoutTail.length > TAIL_MAX_BYTES) {
          live.stdoutTail = live.stdoutTail.slice(-TAIL_MAX_BYTES)
          live.stdoutClipped = true
        }
      }
      if (stderrReader !== undefined) {
        const read = stderrReader.readFrom(live.stderrBytes)
        live.stderrBytes = read.nextOffset
        live.stderrTail += read.text
        if (live.stderrTail.length > TAIL_MAX_BYTES) {
          live.stderrTail = live.stderrTail.slice(-TAIL_MAX_BYTES)
          live.stderrClipped = true
        }
      }
    }

    // Delta from the caller's offset; lossy when the offset slid out of the tail.
    let stdoutDelta = live.stdoutTail
    let stdoutLossy = live.stdoutClipped
    if (stdoutFrom > 0 && stdoutFrom <= live.stdoutBytes) {
      const tailStart = live.stdoutBytes - live.stdoutTail.length
      if (stdoutFrom < tailStart) {
        stdoutLossy = true
      } else {
        stdoutDelta = live.stdoutTail.slice(stdoutFrom - tailStart)
      }
    }
    let stderrDelta = live.stderrTail
    let stderrLossy = live.stderrClipped
    if (stderrFrom > 0 && stderrFrom <= live.stderrBytes) {
      const tailStart = live.stderrBytes - live.stderrTail.length
      if (stderrFrom < tailStart) {
        stderrLossy = true
      } else {
        stderrDelta = live.stderrTail.slice(stderrFrom - tailStart)
      }
    }

    const exited = live.outcome !== null
    return {
      kind: 'poll',
      status: exited ? 'exited' : 'running',
      exitCode: exited ? live.outcome!.exitCode : null,
      signal: exited ? live.outcome!.signal : null,
      stdoutEnd: live.stdoutBytes,
      stderrEnd: live.stderrBytes,
      stdoutDelta,
      stderrDelta,
      stdoutLossy,
      stderrLossy,
    }
  }

  kill(runId: string): 'ok' | 'not-found' | 'already-exited' {
    const live = this.runs.get(runId)
    if (live === undefined) return 'not-found'
    if (live.outcome !== null) return 'already-exited'
    if (live.kind === 'local') {
      // Tree-scoped termination: SIGTERM → grace → SIGKILL escalation.
      void (live.handle as SubprocessHandle).terminate()
    } else {
      live.killRequested = true
      void (live.handle as RemoteStreamExecutor).kill()
    }
    return 'ok'
  }

  forWorkspace(workspaceId: string): Array<{ runId: string; commandName: string; startedAt: number; status: 'running' | 'exited' }> {
    const ids = this.liveByWorkspace.get(workspaceId)
    if (ids === undefined) return []
    const live = this.runs.get(ids)
    if (live === undefined) return []
    return [{
      runId: live.runId,
      commandName: live.commandName,
      startedAt: live.startedAt,
      status: live.outcome === null ? 'running' : 'exited',
    }]
  }

  /** Every live run id (terminal and running) for fiber cleanup. */
  listAll(): string[] {
    return [...this.runs.keys()]
  }
}
