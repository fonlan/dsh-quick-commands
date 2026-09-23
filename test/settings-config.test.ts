/**
 * Entry-config regression tests (node --test, TS transform-types).
 *
 * dsh >= 0.1.7 owns plugin settings as entry config and hands every
 * `volatile()` field to `apply()` as a live handle (`{ get() }`) — NOT as the
 * value. Reading the raw field used to wipe the entire document (workspaces
 * came back empty, popupAnchor/size came back as `{}`), so the user's
 * configured quick commands disappeared from the menu.
 *
 * These tests resolve the REAL schema the way the loader does and assert the
 * settings face sees the configured document.
 *
 * Run: node --experimental-transform-types --test test/settings-config.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerSettings, QuickCommandsSettingsSchema } from '../src/server/settings.ts'

/** Minimal cordis context: the settings service is optional for these reads. */
const fakeCtx = (): never => ({ inject: () => () => {} }) as never

/** A profile's declared entry config, as it sits in cordis.patch.yml. */
const PATCH_CONFIG = {
  workspaces: [
    { workspaceId: 'w1', commands: [{ name: '编译安装', command: './build_and_run.sh' }] },
    { workspaceId: 'w2', commands: [{ name: '测试', command: 'pwd' }, { name: '重启', command: 'docker compose up -d' }] },
  ],
  popupAnchor: 'button' as const,
  popupSize: { width: 667, height: 528 },
}

test('configured workspaces survive the volatile handle wrapping', () => {
  const resolved = QuickCommandsSettingsSchema(PATCH_CONFIG)
  const face = registerSettings(fakeCtx(), resolved as never)
  assert.deepEqual(face.get().workspaces, PATCH_CONFIG.workspaces)
  assert.deepEqual(face.commandsOf('w2'), PATCH_CONFIG.workspaces[1].commands)
  assert.deepEqual(face.commandsOf('missing'), [])
})

test('popup preferences survive the volatile handle wrapping', () => {
  const resolved = QuickCommandsSettingsSchema(PATCH_CONFIG)
  const face = registerSettings(fakeCtx(), resolved as never)
  assert.equal(face.get().popupAnchor, 'button')
  assert.deepEqual(face.get().popupSize, { width: 667, height: 528 })
})

test('a never-configured entry resolves to an empty document, not handle objects', () => {
  const resolved = QuickCommandsSettingsSchema({})
  const face = registerSettings(fakeCtx(), resolved as never)
  assert.deepEqual(face.get(), { workspaces: [], popupAnchor: 'corner' })
})

test('a cleared size / anchor still read as usable values', () => {
  const resolved = QuickCommandsSettingsSchema({ workspaces: [], popupSize: {} })
  const face = registerSettings(fakeCtx(), resolved as never)
  assert.equal(face.get().popupAnchor, 'corner')
  assert.equal(face.get().popupSize, undefined)
})

test('plain (handle-less) config values keep working', () => {
  const face = registerSettings(fakeCtx(), PATCH_CONFIG as never)
  const doc = face.get()
  assert.deepEqual(doc.workspaces, PATCH_CONFIG.workspaces)
  assert.equal(doc.popupAnchor, 'button')
  assert.deepEqual(doc.popupSize, { width: 667, height: 528 })
})

test('undefined config is survivable', () => {
  const face = registerSettings(fakeCtx(), undefined as never)
  assert.deepEqual(face.get(), { workspaces: [], popupAnchor: 'corner' })
})
