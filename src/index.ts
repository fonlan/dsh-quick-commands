/**
 * @fonlan/dsh-quick-commands host half: per-workspace quick commands.
 *
 * Registers the `quick-commands` settings namespace (workspaceId → command
 * sets + popup anchor), owns the subprocess runner that executes commands with
 * a fixed workspace cwd, and serves the fenced JSON API the client calls for
 * config CRUD and live command output.
 *
 * Remote workspaces: when the workspace path is a @dsh-ssh/dsh-ssh placeholder
 * directory and the `sshPool` service is present, commands stream over SSH on
 * the remote host (same tail/offset semantics as local runs). The SSH backend
 * is resolved lazily per run, so plugin load order is irrelevant and the
 * absence of dsh-ssh degrades cleanly to local-only behaviour.
 */
import type { Context } from '@deepseek-ai/cordis'
import { QuickCommandRunner, type RemoteBackend } from './server/runner.js'
import { readHostConfig } from './server/remote.js'
import { registerSettings } from './server/settings.js'
import { registerApiRoutes } from './server/rpc.js'

export const name = '@fonlan/dsh-quick-commands'

export const inject = ['settings']

/** No plugin-level config; all configuration lives in the settings namespace. */
export function apply(ctx: Context): void {
  const settings = registerSettings(ctx)
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    ctx.logger?.warn?.('@fonlan/dsh-quick-commands: subprocess service unavailable; commands cannot run')
    return
  }
  // Remote backend (duck-typed over @dsh-ssh/dsh-ssh): resolved lazily so the
  // sshPool service is picked up whenever the SSH plugin loads.
  const resolveRemote = (): RemoteBackend | undefined => {
    const sshPool = ctx.get('sshPool') as
      | { acquire(cfg: { id: string; [key: string]: unknown }): Promise<unknown>; release(): void }
      | undefined
    if (sshPool === undefined || typeof sshPool.acquire !== 'function' || typeof sshPool.release !== 'function') {
      return undefined
    }
    return {
      pool: sshPool as never,
      resolveHost: (hostId) => readHostConfig((ns) => {
        try {
          return (ctx.get('settings') as { get(ns: string): unknown } | undefined)?.get(ns)
        } catch {
          return undefined
        }
      }, hostId),
    }
  }
  const runner = new QuickCommandRunner(subprocess as never, () => resolveRemote())
  ctx.effect(() => registerApiRoutes(ctx, runner, settings), 'quick-commands: api routes')
  ctx.effect(() => () => {
    // Terminate every live process when the plugin fiber stops.
    for (const id of runner.listAll()) {
      runner.kill(id)
    }
  }, 'quick-commands: process cleanup')
}
