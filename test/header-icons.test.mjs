/**
 * Regression test: icon-export drift in @deepseek-ai/dsh-client-ui-primitives.
 *
 * DSH 0.1.7 renamed the primitives icon exports from size-suffixed names
 * (`IconPlayOutline16`) to role-suffixed ones (`IconPlayOutlineRegular` /
 * `IconPlayOutlineMedium`). A client bundle that statically imports a name the
 * running DSH no longer exports receives `undefined`; rendering that element
 * throws, and the slot's per-entry error boundary swallows the entire entry —
 * which is how the header ▶ button silently disappeared on 0.1.7.
 *
 * This renders the BUILT client bundle's registered surfaces against three
 * primitives shapes:
 *   1. 0.1.7-only  (new names)  → must render, using the new names
 *   2. legacy-only (old names)  → must render, using the old names
 *   3. neither                  → must still render (bundled SVG fallback)
 *
 * Run: node test/header-icons.test.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const bundlePath = new URL('../lib/client.js', import.meta.url)
const bundleSrc = readFileSync(bundlePath, 'utf8')

const jsxRuntime = await import('react/jsx-runtime')

/** Icon names the running DSH may export, per naming scheme. */
const NEW_NAMES = {
  IconPlayOutlineRegular: 'play',
  IconCloseOutlineRegular: 'close',
  IconStopFillRegular: 'stop',
  IconPlusOutlineRegular: 'plus',
  IconTrashOutlineRegular: 'trash',
}
const LEGACY_NAMES = {
  IconPlayOutline16: 'play',
  IconCloseOutline16: 'close',
  IconStopFill16: 'stop',
  IconPlusOutline16: 'plus',
  IconTrashOutline16: 'trash',
}

/** One stub icon that records which export name actually resolved. */
function stubIcon(name, kind) {
  return function StubIcon(props) {
    return React.createElement('svg', {
      'data-icon': name,
      'data-kind': kind,
      width: props.size,
      height: props.size,
    })
  }
}

function primitivesFor(names, kind) {
  const table = {}
  for (const name of Object.keys(names)) table[name] = stubIcon(name, kind)
  return table
}

/** Load the built bundle and return its factory. */
function loadFactory() {
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { captured = spec } } },
    console,
  }
  vm.runInNewContext(bundleSrc, sandbox, { filename: 'client.js' })
  if (captured === null) throw new Error('bundle did not register via window.__ModuleLoader__.load')
  return captured.factory
}

const reactDom = await import('react-dom')

/**
 * Seed the settings page's roster state. Its rows (and therefore the plus /
 * trash icons) only exist after an async load, and a server render never runs
 * effects — so the first `useState` call returns a loaded roster instead.
 */
const SEEDED_ROSTER = {
  loaded: true,
  anchor: 'corner',
  entries: [{
    workspaceId: 'w1',
    path: '/tmp/qc-ws',
    title: 'ws',
    commands: [{ name: 'build', command: 'npm run build' }],
  }],
}

/** React module whose first useState call yields `seed` (all else delegates). */
function seededReact(seed) {
  let seeded = false
  return {
    ...React,
    useState(initial) {
      if (!seeded) {
        seeded = true
        // Register a real hook (keeps the hook list consistent) but hand the
        // component the seeded value: a server render never runs the loader.
        const [, setValue] = React.useState(seed)
        return [seed, setValue]
      }
      return React.useState(initial)
    },
  }
}

/** Instantiate the bundle with one primitives shape and capture both surfaces. */
function instantiate(primitives, seed) {
  const modules = {
    'react': seed === undefined ? React : seededReact(seed),
    'react/jsx-runtime': jsxRuntime,
    'react-dom': reactDom,
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
  }
  const requireFn = (name) => {
    if (name in modules) return modules[name]
    throw new Error('missing external: ' + name)
  }
  const exports = loadFactory()(requireFn)
  const captured = {}
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      register: (def, component) => { captured[def.name] = component; return () => {} },
      inject: (name, cb) => { cb(); return () => {} },
    },
  }
  exports.apply(ctx)
  if (captured['conversation.session.header.utilities'] === undefined) {
    throw new Error('header utilities entry was never registered')
  }
  if (captured['settings.section'] === undefined) {
    throw new Error('settings section entry was never registered')
  }
  return captured
}

/** Props standing in for the standard root/session kit the slot hands down. */
const HEADER_PROPS = {
  sessionId: 's1',
  t: (key) => key,
  useSessions: (selector) => selector({ byId: { s1: { id: 's1', cwd: '/tmp/qc-ws' } }, current: 's1' }),
  useWorkspaces: (selector) => selector({
    phase: 'ready',
    items: [{ workspaceId: 'w1', path: '/tmp/qc-ws', title: 'ws', sessionIds: ['s1'] }],
  }),
}

const failures = []

function check(label, fn) {
  try {
    fn()
    console.log(`  PASS  ${label}`)
  } catch (e) {
    failures.push(`${label}: ${e.message}`)
    console.log(`  FAIL  ${label}\n        ${e.message}`)
  }
}

function renderSurface(primitives, slotName, props, seed) {
  const captured = instantiate(primitives, seed)
  return renderToStaticMarkup(React.createElement(captured[slotName], props))
}

console.log('header utilities entry:')
check('0.1.7 icon names → renders the ▶ button', () => {
  const html = renderSurface(primitivesFor(NEW_NAMES, 'new'), 'conversation.session.header.utilities', HEADER_PROPS)
  if (!html.includes('<button')) throw new Error('no button in output: ' + html.slice(0, 200))
  if (!html.includes('data-icon="IconPlayOutlineRegular"')) {
    throw new Error('play icon did not resolve to the 0.1.7 export: ' + html.slice(0, 300))
  }
})

check('legacy icon names → still renders the ▶ button', () => {
  const html = renderSurface(primitivesFor(LEGACY_NAMES, 'legacy'), 'conversation.session.header.utilities', HEADER_PROPS)
  if (!html.includes('<button')) throw new Error('no button in output: ' + html.slice(0, 200))
  if (!html.includes('data-icon="IconPlayOutline16"')) {
    throw new Error('play icon did not resolve to the legacy export: ' + html.slice(0, 300))
  }
})

check('neither export present → renders the bundled fallback', () => {
  const html = renderSurface({}, 'conversation.session.header.utilities', HEADER_PROPS)
  if (!html.includes('<button')) throw new Error('no button in output: ' + html.slice(0, 200))
  if (!html.includes('<svg')) throw new Error('no fallback icon rendered: ' + html.slice(0, 300))
})

console.log('settings section entry:')
check('0.1.7 icon names → renders the settings rows', () => {
  const html = renderSurface(primitivesFor(NEW_NAMES, 'new'), 'settings.section', { t: (key) => key }, SEEDED_ROSTER)
  if (!html.includes('data-icon="IconPlusOutlineRegular"')) {
    throw new Error('plus icon did not resolve to the 0.1.7 export: ' + html.slice(-400))
  }
  if (!html.includes('data-icon="IconTrashOutlineRegular"')) {
    throw new Error('trash icon did not resolve to the 0.1.7 export: ' + html.slice(-400))
  }
})

check('legacy icon names → still renders the settings rows', () => {
  const html = renderSurface(primitivesFor(LEGACY_NAMES, 'legacy'), 'settings.section', { t: (key) => key }, SEEDED_ROSTER)
  if (!html.includes('data-icon="IconPlusOutline16"') || !html.includes('data-icon="IconTrashOutline16"')) {
    throw new Error('plus/trash did not resolve to the legacy exports: ' + html.slice(-400))
  }
})

check('neither export present → renders the bundled fallback', () => {
  const html = renderSurface({}, 'settings.section', { t: (key) => key }, SEEDED_ROSTER)
  if (!html.includes('qc-settings-add-btn') || !html.includes('<svg')) {
    throw new Error('no fallback icon rendered: ' + html.slice(-400))
  }
})

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall icon-compatibility checks passed')
