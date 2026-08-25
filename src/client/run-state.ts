/**
 * HMR-safe shared run state for the quick-commands header button and output
 * popup. Module-level fields live on one globalThis-backed record keyed with
 * Symbol.for so every client-bundle copy (client-hmr hot swap re-evaluates the
 * bundle without reloading the page) reads/writes the same state cell.
 *
 * The popup handles ONE run at a time (serial per workspace by design); a
 * second workspace can run in parallel with its own popup, so the store keys
 * popups by runId.
 */
import { useSyncExternalStore } from 'react'

const STATE_KEY = Symbol.for('@fonlan/dsh-quick-commands/run-state')

/** One popup slot: menu open flag + the live run the popup streams. */
export interface RunPopoverState {
  /** Whether the header command menu is open. */
  menuOpen: boolean
  /** Active run id (undefined when no run is open). */
  runId: string | null
  /** Workspace id owning the active run (for kill/cwd display). */
  workspaceId: string | null
  /** Command display name. */
  commandName: string | null
  /** SSH host id when the run executes on a remote workspace (else null). */
  remoteHost: string | null
  /** Whether the run popup should stream (false while minimized). */
  streaming: boolean
}

interface RunPopoverStateInternal extends RunPopoverState {
  listeners: Set<() => void>
}

interface QuickCommandsState {
  popover: RunPopoverStateInternal
  /** Cached published snapshot — STABLE reference; rebuilt only after a patch. */
  snapshot: RunPopoverState | null
}

function getState(): QuickCommandsState {
  const g = globalThis as unknown as Record<symbol, QuickCommandsState | undefined>
  let state = g[STATE_KEY]
  if (state === undefined) {
    state = {
      popover: {
        menuOpen: false,
        runId: null,
        workspaceId: null,
        commandName: null,
        remoteHost: null,
        streaming: true,
        listeners: new Set(),
      },
      // Seed the cache with values our equality check will see as unchanged.
      snapshot: {
        menuOpen: false,
        runId: null,
        workspaceId: null,
        commandName: null,
        remoteHost: null,
        streaming: true,
      },
    }
    g[STATE_KEY] = state
  }
  return state
}

function notify(): void {
  // Invalidate the cached snapshot FIRST: useSyncExternalStore reads
  // getSnapshot after notification, so a new stable object must be ready.
  getState().snapshot = null
  for (const listener of getState().popover.listeners) listener()
}

function subscribe(cb: () => void): () => void {
  const listeners = getState().popover.listeners
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/**
 * getSnapshot for useSyncExternalStore. MUST return a stable reference while
 * the underlying fields are unchanged (React compares with Object.is) — return
 * the CACHED object; only rebuild it when a patch invalidated it.
 */
function snapshot(): RunPopoverState {
  const state = getState()
  if (state.snapshot !== null) return state.snapshot
  const p = state.popover
  state.snapshot = {
    menuOpen: p.menuOpen,
    runId: p.runId,
    workspaceId: p.workspaceId,
    commandName: p.commandName,
    remoteHost: p.remoteHost,
    streaming: p.streaming,
  }
  return state.snapshot
}

function patch(partial: Partial<RunPopoverState>): void {
  const state = getState()
  Object.assign(state.popover, partial)
  // Invalidate the cached snapshot so equality flips exactly on real changes.
  state.snapshot = null
  notify()
}

export function useRunPopover(): RunPopoverState {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function openMenu(): void { patch({ menuOpen: true }) }
export function closeMenu(): void { patch({ menuOpen: false }) }
export function toggleMenu(open: boolean): void { patch({ menuOpen: open }) }

export function openRun(runId: string, workspaceId: string, commandName: string, remoteHost?: string): void {
  patch({ runId, workspaceId, commandName, remoteHost: remoteHost ?? null, menuOpen: false, streaming: true })
}

export function closeRun(): void {
  patch({ runId: null, workspaceId: null, commandName: null, remoteHost: null, streaming: false })
}
