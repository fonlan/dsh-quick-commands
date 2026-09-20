/**
 * @fonlan/dsh-quick-commands client half.
 *
 * Registers:
 *  - "settings.section" page (id "quick-commands", order 330) — per-workspace
 *    command CRUD + popup anchor preference, rendered as its own page in the
 *    settings sidebar.
 *  - "conversation.session.header.utilities" entry (id "quick-commands",
 *    order -1 → left of the Session log pill) — the quick-run ▶ button, command
 *    menu, and live output popup.
 */
import type { Context } from '@deepseek-ai/cordis'
type ClientContext = Context
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { QuickCommandsHeaderAction } from './header'
import { QuickCommandsSettingsSection } from './settings-section'
import { LOCALE_NS, zh, en } from './locales'
import './quick-commands.css'

/** Slots face (local, erased at build). */
interface Slots {
  inject(name: string, callback: () => unknown): unknown
  register(
    def: { name: string; id?: string; order?: number; label?: string | (() => string); locale?: string },
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

  // The plugin's own settings page (设置 → 侧栏「快捷命令」) rides the
  // "quick-commands" locale namespace: a "settings.section" list entry gives it
  // one row in the settings sidebar and renders the page in the content column.
  slots.inject('settings.section', () =>
    slots.register({
      name: 'settings.section',
      id: 'quick-commands',
      order: 330,
      label: () => t('settingsTitle'),
      locale: LOCALE_NS,
    }, QuickCommandsSettingsSection as never),
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
