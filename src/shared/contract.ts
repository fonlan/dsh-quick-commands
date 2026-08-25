/**
 * Shared wire contracts for @fonlan/dsh-quick-commands.
 *
 * Browser-safe: no host-only imports live here. The client bundle imports
 * these shapes (type-only + runtime constants), so anything that must cross
 * the fenced JSON API keeps its plain-Object shape here.
 */

/** One configured quick command inside a workspace. */
export interface QuickCommandEntry {
  /** Human-facing command name (unique within the workspace). */
  name: string
  /** Shell command line, executed through bash -c / pwsh -c. */
  command: string
}

/** Config slice bound to one workspace (keyed by workspaceId). */
export interface WorkspaceCommands {
  /** DSH workspace registry id this command set belongs to. */
  workspaceId: string
  /** Ordered command entries. */
  commands: QuickCommandEntry[]
}

/** Full user-facing plugin settings document (settings namespace value). */
export interface QuickCommandsSettings {
  /** Command sets; a workspace may be absent (no commands configured). */
  workspaces: WorkspaceCommands[]
  /** Output popup anchor preference: fixed bottom-right or anchored at the button. */
  popupAnchor: 'corner' | 'button'
}

/** Placeholder substitution values resolved for one execution. */
export interface QuickRunPlaceholders {
  /** Workspace root path (also the execution cwd). */
  workspace: string
  /** Session actual cwd (may be a subdirectory of the workspace). */
  cwd: string
  /** Workspace display title. */
  title: string
}

/** One live run view returned by `run.start`. */
export interface QuickRunView {
  runId: string
  workspaceId: string
  commandName: string
  /** Command line after placeholder substitution (display only). */
  resolvedCommand: string
  status: 'running' | 'exited'
  exitCode: number | null
  signal: string | null
  startedAt: number
  /** Total stdout bytes captured so far (offset currency). */
  stdoutEnd: number
  /** Total stderr bytes captured so far (offset currency). */
  stderrEnd: number
  /** stdout tail appended since `stdoutFrom` (whole tail when lossy). */
  stdoutDelta: string
  /** stderr tail appended since `stderrFrom` (whole tail when lossy). */
  stderrDelta: string
  /** True when the in-memory tail lost its head for this stream. */
  stdoutLossy: boolean
  stderrLossy: boolean
}

/** API response envelope (mirrors task-kanban's fenced fetch wrapper). */
export interface ApiEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

/** Settings card view: command sets plus the workspace roster for display. */
export interface QuickRosterEntry {
  workspaceId: string
  path: string
  title: string
  commands: QuickCommandEntry[]
}
