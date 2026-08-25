/**
 * Fenced JSON API under /plugins/@fonlan/dsh-quick-commands/api/<method>.
 * Same browser-trust fence as task-kanban's /api gateway: loopback Host-header
 * or configured trustedHosts, same-origin browser markers.
 *
 * Methods (POST):
 *   settings.get          → QuickCommandsSettings
 *   settings.setCommands  → { workspaceId, commands } → QuickCommandsSettings
 *   settings.setAnchor    → { anchor } → QuickCommandsSettings
 *   workspaces.list       → QuickRosterEntry[] (DSH workspaces × command sets)
 *   run.start             → { workspaceId, commandName, sessionCwd } → QuickRunView
 *   run.poll              → { runId, stdoutFrom, stderrFrom } → RunPollResult
 *   run.kill              → { runId } → { killed }
 *   run.list              → { workspaceId } → live runs
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { QuickCommandsSettingsFace } from './settings.js'
import type { QuickRunner } from './runner.js'
import type { ApiEnvelope, QuickRosterEntry, QuickRunView } from '../shared/contract.js'

const API_PREFIX = '/plugins/@fonlan/dsh-quick-commands/api'

// ── browser-trust fence (mirrors dsh-client-connection's api-request-trust) ──

function header(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function isTrustedApiRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname) && !trustedHosts.includes(hostUrl.host) && !trustedHosts.includes(hostUrl.hostname)) {
    if (!trustedHosts.some((entry) => entry === hostUrl.hostname || entry === hostUrl.host)) return false
  }
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function trustedHostsOf(ctx: Context): string[] {
  for (const entry of ctx.get('loader')?.entries?.() ?? []) {
    if (entry.options?.name === 'connection') {
      const config = entry.options.config as { trustedHosts?: string[] } | undefined
      return config?.trustedHosts ?? []
    }
  }
  return []
}

// ── wire helpers ────────────────────────────────────────────────────────────

function writeJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function writeError(res: ServerResponse, code: string, message: string, status = 400): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ ok: false, error: { code, message } }))
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} 不能为空`)
  }
  return value
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// ── request dispatch ────────────────────────────────────────────────────────

interface WorkspaceServiceLike {
  get(id: string): { path: string; title: string; id: string } | undefined
  list(): Array<{ path: string; title: string; id: string }>
}

export function registerApiRoutes(ctx: Context, runner: QuickRunner, settings: QuickCommandsSettingsFace): () => void {
  const fence = (req: IncomingMessage): boolean => isTrustedApiRequest(req, trustedHostsOf(ctx))
  const workspaceService = (): WorkspaceServiceLike | undefined =>
    (ctx.get('workspaceRegistry') ?? ctx.get('workspace')) as WorkspaceServiceLike | undefined

  /** Roster: every DSH workspace joined with its command set (for the card). */
  function roster(): QuickRosterEntry[] {
    const svc = workspaceService()
    const config = settings.get()
    const entries: QuickRosterEntry[] = []
    if (svc !== undefined) {
      for (const ws of svc.list()) {
        const set = config.workspaces.find((w) => w.workspaceId === ws.id)
        entries.push({
          workspaceId: ws.id,
          path: ws.path,
          title: ws.title,
          commands: set === undefined ? [] : set.commands,
        })
      }
    } else {
      // Registry unavailable; fall back to configured sets only.
      for (const set of config.workspaces) {
        entries.push({ workspaceId: set.workspaceId, path: '', title: set.workspaceId, commands: set.commands })
      }
    }
    return entries
  }

  async function dispatch(method: string, body: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'settings.get': {
        return settings.get()
      }
      case 'settings.setCommands': {
        const workspaceId = requireString(body.workspaceId, 'workspaceId')
        const commandsRaw = body.commands
        if (!Array.isArray(commandsRaw)) throw new Error('commands must be an array')
        // Empty name/command are allowed: the settings card persists partial
        // rows while the user types (instant save per edit). Runnable
        // validation happens in run.start, not here.
        const commands = commandsRaw.map((entry) => {
          if (typeof entry !== 'object' || entry === null) throw new Error('invalid command entry')
          const e = entry as Record<string, unknown>
          if (typeof e.name !== 'string') throw new Error('command name must be a string')
          if (typeof e.command !== 'string') throw new Error('command body must be a string')
          return { name: e.name, command: e.command }
        })
        await settings.setCommands(workspaceId, commands)
        return settings.get()
      }
      case 'settings.setAnchor': {
        const anchor = body.anchor
        if (anchor !== 'corner' && anchor !== 'button') throw new Error('anchor must be corner or button')
        await settings.setAnchor(anchor)
        return settings.get()
      }
      case 'workspaces.list': {
        return roster()
      }
      case 'run.start': {
        const workspaceId = requireString(body.workspaceId, 'workspaceId')
        const commandName = requireString(body.commandName, 'commandName')
        const sessionCwd = requireString(body.sessionCwd, 'sessionCwd')
        const svc = workspaceService()
        const ws = svc?.get(workspaceId)
        if (ws === undefined) {
          throw { code: 'workspace-not-found', message: `workspace ${workspaceId} is not registered`, status: 404 }
        }
        const entry = settings.commandsOf(workspaceId).find((c) => c.name === commandName)
        if (entry === undefined) {
          throw { code: 'command-not-found', message: `command ${commandName} is not configured for this workspace`, status: 404 }
        }
        if (entry.name.trim() === '' || entry.command.trim() === '') {
          throw { code: 'command-empty', message: `command ${commandName} has an empty name or body`, status: 400 }
        }
        const result = runner.start({
          workspaceId,
          workspacePath: ws.path,
          workspaceTitle: ws.title,
          commandName: entry.name,
          command: entry.command,
          sessionCwd,
          popupAnchor: settings.get().popupAnchor,
        })
        if (!result.ok) {
          throw { code: 'run-busy', message: result.error, status: 409 }
        }
        const view = runner.poll(result.runId, 0, 0)
        if (view === null) throw { code: 'internal', message: 'run not found after start', status: 500 }
        const value: QuickRunView = {
          runId: result.runId,
          workspaceId,
          commandName: entry.name,
          resolvedCommand: entry.command,
          status: view.status,
          exitCode: view.exitCode,
          signal: view.signal,
          startedAt: Date.now(),
          stdoutEnd: view.stdoutEnd,
          stderrEnd: view.stderrEnd,
          stdoutDelta: view.stdoutDelta,
          stderrDelta: view.stderrDelta,
          stdoutLossy: view.stdoutLossy,
          stderrLossy: view.stderrLossy,
        }
        return value
      }
      case 'run.poll': {
        const runId = requireString(body.runId, 'runId')
        const stdoutFrom = typeof body.stdoutFrom === 'number' ? body.stdoutFrom : 0
        const stderrFrom = typeof body.stderrFrom === 'number' ? body.stderrFrom : 0
        const view = runner.poll(runId, stdoutFrom, stderrFrom)
        if (view === null) throw { code: 'run-not-found', message: 'run not found (expired or unknown)', status: 404 }
        return view
      }
      case 'run.kill': {
        const runId = requireString(body.runId, 'runId')
        const result = runner.kill(runId)
        if (result === 'not-found') throw { code: 'run-not-found', message: 'run not found', status: 404 }
        return { killed: result === 'ok' }
      }
      case 'run.list': {
        const workspaceId = requireString(body.workspaceId, 'workspaceId')
        return runner.forWorkspace(workspaceId)
      }
      default:
        throw { code: 'method-not-found', message: `unknown method ${method}`, status: 404 }
    }
  }

  const webServer = ctx.get('webServer')
  if (webServer === undefined) return () => undefined
  return ctx.effect(() => {
    return webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!fence(req)) {
          writeError(res, 'forbidden', 'forbidden', 403)
          return
        }
        if (req.method !== 'POST') {
          writeError(res, 'method', 'method not allowed', 405)
          return
        }
        const url = new URL(req.url ?? '', 'http://placeholder')
        const method = url.pathname.slice(API_PREFIX.length + 1)
        const payload = await readJsonBody(req)
        try {
          const value = await dispatch(method, payload)
          writeJson(res, { ok: true, value })
        } catch (error) {
          const e = error as { code?: string; message?: string; status?: number }
          writeError(res, e.code ?? 'error', e.message ?? String(error), e.status ?? 400)
        }
      },
    })
  }, 'quick-commands: api routes')
}
