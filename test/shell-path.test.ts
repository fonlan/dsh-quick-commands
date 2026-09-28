/**
 * Desktop PATH regression tests (node --test, TS transform-types).
 *
 * DSH Desktop launches the host from launchd, so `process.env.PATH` is the
 * minimal system list (`/usr/bin:/bin:/usr/sbin:/sbin`): homebrew,
 * `/usr/local/bin`, nvm and Docker Desktop are invisible, and every
 * toolchain-dependent quick command (`npm run typecheck`,
 * `docker compose up -d`) failed there while the same profile worked in a
 * terminal-launched host. The local backend now prepends the login shell's
 * PATH; these tests pin the parsing/merging rules and the invariant that the
 * inherited PATH is never lost, even when the probe fails.
 *
 * Run: node --experimental-transform-types --test test/shell-path.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PATH_END,
  PATH_START,
  extractShellPath,
  localCommandEnv,
  loginShell,
  mergePaths,
  resolveLoginShellPath,
} from '../src/server/shell-path.ts'

test('the marked span is read even when profile scripts print their own noise', () => {
  const stdout = `nvm: no such file\nWelcome back\n${PATH_START}/opt/homebrew/bin:/usr/local/bin:/usr/bin${PATH_END}\n`
  assert.equal(extractShellPath(stdout), '/opt/homebrew/bin:/usr/local/bin:/usr/bin')
})

test('unmarked or malformed output yields no path', () => {
  assert.equal(extractShellPath(''), '')
  assert.equal(extractShellPath('/opt/homebrew/bin'), '')
  assert.equal(extractShellPath(`${PATH_END}/usr/bin${PATH_START}`), '')
  assert.equal(extractShellPath(undefined), '')
  assert.equal(extractShellPath(Buffer.from(`${PATH_START}/usr/bin${PATH_END}`)), '/usr/bin')
})

test('the login PATH wins and the inherited PATH stays as a fallback', () => {
  assert.equal(
    mergePaths('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin:/usr/sbin:/sbin'),
    '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  )
})

test('empty entries are dropped and duplicates keep their first position', () => {
  assert.equal(mergePaths(':/a::/b:', '/a:/c:'), '/a:/b:/c')
  assert.equal(mergePaths('', '/usr/bin:/bin'), '/usr/bin:/bin')
  assert.equal(mergePaths('/only', undefined), '/only')
})

test('a shell failure keeps the probed path empty instead of throwing', async () => {
  const failing = async () => { throw new Error('spawn ENOENT') }
  assert.equal(await resolveLoginShellPath({ shell: '/nope/zsh', run: failing }), '')
  const noisy = async () => ({ stdout: 'profile error\n' })
  assert.equal(await resolveLoginShellPath({ shell: '/bin/zsh', run: noisy }), '')
  const ok = async () => ({ stdout: `${PATH_START}/opt/homebrew/bin${PATH_END}` })
  assert.equal(await resolveLoginShellPath({ shell: '/bin/zsh', run: ok }), '/opt/homebrew/bin')
  // fish renders $PATH as a space-separated list — unusable for `sh -c` PATH.
  const fish = async () => ({ stdout: `${PATH_START}/opt/homebrew/bin /usr/bin${PATH_END}` })
  assert.equal(await resolveLoginShellPath({ shell: '/usr/local/bin/fish', run: fish }), '')
})

test('no $SHELL means no probe at all', async () => {
  let called = false
  const run = async () => { called = true; return { stdout: '' } }
  assert.equal(await resolveLoginShellPath({ shell: undefined, run, env: {} }), '')
  assert.equal(called, false)
  assert.equal(loginShell({ SHELL: '  ' }), undefined)
  assert.equal(loginShell({ SHELL: '/bin/zsh' }), '/bin/zsh')
})

test('the probe is an interactive login shell and braces ${PATH}', async () => {
  let seen: { file: string; args: string[]; options: { timeout: number } } | undefined
  const run = async (file: string, args: string[], options: { timeout: number }) => {
    seen = { file, args, options }
    return { stdout: `${PATH_START}/usr/bin${PATH_END}` }
  }
  await resolveLoginShellPath({ shell: '/bin/zsh', run, timeoutMs: 1234 })
  assert.equal(seen?.file, '/bin/zsh')
  // -l owns the system PATH, -i is where nvm/fnm install their shims.
  assert.deepEqual(seen?.args.slice(0, 3), ['-i', '-l', '-c'])
  // Unbraced, `$PATH__DSH_QC_PATH_END__` is one identifier and expands to ''.
  assert.ok(seen?.args[3]?.includes('${PATH}'), 'PATH expansion must be braced')
  assert.ok(seen?.args[3]?.startsWith('printf '))
  assert.equal(seen?.options.timeout, 1234)
})

test('a local command env carries the host environment plus the merged PATH', async () => {
  const env = await localCommandEnv({ DSH_WORKSPACE: '/tmp/ws' })
  assert.equal(env.DSH_WORKSPACE, '/tmp/ws')
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'PATH') continue
    assert.equal(env[key], value, `${key} must survive`)
  }
  // Whatever the host PATH was, every one of its entries is still resolvable.
  for (const entry of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    assert.ok(String(env.PATH).split(':').includes(entry), `${entry} kept in PATH`)
  }
})
