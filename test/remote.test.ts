/**
 * Remote-execution unit tests (node --test, TS strip-types).
 * Covers the pure placeholder-path detection, host-config reading, cwd
 * re-anchoring, and the RemoteStreamExecutor stream/kill semantics.
 *
 * Run: node --experimental-strip-types --test test/remote.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  localPathToRemoteRef,
  resolveRemoteCwd,
  remoteRoot,
  readHostConfig,
  RemoteStreamExecutor,
  type SshConnLike,
  type RemoteExecEvent,
} from '../src/server/remote.ts'

const ENV = { DSH_SSH_REMOTE_ROOT: '/tmp/dsh-remote' }

function placeholderFor(root: string, hostId: string, remotePath: string): string {
  const enc = Buffer.from(remotePath, 'utf8').toString('base64url')
  return path.join(root, hostId, enc)
}

test('localPathToRemoteRef decodes a placeholder into hostId + remote path', () => {
  const local = placeholderFor('/tmp/dsh-remote', 'host-abc', '/home/ubuntu/proj')
  const ref = localPathToRemoteRef(local, ENV)
  assert.deepEqual(ref, { hostId: 'host-abc', remotePath: '/home/ubuntu/proj' })
})

test('localPathToRemoteRef rejects non-placeholder paths', () => {
  assert.equal(localPathToRemoteRef('/home/ubuntu/proj', ENV), null)
  assert.equal(localPathToRemoteRef('/tmp/dsh-remote/only-one-segment', ENV), null)
  assert.equal(localPathToRemoteRef('/tmp/dsh-remote/host/enc/extra', ENV), null)
})

test('localPathToRemoteRef rejects invalid host ids and non-canonical encodings', () => {
  // hostId with a slash can never be a single path segment
  const evil = path.join('/tmp/dsh-remote', '..', '..', 'etc', Buffer.from('/etc/passwd', 'utf8').toString('base64url'))
  assert.equal(localPathToRemoteRef(evil, ENV), null)
  // encoded segment that decodes to a RELATIVE path is rejected
  const rel = path.join('/tmp/dsh-remote', 'host', Buffer.from('relative/path', 'utf8').toString('base64url'))
  assert.equal(localPathToRemoteRef(rel, ENV), null)
})

test('resolveRemoteCwd re-anchors only paths inside the placeholder', () => {
  const wsLocal = placeholderFor('/tmp/dsh-remote', 'host', '/srv/proj')
  // same path → workspace remote root
  assert.equal(resolveRemoteCwd(wsLocal, wsLocal, '/srv/proj'), '/srv/proj')
  // subdirectory inside the placeholder → remote subdir
  const sub = path.join(wsLocal, 'app', 'src')
  assert.equal(resolveRemoteCwd(sub, wsLocal, '/srv/proj'), '/srv/proj/app/src')
  // unrelated absolute path → falls back to the workspace remote root
  assert.equal(resolveRemoteCwd('/somewhere/else', wsLocal, '/srv/proj'), '/srv/proj')
})

test('remoteRoot honours DSH_SSH_REMOTE_ROOT then DSH_HOME then home', () => {
  assert.equal(remoteRoot({ DSH_SSH_REMOTE_ROOT: '/x' } as NodeJS.ProcessEnv), path.resolve('/x'))
  assert.equal(remoteRoot({ DSH_HOME: '/dsh' } as NodeJS.ProcessEnv), path.join('/dsh', 'remote'))
})

test('readHostConfig resolves host configs from the dsh-ssh-hosts doc', () => {
  const docs = {
    'dsh-ssh-hosts': {
      hosts: {
        h1: { id: 'h1', host: '192.168.0.2', user: 'root', auth: { type: 'key', privateKeyPath: '~/.ssh/id' } },
      },
    },
  }
  const get = (ns: string): unknown => docs[ns as keyof typeof docs]
  const cfg = readHostConfig(get, 'h1')
  assert.equal(cfg?.id, 'h1')
  assert.equal(cfg?.host, '192.168.0.2')
  assert.equal(readHostConfig(get, 'missing'), undefined)
  assert.equal(readHostConfig(() => { throw new Error('boom') }, 'h1'), undefined)
})

// ── RemoteStreamExecutor semantics ──────────────────────────────────────────

function stubConn(events: RemoteExecEvent[], opts: { fail?: boolean } = {}): SshConnLike & { killed: string[]; streamed: string[] } {
  const called: string[] = []
  const streamed: string[] = []
  return {
    killed: called,
    streamed,
    async *execStream(cmd: string): AsyncGenerator<RemoteExecEvent> {
      streamed.push(cmd)
      if (opts.fail) throw new Error('connection lost')
      for (const e of events) yield e
    },
    async exec(cmd: string): Promise<{ code: number; signal: string | null; stdout: string; stderr: string }> {
      called.push(cmd)
      return { code: 0, signal: null, stdout: '', stderr: '' }
    },
  } as SshConnLike & { killed: string[]; streamed: string[] }
}

test('RemoteStreamExecutor streams chunks and settles with the exit code', async () => {
  const conn = stubConn([
    { stream: 'stderr', chunk: Buffer.from('__QC_PID__ 4242\n') },
    { stream: 'stdout', chunk: Buffer.from('hello\n') },
    { stream: 'stderr', chunk: Buffer.from('warn\n') },
    { exitCode: 3 },
  ])
  const pool = { acquire: async () => conn, release: () => {} }
  const exec = new RemoteStreamExecutor(conn, pool as never)

  const data: string[] = []
  let exit: { exitCode: number | null; signal: string | null; error?: string } | null = null
  await exec.start('echo hi', '/srv/proj', (stream, text) => data.push(stream + ':' + text), (e) => { exit = e })
  // marker line is filtered; the rest is visible
  assert.deepEqual(data, ['stdout:hello\n', 'stderr:warn\n'])
  assert.deepEqual(exit, { exitCode: 3, signal: null })
  assert.equal(exec.pid, 4242)
  // the channel command carries the marker probe + cd + subshell
  assert.match(conn.streamed[0] ?? '', /echo __QC_PID__ \$\$ >&2; cd '\/srv\/proj' && \( echo hi \)/)
})

test('RemoteStreamExecutor handles a chunk-cut marker line', async () => {
  const conn = stubConn([
    { stream: 'stderr', chunk: Buffer.from('__QC_') },
    { stream: 'stderr', chunk: Buffer.from('PID__ 777\n') },
    { stream: 'stdout', chunk: Buffer.from('ok\n') },
    { exitCode: 0 },
  ])
  const pool = { acquire: async () => conn, release: () => {} }
  const exec = new RemoteStreamExecutor(conn, pool as never)
  const data: string[] = []
  let exit: { exitCode: number | null; signal: string | null; error?: string } | null = null
  await exec.start('true', '/x', (stream, text) => data.push(stream + ':' + text), (e) => { exit = e })
  assert.deepEqual(data, ['stdout:ok\n'])
  assert.equal(exec.pid, 777)
})

test('RemoteStreamExecutor routes a non-marker first line to stderr', async () => {
  const conn = stubConn([
    { stream: 'stderr', chunk: Buffer.from('plain\n') },
    { exitCode: 1 },
  ])
  const pool = { acquire: async () => conn, release: () => {} }
  const exec = new RemoteStreamExecutor(conn, pool as never)
  const data: string[] = []
  let exit: { exitCode: number | null; signal: string | null; error?: string } | null = null
  await exec.start('false', '/x', (stream, text) => data.push(stream + ':' + text), (e) => { exit = e })
  assert.deepEqual(data, ['stderr:plain\n'])
  assert.equal(exec.pid, null)
})

test('RemoteStreamExecutor reports connection failure through onExit', async () => {
  const conn = stubConn([], { fail: true })
  const pool = { acquire: async () => conn, release: () => {} }
  const exec = new RemoteStreamExecutor(conn, pool as never)
  let exit: { exitCode: number | null; signal: string | null; error?: string } | null = null
  await exec.start('true', '/srv/proj', () => {}, (e) => { exit = e })
  assert.equal(exit?.exitCode, null)
  assert.match(exit?.error ?? '', /connection lost/)
})

test('RemoteStreamExecutor.kill uses the probed group leader pid', async () => {
  const conn = stubConn([
    { stream: 'stderr', chunk: Buffer.from('__QC_PID__ 5150\n') },
  ], { fail: false })
  const pool = { acquire: async () => conn, release: () => {} }
  const exec = new RemoteStreamExecutor(conn, pool as never)
  const start = exec.start('npm run build', '/srv/proj', () => {}, () => {})
  await new Promise((r) => setTimeout(r, 30)) // let the probe land
  await exec.kill()
  await start
  assert.equal(conn.killed.length, 1)
  assert.match(conn.killed[0] ?? '', /^kill -TERM -- -5150 /)
})

test('RemoteStreamExecutor.kill falls back to pkill before the probe arrives', async () => {
  const conn = stubConn([]) // no marker event: pid stays null
  const pool = { acquire: async () => conn, release: () => {} }
  const exec = new RemoteStreamExecutor(conn, pool as never)
  const start = exec.start('npm run build', '/srv/proj', () => {}, () => {})
  await exec.kill()
  await start
  assert.equal(conn.killed.length, 1)
  assert.match(conn.killed[0] ?? '', /^pkill -TERM -f '/)
})
