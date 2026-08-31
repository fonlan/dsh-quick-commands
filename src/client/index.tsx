/**
 * @fonlan/dsh-quick-commands client half.
 *
 * Registers:
 *  - `settings.plugin.item` card (keyed by the `quick-commands` settings
 *    namespace) — per-workspace command CRUD + popup anchor preference.
 *  - `conversation.session.header.utilities` entry (id `quick-commands`,
 *    order -1 → left of the Session log pill) — the quick-run ▶ button, command
 *    menu, and live output popup.
 */
import type { Context } from '@deepseek-ai/cordis'
type ClientContext = Context
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { QuickCommandsHeaderAction } from './header'
import { QuickCommandsSettingsCard } from './settings-card'
import { LOCALE_NS, zh, en } from './locales'
import './quick-commands.css'

/** Slots face (local, erased at build). */
interface Slots {
  inject(name: string, callback: () => unknown): unknown
  register(
    def: { name: string; key?: string; id?: string; order?: number; locale?: string },
    component: unknown,
  ): unknown
}

/** Services required before mounting (provided by the client runtime). */
export const inject = ['slots', 'locale']

/** Client plugin body. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'quick-commands: dictionaries')
  const t = ctx.locale.bind(LOCALE_NS)
  const slots = (ctx as unknown as { slots: Slots }).slots

  // The plugin's own Settings Card (设置 → 插件配置) rides the `quick-commands`
  // settings namespace: registering into the keyed `settings.plugin.item` slot
  // with the namespace string makes the configurable-plugins tab dispatch the
  // card next to the built-in ones (bash / agent loop / web search).
  slots.inject('settings.plugin.item', () =>
    slots.register({
      name: 'settings.plugin.item',
      key: LOCALE_NS,
      locale: LOCALE_NS,
    }, QuickCommandsSettingsCard as never),
  )

  // Session-header util: order -1 renders LEFT of the Session log pill
  // (session-log-download registers with default order 0).
  slots.inject('conversation.session.header.utilities', () =>
    slots.register({
      name: 'conversation.session.header.utilities',
      id: 'quick-commands',
      order: -1,
      locale: LOCALE_NS,
    }, QuickCommandsHeaderAction as never),
  )
}
