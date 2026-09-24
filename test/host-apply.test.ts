/**
 * Host-apply regression tests (node --test, TS transform-types).
 *
 * dsh >= 0.1.7 activates entries asynchronously and only makes a service
 * readable once the providing fiber's own init settled (for the webserver: once
 * it is listening). `apply()` used to resolve `subprocess` and `webServer` with
 * a one-shot `ctx.get()` — a boot window where either answer is `undefined`
 * silently produced a plugin with NO API route. The client's POST then fell
 * through to the /plugins client-modules bundle route, whose handler rejects
 * every non-GET method with 405 — the header menu showed "HTTP 405".
 *
 * The fix defers through `ctx.inject(['subprocess', 'webServer'], ...)`, which
 * runs the body when the services appear. These tests pin that shape, and drive
 * the actually registered route handler end to end (POST → JSON envelope).
 *
 * Run: node --experimental-transform-types --test test/host-apply.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// src/**/*.ts imports its siblings with the emitted `./x.js` specifiers (the
// shape the build produces), which `--experimental-transform-types` does not
// rewrite. This one-line resolver hook retries a failed relative `.js` import
// as `.ts`, so the test runs the real host sources without a prior build.
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      return next(specifier.slice(0, -3) + '.ts', context)
    }
    throw error
  }
}
`)}`,
)

const { apply } = await import('../src/index.ts')
const { QuickCommandsSettingsSchema } = await import('../src/server/settings.ts')

/** The prefix the browser client fetches (`quickApi` in src/client/api.ts). */
const API_PATH = '/plugins/@fonlan/dsh-quick-commands/api'

interface RegisteredRoute {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => Promise<void> | void
}

interface FakeCtx {
  ctx: never
  /** Services requested through ctx.inject, with the deferred bodies. */
  injects: Array<{ deps: unknown; body: (ctx: never) => void }>
  /** Routes registered so far. */
  routes: RegisteredRoute[]
  /** Labels of effects created on the active context. */
  effects: string[]
}

/**
 * A cordis-shaped stub whose `inject` only records the request: nothing runs
 * until the test activates the services, which is exactly the boot window the
 * old code got wrong.
 */
function fakeCtx(): FakeCtx {
  const state: FakeCtx = { ctx: undefined as never, injects: [], routes: [], effects: [] }

  // Boot window: the settings service is live (this entry's declared inject),
  // while subprocess/webServer are not readable yet — ctx.get() answers
  // undefined for both and webServer is not even on the context.
  const boot = {
    inject: (deps: unknown, body: (ctx: never) => void) => {
      state.injects.push({ deps, body })
      return null
    },
    effect: (fn: () => unknown, label?: string) => {
      state.effects.push(String(label))
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
    get: (name: string) => (name === 'settings' ? { update: async () => undefined } : undefined),
    logger: { warn: () => undefined },
  }

  state.ctx = boot as never
  return state
}

/** The context cordis hands the deferred body once both services are active. */
function activatedCtx(state: FakeCtx): never {
  return {
    inject: () => null,
    effect: (fn: () => unknown, label?: string) => {
      state.effects.push(String(label))
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
    get: (name: string) =>
      name === 'subprocess'
        ? { spawn: async () => { throw new Error('not used') } }
        : name === 'settings'
          ? { update: async () => undefined }
          : undefined,
    logger: { warn: () => undefined },
    webServer: {
      register: (route: RegisteredRoute) => {
        state.routes.push(route)
        return () => undefined
      },
    },
  } as never
}

const WORKSPACES = [{ workspaceId: 'w1', commands: [{ name: '测试', command: 'pwd' }] }]

const config = () => QuickCommandsSettingsSchema({ workspaces: WORKSPACES }) as never

/** `registerSettings` also injects (the settings service); pick the web one. */
function webInject(state: FakeCtx): { deps: unknown; body: (ctx: never) => void } {
  const found = state.injects.find((i) => Array.isArray(i.deps) && i.deps.includes('webServer'))
  assert.ok(found, 'apply must wait for the web services through ctx.inject')
  return found
}

/** Minimal IncomingMessage: headers + a body the handler can iterate. */
function fakeRequest(method: string, url: string, body: unknown): unknown {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
}

/** Minimal ServerResponse capturing status, headers and body. */
function fakeResponse(): { res: unknown; read: () => { status: number; headers: Record<string, unknown>; body: string } } {
  const captured = { status: 0, headers: {} as Record<string, unknown>, body: '' }
  const res = {
    writeHead: (status: number, headers?: Record<string, unknown>) => {
      captured.status = status
      captured.headers = headers ?? {}
      return res
    },
    end: (chunk?: unknown) => {
      if (typeof chunk === 'string') captured.body += chunk
    },
  }
  return { res, read: () => captured }
}

test('apply defers on subprocess + webServer instead of a one-shot ctx.get', () => {
  const state = fakeCtx()
  apply(state.ctx, config())

  assert.deepEqual(webInject(state).deps, ['subprocess', 'webServer'])
  // Nothing may be registered while the services are still pending: that is the
  // one-shot lookup whose empty result used to be permanent.
  assert.deepEqual(state.routes, [])
})

test('the API prefix route is registered once the services activate', () => {
  const state = fakeCtx()
  apply(state.ctx, config())

  webInject(state).body(activatedCtx(state))

  assert.equal(state.routes.length, 1)
  assert.equal(state.routes[0].kind, 'prefix')
  assert.equal(state.routes[0].path, API_PATH)
  assert.equal(typeof state.routes[0].handler, 'function')
  assert.ok(
    state.effects.includes('quick-commands: api routes'),
    `route effect must be owned by the active context (got ${state.effects.join(', ')})`,
  )
  assert.ok(state.effects.includes('quick-commands: process cleanup'))
})

test('the registered route answers settings.get with the JSON envelope the client expects', async () => {
  const state = fakeCtx()
  apply(state.ctx, config())
  webInject(state).body(activatedCtx(state))
  const route = state.routes[0]

  const ok = fakeResponse()
  await route.handler(fakeRequest('POST', `${API_PATH}/settings.get`, {}), ok.res)
  assert.equal(ok.read().status, 200)
  assert.equal(ok.read().headers['content-type'], 'application/json; charset=utf-8')
  const parsed = JSON.parse(ok.read().body) as { ok: boolean; value: { workspaces: unknown[] } }
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.value.workspaces, WORKSPACES)

  // The browser client only ever POSTs; a stray GET must be a JSON 405 rather
  // than the opaque empty-body 405 the bundle route used to return.
  const bad = fakeResponse()
  await route.handler(fakeRequest('GET', `${API_PATH}/settings.get`, undefined), bad.res)
  assert.equal(bad.read().status, 405)
  assert.equal(JSON.parse(bad.read().body).error.code, 'method')
})
