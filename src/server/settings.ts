/**
 * User-facing plugin settings (per-workspace command sets + popup anchor),
 * carried by this bundle's entry config: dsh >= 0.1.7 owns plugin settings as
 * entry config (the plugin's `Config` schema) and persists edits through
 * `settings.update`.
 *
 * All three fields are declared `volatile()` — that is what makes them
 * writable by the settings plane — and schemastery hands a volatile field to
 * `apply()` as a LIVE HANDLE (`{ get() }`), not as the value. Reading the raw
 * field therefore yields the handle object, which silently destroys the whole
 * document: `Array.isArray(handle)` is false, JSON renders `{}`, and a
 * `.default('corner')` union arrives as the handle rather than a literal.
 * Every read goes through {@link liveValue} instead, which unwraps handles and
 * still accepts plain values (hosts that resolve the config without the
 * volatile wrapper).
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { QuickCommandsSettings, QuickCommandEntry, QuickPopupSize, WorkspaceCommands } from '../shared/contract.js'

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

/** Live handle schemastery wraps around one `volatile()` config field. */
interface VolatileField {
  get(): unknown
}

/**
 * The entry config in its RESOLVED form: schemastery hands every `.volatile()`
 * field to the loader (and so to `apply()`) as a live handle instead of the
 * plain value. This is the schema's real output type.
 */
export interface QuickCommandsLiveSettings {
  workspaces: VolatileField
  popupAnchor: VolatileField
  popupSize: VolatileField
}

/**
 * The entry config as `apply()` receives it: the resolved (live) document, or
 * the plain document in hand-built contexts and hosts that resolve the config
 * without the volatile wrapper. Both load through the same `apply`.
 */
export type QuickCommandsConfig = QuickCommandsSettings | QuickCommandsLiveSettings

/**
 * Entry config schema, and the schema dsh derives the plugin's settings page
 * from. The `z<...>` annotation names the RESOLVED (live-handle) shape on
 * purpose:
 *
 *  - schemastery >= 3.18.3 carries a third `Mode` type parameter, so a
 *    `.volatile()` field's OUTPUT type is `Volatile<T>` (a live `{ get() }`
 *    cell), never `T` — the old `z<QuickCommandsSettings>` annotation stopped
 *    compiling;
 *  - dropping the annotation and letting the type be inferred does not build
 *    either: declaration emit then cannot portably name the inferred type
 *    (TS2742), because `z.array(...)` leaks `@deepseek-ai/cosmokit`'s `Dict`
 *    into the schema type while the program holds two schemastery copies
 *    (this plugin's 3.18.3, and the one `@deepseek-ai/dsh-host-webserver`
 *    resolves — see pnpm-workspace.yaml's minimumReleaseAgeExclude, which pins
 *    the former), and cosmokit itself is not nameable from this package.
 *
 * The annotation is type-only. At runtime all three fields are still declared
 * `volatile()` — that is what makes them writable by the settings plane (its
 * `write()` refuses an entry whose form has no volatile field) and what keeps
 * the auto-generated page working.
 */
export const QuickCommandsSettingsSchema: z<QuickCommandsSettings, QuickCommandsLiveSettings> = z.object({
  // Values are addressed by index (array edits), so the whole array is the
  // volatile handle the settings plane swaps in place.
  workspaces: z.array(WorkspaceCommandsSchema).max(500).volatile(),
  popupAnchor: z.union([z.const('corner'), z.const('button')]).default('corner').volatile(),
  // No default on purpose: a missing popupSize stays ABSENT in the resolved
  // document, so the client can distinguish "never resized" (per-anchor
  // default size) from a user-chosen size. Semantics match the runtime value:
  // never resized resolves to `{}` (schemastery's implicit object default).
  popupSize: z.object({
    width: z.number().min(320).max(8192),
    height: z.number().min(200).max(8192),
  }).volatile(),
})

/**
 * Read a config node that may be a plain value or a live (`.volatile()`) node.
 *
 * A plugin whose Config declares volatile fields receives a reactive config
 * whose fields expose `get()`, while hand-written config objects and tests pass
 * plain values. Both shapes are supported here so the same code path serves the
 * settings page, `cordis.patch.yml`, and the unit tests.
 */
function liveValue<T>(node: unknown, fallback: T): T {
  if (node === undefined || node === null) return fallback
  const getter = (node as { get?: unknown }).get
  if (typeof getter === 'function') {
    const value = (getter as () => unknown).call(node)
    return value === undefined ? fallback : (value as T)
  }
  return node as T
}

/** Structural settings-service subset used for persistence. */
interface SettingsUpdateFace {
  update(ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<unknown>
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

export function registerSettings(ctx: Context, config: QuickCommandsConfig): QuickCommandsSettingsFace {
  const readWorkspaces = (): WorkspaceCommands[] => {
    const value = liveValue<unknown>(config?.workspaces, [])
    return Array.isArray(value) ? value as WorkspaceCommands[] : []
  }
  const readAnchor = (): QuickCommandsSettings['popupAnchor'] =>
    (liveValue<unknown>(config?.popupAnchor, 'corner') === 'button' ? 'button' : 'corner')
  const readPopupSize = (): QuickPopupSize | undefined => {
    const value = liveValue<unknown>(config?.popupSize, undefined)
    if (typeof value !== 'object' || value === null) return undefined
    const { width, height } = value as { width?: unknown; height?: unknown }
    // `{}` (never resized) and any partially written size read as absent.
    if (typeof width !== 'number' || typeof height !== 'number') return undefined
    if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined
    return { width: Math.round(width), height: Math.round(height) }
  }
  /** Current document, rebuilt from the live config fields on every read. */
  const readDocument = (): QuickCommandsSettings => {
    const size = readPopupSize()
    return {
      workspaces: readWorkspaces(),
      popupAnchor: readAnchor(),
      ...(size === undefined ? {} : { popupSize: size }),
    }
  }
  let service: SettingsUpdateFace | undefined

  // Optional settings service: without one the commands still run from the
  // entry config; they just cannot persist edits.
  ctx.inject(['settings'], (sctx) => {
    service = (sctx as unknown as { settings?: SettingsUpdateFace }).settings
  })

  async function persist(patch: Record<string, unknown>): Promise<void> {
    if (service === undefined) {
      throw new Error('@fonlan/dsh-quick-commands: settings service is not available in this profile')
    }
    // The write lands in this entry's config: the settings plane either swaps
    // the volatile handles in place or re-applies the entry — both paths are
    // picked up by the next read, which is why no local mirror is kept here.
    await service.update(QUICK_COMMANDS_NS, patch)
  }

  return {
    get: readDocument,
    commandsOf: (workspaceId) => {
      const set = readWorkspaces().find((w) => w.workspaceId === workspaceId)
      return set === undefined ? [] : set.commands
    },
    setCommands: async (workspaceId, commands) => {
      const next = readWorkspaces().filter((w) => w.workspaceId !== workspaceId)
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
