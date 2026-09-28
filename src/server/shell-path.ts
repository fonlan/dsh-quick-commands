/**
 * Login-shell PATH resolution for the local quick-command backend.
 *
 * `dsh web` started from a terminal inherits the user's full PATH, so a
 * configured command such as `npm run typecheck` or `docker compose up -d`
 * finds its toolchain. **DSH Desktop does not**: the Electron host is launched
 * by launchd and runs with the minimal system PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), which hides homebrew, `/usr/local/bin`,
 * nvm, corepack and Docker Desktop. Every command that leans on the user's
 * toolchain then fails with "command not found" in Desktop while the very same
 * profile keeps working in a browser-launched host.
 *
 * This module asks the user's interactive login shell for its PATH once
 * (cached for the process lifetime) and prepends it to the inherited PATH for
 * local runs. Resolution is best effort by design: a missing `$SHELL`, a
 * timeout, a non-zero exit or unparseable output all leave the inherited PATH
 * untouched, so a terminal-launched host behaves exactly as before.
 */
import { execFile } from 'node:child_process'

/** Delimiters wrapping the shell's own PATH in the probe's stdout. */
export const PATH_START = '__DSH_QC_PATH_START__'
export const PATH_END = '__DSH_QC_PATH_END__'

/** Default deadline for the login-shell probe (ms). */
export const PROBE_TIMEOUT_MS = 3000

/** Minimal probe runner shape: `child_process.execFile`, or a test double. */
export type ProbeRunner = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; env: NodeJS.ProcessEnv },
) => Promise<{ stdout?: string | Buffer }>

const defaultRunner: ProbeRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) reject(error)
      else resolve({ stdout })
    })
  })

/**
 * Extract the PATH a shell printed between the markers.
 *
 * Login profiles are free to print their own noise (nvm notices, version
 * managers, MOTDs), so only the marked span counts — never the whole stdout.
 * @param stdout - raw probe stdout.
 * @returns the marked PATH, or '' when the markers are missing.
 */
export function extractShellPath(stdout: unknown): string {
  if (typeof stdout !== 'string' && !(stdout instanceof Buffer)) return ''
  const text = String(stdout)
  const start = text.indexOf(PATH_START)
  const end = text.lastIndexOf(PATH_END)
  if (start < 0 || end < 0 || end < start) return ''
  return text.slice(start + PATH_START.length, end)
}

/**
 * Put the login-shell PATH in front of the inherited one.
 *
 * The login PATH wins (that is where the user's toolchain lives); entries from
 * the inherited PATH stay behind it as a fallback. Empty entries are dropped
 * and duplicates keep their first position.
 * @param loginPath - PATH reported by the login shell ('' when unavailable).
 * @param inheritedPath - the host process's own PATH.
 * @returns the merged PATH (the inherited value when there is no login one).
 */
export function mergePaths(loginPath: string, inheritedPath: string | undefined): string {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const part of `${loginPath}:${inheritedPath ?? ''}`.split(':')) {
    const entry = part.trim()
    if (entry === '' || seen.has(entry)) continue
    seen.add(entry)
    entries.push(entry)
  }
  return entries.join(':')
}

/** The shell program whose login PATH describes this user's environment. */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const shell = env.SHELL?.trim()
  return shell !== undefined && shell !== '' ? shell : undefined
}

/**
 * Ask `shell` (interactive login) for its PATH.
 *
 * Both flags matter: `-l` sources the profile files that own the system PATH
 * (on macOS `/etc/zprofile` → `path_helper`), `-i` additionally sources the
 * interactive config where nvm/fnm/volta and other version managers install
 * their shims (this user's node lives in `~/.zshrc`). A hung or noisy
 * interactive profile cannot block a run: the probe carries a deadline, and
 * only the marked span of stdout is read.
 * @param options.shell - shell program; defaults to `$SHELL`.
 * @param options.timeoutMs - probe deadline.
 * @param options.run - probe runner, injectable for tests.
 * @param options.env - environment the probe itself runs with.
 * @returns the login PATH, or '' when it cannot be determined.
 */
export async function resolveLoginShellPath(options: {
  shell?: string | undefined
  timeoutMs?: number
  run?: ProbeRunner
  env?: NodeJS.ProcessEnv
} = {}): Promise<string> {
  if (process.platform === 'win32') return ''
  const env = options.env ?? process.env
  const shell = options.shell ?? loginShell(env)
  if (shell === undefined) return ''
  const run = options.run ?? defaultRunner
  // `${PATH}` must stay braced: an unbraced `$PATH__DSH...` is read as one
  // identifier by POSIX shells and silently expands to nothing.
  const command = `printf '%s' "${PATH_START}\${PATH}${PATH_END}"`
  try {
    const { stdout } = await run(shell, ['-i', '-l', '-c', command], {
      timeout: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      windowsHide: true,
      env,
    })
    const path = extractShellPath(stdout).trim()
    // A list-valued shell (fish) renders "$PATH" as space-separated entries:
    // merging that would inject a single bogus entry, so keep the host PATH.
    return /[\s]/.test(path) ? '' : path
  } catch {
    // Any failure (missing shell, timeout, killed profile) keeps the inherited
    // PATH: a quick command must never be worse than the host's own shell.
    return ''
  }
}

let cached: Promise<string> | undefined

/** Cached, process-wide login-shell PATH (one probe per host lifetime). */
export function loginShellPath(): Promise<string> {
  cached ??= resolveLoginShellPath()
  return cached
}

/** Drop the cache (tests, and settings reloads that may have changed `$SHELL`). */
export function resetLoginShellPathCache(): void {
  cached = undefined
}

/**
 * Environment for one local quick command.
 *
 * A copy of the host environment with the login-shell PATH merged in front, so
 * Desktop-launched hosts see the same toolchain a terminal-launched host does.
 * @param overrides - plugin-owned variables (DSH_WORKSPACE*) merged last.
 * @returns the spawn environment.
 */
export async function localCommandEnv(overrides: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const loginPath = await loginShellPath()
  if (loginPath !== '') env.PATH = mergePaths(loginPath, process.env.PATH)
  return { ...env, ...overrides }
}
