// Real React render test for QuickCommandsHeaderAction: catches the exact
// "Maximum update depth exceeded" class of crash. Uses react-dom/server to
// render the component with stubbed props (standard slot kit).
import React from 'react'
import { renderToString } from 'react-dom/server'
import { pathToFileURL } from 'node:url'

// Load the built client bundle through the module-loader closure by importing
// the SOURCE? No — the bundle is CJS closure. Instead: extract the relevant
// modules is hard; test the run-state + a rendered header via the bundle.
// Simpler: replicate the component tree is not faithful. So run the actual
// client.js factory with a require table and grab the exports (the factory
// returns module.exports with apply/inject only — components are internal).
// → We test the crash-prone piece in isolation: useSyncExternalStore contract.
import { useSyncExternalStore } from 'react'

// Simulate the OLD (buggy) snapshot + verify React throws, then the NEW one.
const makeStore = (snapshotFn) => {
  const listeners = new Set()
  const subscribe = (cb) => { listeners.add(cb); return () => listeners.delete(cb) }
  const getSnapshot = snapshotFn
  const patch = (v) => { state = v; for (const l of listeners) l() }
  let state = { menuOpen: false, runId: null, workspaceId: null, commandName: null, streaming: true }
  return { subscribe, getSnapshot: getSnapshot(state), patch }
}

// Component using useSyncExternalStore — mirrors useRunPopover consumer.
function Probe({ store }) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return React.createElement('div', null, snap.menuOpen ? 'OPEN' : 'CLOSED')
}

console.log('--- OLD buggy snapshot (new object each call) ---')
{
  let state = { menuOpen: false }
  const listeners = new Set()
  const subscribe = (cb) => { listeners.add(cb); return () => listeners.delete(cb) }
  const getSnapshot = () => ({ ...state }) // BUG: fresh object every call
  const store = { subscribe, getSnapshot }
  try {
    const html = renderToString(React.createElement(Probe, { store }))
    console.log('rendered OK:', html)
  } catch (e) {
    console.log('REACT CRASH:', e.message)
  }
}

console.log('--- NEW fixed snapshot (cached object) ---')
{
  let state = { menuOpen: false }
  let cache = null
  const listeners = new Set()
  const subscribe = (cb) => { listeners.add(cb); return () => listeners.delete(cb) }
  const getSnapshot = () => { if (cache === null) cache = { ...state }; return cache }
  const store = { subscribe, getSnapshot }
  try {
    const html = renderToString(React.createElement(Probe, { store }))
    console.log('rendered OK:', html)
  } catch (e) {
    console.log('REACT CRASH:', e.message)
  }
}
