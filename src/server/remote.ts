/**
 * Remote (SSH) execution support: detect that a workspace path is a dsh-ssh
 * placeholder directory, and stream a quick command over an acquired SSH
 * connection.
 *
 * Deliberately dependency-free: the @dsh-ssh/dsh-ssh host plugin is consumed
 * only through duck-typed services (`sshPool` service + the `dsh-ssh-hosts`
 * settings namespace). When that plugin is absent everything degrades to the
 * local path (the runner keeps its subprocess backend untouched).
 *
 * The placeholder-path contract mirrors dsh-ssh/src/router.js exactly (it is
 * that plugin's public wire format):
 *   root   = $DSH_SSH_REMOTE_ROOT | $DSH_HOME/remote | ~/.dsh/remote
 *   layout = <root>/<hostId>/<base64url(remote absolute path)>
 * The encoded segment must decode to an absolute POSIX path (starts with
 * '/'); anything else is never misdetected as remote.
 */
import os from 'node:os'
import path from 'node:path'

/** Remote host id + remote working directory decoded from a placeholder path. */
export interface RemoteWorkspaceRef {
  hostId: string
  /** Remote absolute path of the workspace root. */
  remotePath: string
}

// ── placeholder path detection (mirrors dsh-ssh/src/router.js) ──────────────

export function remoteRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_SSH_REMOTE_ROOT !== undefined && env.DSH_SSH_REMOTE_ROOT !== '') {
    return path.resolve(String(env.DSH_SSH_REMOTE_ROOT))
  }
  const dshHome =
    env.DSH_HOME !== undefined && env.DSH_HOME !== ''
      ? String(env.DSH_HOME)
      : path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'remote')
}

function isValidHostId(hostId: string): boolean {
  if (hostId.length === 0) return false
  if (hostId === '.' || hostId === '..') return false
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hostId)
}

function encodeRemotePath(remotePath: string): string {
  return Buffer.from(String(remotePath), 'utf8').toString('base64url')
}

function decodeRemotePath(encoded: string): string | null {
  if (typeof encoded !== 'string' || encoded.length === 0) return null
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  let text: string
  try {
    text = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (encodeRemotePath(text) !== encoded) return null
  return text
}

/**
 * Local absolute path → { hostId, remotePath } when it is a dsh-ssh
 * placeholder (`<root>/<hostId>/<encoded>`), otherwise null. A coincidentally
 * matching real directory is never misdetected: the encoded segment must
 * round-trip to an absolute POSIX path.
 */
export function localPathToRemoteRef(localPath: string, env: NodeJS.ProcessEnv = process.env): RemoteWorkspaceRef | null {
  if (typeof localPath !== 'string' || localPath.length === 0) return null
  const root = remoteRoot(env)
  const rel = path.relative(root, localPath)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const segments = rel.split(path.sep)
  if (segments.length !== 2) return null
  const hostId = segments[0]
  const encoded = segments[1]
  if (!isValidHostId(hostId)) return null
  const remotePath = decodeRemotePath(encoded)
  if (remotePath === null) return null
  if (!remotePath.startsWith('/')) return null
  return { hostId, remotePath }
}

/**
 * Map a session cwd (which may be inside the placeholder workspace, e.g. a
 * subdirectory of the workspace root) onto the remote filesystem. Only paths
 * strictly inside the placeholder are re-anchored; anything else falls back to
 * the workspace's remote root.
 */
export function resolveRemoteCwd(sessionCwd: string, workspaceLocalPath: string, remotePath: string): string {
  const rel = path.relative(workspaceLocalPath, sessionCwd)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return path.posix.resolve(remotePath, rel.split(path.sep).join('/'))
  }
  return remotePath
}

// ── duck-typed SSH surface (provided by @dsh-ssh/dsh-ssh at runtime) ─────────

/** Streaming chunk the remote exec yields before the final exit-code item. */
export interface RemoteExecChunk {
  stream: 'stdout' | 'stderr'
  chunk: Buffer
}

/** The terminal item yielded by execStream: remote channel exit code. */
export interface RemoteExecExit {
  exitCode: number
}

export type RemoteExecEvent = RemoteExecChunk | RemoteExecExit

/** SshConn minimal surface (see dsh-ssh ssh-core SshConn). */
export interface SshConnLike {
  execStream(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): AsyncGenerator<RemoteExecEvent>
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; signal: string | null; stdout: string; stderr: string }>
}

/** SshPool minimal surface (see dsh-ssh ssh-core SshPool). */
export interface SshPoolLike {
  acquire(cfg: { id: string; [key: string]: unknown }): Promise<SshConnLike>
  release(): void
}

/** Error carrying a SSH-stage tag (mirrors dsh-ssh SshError.stage). */
export interface SshStageError {
  stage?: string
  message?: string
}

/**
 * Read one host's connection config from the `dsh-ssh-hosts` settings
 * namespace (id → HostConfig dict, as written by the @dsh-ssh/dsh-ssh
 * settings page). Returns `{ ...host, id }` for pool.acquire, or undefined
 * when the host is not configured. `get` is the settings.get(ns) reader.
 */
export function readHostConfig(
  get: (ns: string) => unknown,
  hostId: string,
): { id: string; [key: string]: unknown } | undefined {
  let doc: unknown
  try {
    doc = get('dsh-ssh-hosts')
  } catch {
    return undefined
  }
  if (typeof doc !== 'object' || doc === null) return undefined
  const hosts = (doc as { hosts?: Record<string, unknown> }).hosts
  if (typeof hosts !== 'object' || hosts === null) return undefined
  const host = hosts[hostId]
  if (typeof host !== 'object' || host === null) return undefined
  return { ...(host as Record<string, unknown>), id: hostId }
}

function isChunk(item: RemoteExecEvent): item is RemoteExecChunk {
  return typeof item === 'object' && item !== null && 'stream' in item
}

/** Single-quote one string for a POSIX shell (' → '\''). */
function shellQuoteSingle(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** stderr marker line: the remote process-group leader's pid ($$ of the sshd shell). */
const PID_MARKER = '__QC_PID__'

// ── remote quick-command executor ────────────────────────────────────────────

/**
 * One remote execution stream. Consumes conn.execStream in the background,
 * appends decoded chunks into the caller-provided tail buffers, and records the
 * terminal outcome.
 *
 * The command runs on the remote shell that sshd spawns for the channel (that
 * shell is the session/process-group leader; `$$` is its pid AND its pgid). The
 * leader pid is probed by prefixing `echo <marker> $$ >&2` to the command, so
 * `kill` can terminate the WHOLE process group (`kill -TERM -- -<pid>`), which
 * `pkill -f` alone cannot do for a child like `sleep 30` whose cmdline does not
 * match the original command text. The probe line is filtered out of the stderr
 * stream the user sees (a short buffer handles chunk-cut lines).
 */
export class RemoteStreamExecutor {
  private cmd = ''
  private cwd = ''
  private started = false
  /** Remote process-group leader pid (parse the marker line; null until seen). */
  private leaderPid: number | null = null
  /** Raw stderr head buffer for the (possibly chunk-cut) marker line. */
  private markerBuf = ''

  constructor(
    private readonly conn: SshConnLike,
    private readonly pool: SshPoolLike,
  ) {}

  /**
   * Start consuming the remote stream, settling the returned promise when the
   * stream ends. `onData` sees decoded text chunks, `onExit` the terminal
   * outcome (called exactly once, also on connection failure).
   */
  async start(
    cmd: string,
    cwd: string,
    onData: (stream: 'stdout' | 'stderr', text: string) => void,
    onExit: (exit: { exitCode: number | null; signal: string | null; error?: string }) => void,
  ): Promise<void> {
    this.cmd = cmd
    this.cwd = cwd
    this.started = true
    // Probe the group leader pid on stderr, then run the user command in a
    // subshell so a stray `exit` cannot end our session shell early.
    const wrapped = `echo ${PID_MARKER} $$ >&2; cd ${shellQuoteSingle(cwd)} && ( ${cmd} )`
    let exitCode: number | null = null
    let signal: string | null = null
    try {
      for await (const raw of this.conn.execStream(wrapped)) {
        const item = raw as RemoteExecEvent
        if (isChunk(item)) {
          if (item.stream === 'stdout') {
            onData('stdout', item.chunk.toString('utf8'))
          } else {
            this.emitStderr(item.chunk.toString('utf8'), onData)
          }
        } else {
          exitCode = item.exitCode
        }
      }
    } catch (error) {
      const e = error as SshStageError
      onExit({
        exitCode: null,
        signal: null,
        error: (e?.message ?? String(error)) + (e?.stage ? ` (stage: ${e.stage})` : ''),
      })
      return
    }
    onExit({ exitCode, signal })
  }

  /** Route stderr text, swallowing the (possibly split) marker line. */
  private emitStderr(text: string, onData: (stream: 'stdout' | 'stderr', text: string) => void): void {
    if (this.leaderPid !== null) {
      onData('stderr', text)
      return
    }
    this.markerBuf += text
    const nl = this.markerBuf.indexOf('\n')
    if (nl === -1) {
      // No newline yet: still potentially the marker line. Flush only when the
      // buffer grows absurdly (marker lines are tiny).
      if (this.markerBuf.length > 4096) {
        onData('stderr', this.markerBuf)
        this.markerBuf = ''
      }
      return
    }
    const head = this.markerBuf.slice(0, nl)
    this.markerBuf = this.markerBuf.slice(nl + 1)
    const m = /^__QC_PID__\s+(\d+)\s*$/.exec(head)
    if (m !== null) {
      this.leaderPid = Number(m[1])
    } else {
      onData('stderr', head + '\n')
    }
    if (this.markerBuf !== '') {
      const rest = this.markerBuf
      this.markerBuf = ''
      onData('stderr', rest)
    }
  }

  /** The probed group-leader pid, if the marker line has been seen. */
  get pid(): number | null {
    return this.leaderPid
  }

  /**
   * Terminate the remote command's whole process group (best-effort). With the
   * probed leader pid this is a true group kill (covers children like sleep);
   * before the probe arrives (or when it never does) it falls back to a
   * `pkill -f` on the exact `cd <cwd> && <cmd>` channel command line. The
   * original stream then closes; the caller records signal 'TERM'.
   */
  async kill(): Promise<void> {
    if (!this.started) return
    if (this.leaderPid !== null) {
      try {
        await this.conn.exec(`kill -TERM -- -${this.leaderPid} 2>/dev/null; pkill -TERM -P ${this.leaderPid} 2>/dev/null; true`, { timeoutMs: 10_000 })
        return
      } catch {
        // Fall through to pkill.
      }
    }
    const pattern = 'cd ' + (this.cwd ? this.cwd + ' && ' : '') + this.cmd
    const escaped = pattern.replace(/[.*+?^$[\]{}()|/\\]/g, '\\$&').replace(/'/g, "'\\''")
    try {
      await this.conn.exec(`pkill -TERM -f '${escaped}' 2>/dev/null; true`, { timeoutMs: 10_000 })
    } catch {
      // Best-effort: the stream may already have settled.
    }
  }
}
