/**
 * Quick-command execution engine.
 *
 * Owns one subprocess per run (serial per workspace id), keeps bounded
 * in-memory output tails with offset-based readers for incremental client
 * polls, resolves the {workspace}/{cwd}/{title} placeholders against the
 * session-bound execution context, and terminates the whole process tree on
 * kill / popup close.
 */
import { randomUUID } from 'node:crypto'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { QuickCommandsSettings } from '../shared/contract.js'

/** Bounded in-memory tail window per output stream (bytes). */
const TAIL_MAX_BYTES = 256 * 1024

/** One live process entry owned by the runner. */
interface LiveRun {
  runId: string
  workspaceId: string
  commandName: string
  /** Command line after placeholder substitution (display currency). */
  resolvedCommand: string
  handle: SubprocessHandle
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
  /** Start one command for a workspace (serial: rejects when one is live). */
  start(input: {
    workspaceId: string
    workspacePath: string
    workspaceTitle: string
    commandName: string
    command: string
    sessionCwd: string
    popupAnchor: QuickCommandsSettings['popupAnchor']
  }): { ok: true; runId: string } | { ok: false; error: string }
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

  constructor(private readonly subprocess: SubprocessServiceLike) {}

  start(input: {
    workspaceId: string
    workspacePath: string
    workspaceTitle: string
    commandName: string
    command: string
    sessionCwd: string
    popupAnchor: QuickCommandsSettings['popupAnchor']
  }): { ok: true; runId: string } | { ok: false; error: string } {
    const liveId = this.liveByWorkspace.get(input.workspaceId)
    if (liveId !== undefined) {
      const live = this.runs.get(liveId)
      if (live !== undefined && live.outcome === null) {
        return { ok: false, error: `a command is already running for this workspace (${live.commandName})` }
      }
      this.liveByWorkspace.delete(input.workspaceId)
    }

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
      handle,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTail: '',
      stderrTail: '',
      stdoutClipped: false,
      stderrClipped: false,
      outcome: null,
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

    return { ok: true, runId }
  }

  poll(runId: string, stdoutFrom: number, stderrFrom: number): RunPollResult | null {
    const live = this.runs.get(runId)
    if (live === undefined) return null

    // Drain pending tail first so the poll sees the freshest state.
    const stdoutReader = live.handle.collected?.stdout
    const stderrReader = live.handle.collected?.stderr
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
    // Tree-scoped termination: SIGTERM → grace → SIGKILL escalation.
    void live.handle.terminate()
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
