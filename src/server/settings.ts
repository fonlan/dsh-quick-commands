/**
 * User-facing plugin settings (per-workspace command sets + popup anchor),
 * persisted through the settings service namespace `quick-commands`.
 * The DSH settings service requires a lowercase kebab-case namespace
 * (/^[a-z][a-z0-9-]*$/), so the scoped package name cannot be used here.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { QuickCommandsSettings, QuickCommandEntry, QuickPopupSize, WorkspaceCommands } from '../shared/contract.js'
import type {} from '@deepseek-ai/dsh-settings'

export const QUICK_COMMANDS_NS = 'quick-commands'

/**
 * One command entry schema. name/command may be EMPTY: the settings card edits
 * rows field-by-field (instant save per keystroke), so a partially-typed row
 * is a legitimate persisted state. Runnable validation happens at run.start.
 */
const CommandSchema = z.object({
  name: z.string(),
  command: z.string(),
})

/** One workspace command set. */
const WorkspaceCommandsSchema = z.object({
  workspaceId: z.string().min(1),
  commands: z.array(CommandSchema).max(200),
})

export const QuickCommandsSettingsSchema: z<QuickCommandsSettings> = z.object({
  workspaces: z.array(WorkspaceCommandsSchema).max(500),
  popupAnchor: z.union([z.const('corner'), z.const('button')]).default('corner'),
  // No default on purpose: a missing popupSize stays ABSENT in the resolved
  // document, so the client can distinguish "never resized" (per-anchor
  // default size) from a user-chosen size.
  popupSize: z.object({
    width: z.number().min(320).max(8192),
    height: z.number().min(200).max(8192),
  }),
})

const DEFAULT_SETTINGS: QuickCommandsSettings = {
  workspaces: [],
  popupAnchor: 'corner',
}

/** Structural settings-service subset; the real service resolves the schema. */
interface SettingsServiceLike {
  register(ns: unknown, schema: unknown): unknown
  update(ns: unknown, patch: Record<string, unknown>, expectedRevision?: number): Promise<unknown>
  mutate?(ns: unknown, ops: readonly unknown[], expectedRevision?: number): Promise<unknown>
}

/** Settings service face for the quick-commands engine. */
export interface QuickCommandsSettingsFace {
  get(): QuickCommandsSettings
  /** Read the command set bound to one workspace id. */
  commandsOf(workspaceId: string): QuickCommandEntry[]
  /** Replace the whole command set for one workspace id (instant-save). */
  setCommands(workspaceId: string, commands: QuickCommandEntry[]): Promise<void>
  /** Set the popup anchor preference. */
  setAnchor(anchor: QuickCommandsSettings['popupAnchor']): Promise<void>
  /** Persist the output popup size (drag-resize). */
  setPopupSize(size: QuickPopupSize): Promise<void>
}

export function registerSettings(ctx: Context): QuickCommandsSettingsFace {
  let current: QuickCommandsSettings = { ...DEFAULT_SETTINGS, workspaces: [] }
  let service: SettingsServiceLike | undefined

  ctx.inject(['settings'], (sctx) => {
    service = sctx.settings as unknown as SettingsServiceLike
    const scope = service.register(QUICK_COMMANDS_NS, QuickCommandsSettingsSchema) as {
      get(): QuickCommandsSettings
      watch(callback: (next: QuickCommandsSettings) => void): () => void
    }
    current = scope.get()
    scope.watch((next) => { current = next })
  })

  async function persist(patch: Record<string, unknown>): Promise<void> {
    if (service === undefined) {
      throw new Error('@fonlan/dsh-quick-commands: settings service is not available in this profile')
    }
    await service.update(QUICK_COMMANDS_NS, patch)
  }

  return {
    get: () => current,
    commandsOf: (workspaceId) => {
      const set = current.workspaces.find((w) => w.workspaceId === workspaceId)
      return set === undefined ? [] : set.commands
    },
    setCommands: async (workspaceId, commands) => {
      const next: WorkspaceCommands[] = current.workspaces.filter((w) => w.workspaceId !== workspaceId)
      if (commands.length > 0) next.push({ workspaceId, commands })
      await persist({ workspaces: next })
    },
    setAnchor: async (anchor) => {
      await persist({ popupAnchor: anchor })
    },
    setPopupSize: async (size) => {
      await persist({ popupSize: size })
    },
  }
}
