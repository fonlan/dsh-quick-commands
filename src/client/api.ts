/**
 * Browser client for the plugin's fenced JSON API
 * (/plugins/@fonlan/dsh-quick-commands/api/<method>). Same-origin fetch with
 * the task-kanban envelope shape: { ok, value } | { ok:false, error }.
 */
import type {
  ApiEnvelope,
  QuickCommandsSettings,
  QuickRosterEntry,
  QuickRunView,
} from '../shared/contract'

export class QuickCommandsApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

async function call<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/plugins/@fonlan/dsh-quick-commands/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new QuickCommandsApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed = (await response.json().catch(() => null)) as ApiEnvelope<T> | null
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new QuickCommandsApiError(
      (parsed?.error?.code as string | undefined) ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

/** Current session cwd of a session row (SessionSummary carries cwd). */
export interface SessionRow {
  id: string
  cwd?: string
}

/** One delta read result (mirrors the host RunPollResult). */
export interface RunPoll {
  status: 'running' | 'exited'
  exitCode: number | null
  signal: string | null
  stdoutEnd: number
  stderrEnd: number
  stdoutDelta: string
  stderrDelta: string
  stdoutLossy: boolean
  stderrLossy: boolean
}

export const quickApi = {
  settingsGet: () => call<QuickCommandsSettings>('settings.get'),
  settingsSetCommands: (workspaceId: string, commands: Array<{ name: string; command: string }>) =>
    call<QuickCommandsSettings>('settings.setCommands', { workspaceId, commands }),
  settingsSetAnchor: (anchor: QuickCommandsSettings['popupAnchor']) =>
    call<QuickCommandsSettings>('settings.setAnchor', { anchor }),
  workspacesList: () => call<QuickRosterEntry[]>('workspaces.list'),
  runStart: (workspaceId: string, commandName: string, sessionCwd: string) =>
    call<QuickRunView>('run.start', { workspaceId, commandName, sessionCwd }),
  runPoll: (runId: string, stdoutFrom: number, stderrFrom: number) =>
    call<RunPoll>('run.poll', { runId, stdoutFrom, stderrFrom }),
  runKill: (runId: string) => call<{ killed: boolean }>('run.kill', { runId }),
  runList: (workspaceId: string) =>
    call<Array<{ runId: string; commandName: string; startedAt: number; status: 'running' | 'exited' }>>('run.list', { workspaceId }),
}
