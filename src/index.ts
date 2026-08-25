/**
 * @fonlan/dsh-quick-commands host half: per-workspace quick commands.
 *
 * Registers the `quick-commands` settings namespace (workspaceId → command
 * sets + popup anchor), owns the subprocess runner that executes commands with
 * a fixed workspace cwd, and serves the fenced JSON API the client calls for
 * config CRUD and live command output.
 */
import type { Context } from '@deepseek-ai/cordis'
import { QuickCommandRunner } from './server/runner.js'
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
  const runner = new QuickCommandRunner(subprocess as never)
  ctx.effect(() => registerApiRoutes(ctx, runner, settings), 'quick-commands: api routes')
  ctx.effect(() => () => {
    // Terminate every live process when the plugin fiber stops.
    for (const id of runner.listAll()) {
      runner.kill(id)
    }
  }, 'quick-commands: process cleanup')
}
