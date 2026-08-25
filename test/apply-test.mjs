// Runs the BUILT client bundle's factory and apply(ctx) with a faithful ctx stub.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const bundleSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (spec) => { captured = spec; } } },
  console,
}
vm.runInNewContext(bundleSrc, sandbox, { filename: 'client.js' })
const factory = captured.factory

const reactMod = await import('react')
const jsxRuntime = await import('react/jsx-runtime')
const modules = {
  'react': reactMod,
  'react/jsx-runtime': jsxRuntime,
  'react-dom': reactMod,
  'react-dom/client': {},
  'cordis': { Context: class {} },
  '@deepseek-ai/dsh-client-ui-slots': {},
  '@deepseek-ai/dsh-client-web-react': {},
  '@deepseek-ai/dsh-client-ui-primitives': {},
  '@deepseek-ai/dsh-client-schema-form': {},
  '@deepseek-ai/dsh-client-runtime/client': {},
}
const requireFn = (name) => {
  if (modules[name]) return modules[name]
  throw new Error('missing external: ' + name)
}
try {
  const exports = factory(requireFn)
  console.log('exports:', Object.keys(exports).join(','))
  console.log('inject:', JSON.stringify(exports.inject))
  const apply = exports.apply

  const registrations = []
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: {
      register: (ns, dicts) => { console.log('locale.register', ns, Object.keys(dicts)); return () => {} },
      bind: (ns) => (key) => key,
    },
    slots: {
      register: (opts) => { console.log("  register:", opts.name, opts.id ?? opts.key); return () => {} },
      inject: (name, cb) => {
        console.log('slots.inject:', name)
        const reg = cb()
        console.log('  register:', typeof reg)
        registrations.push({ name })
        return () => {}
      },
    },
  }
  try {
    apply(ctx)
    console.log('APPLY OK — registrations: ' + registrations.map((r) => r.name).join(', '))
  } catch (e) {
    console.log('APPLY CRASH:', e.message)
  }
} catch (e) {
  console.log('FACTORY/LOAD CRASH:', e.message)
}
