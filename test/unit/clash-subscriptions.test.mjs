import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ClashSubscriptions,
  parseClash,
  isPublicAddress,
  downloadClash,
} from '../../src/lib/vm/clash-subscriptions.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

const yaml = (names = ['one', 'two']) =>
  JSON.stringify({
    proxies: names.map((name) => ({
      name,
      type: 'ss',
      server: 'example.com',
      port: 443,
      cipher: 'aes-128-gcm',
      password: 'fixture-only',
    })),
    rules: ['MATCH,DIRECT'],
    'external-controller': '0.0.0.0:9999',
  })
function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-clash-test-'))
  const pool = new ProxyPool({ dataDir })
  const calls = []
  const manager = new ClashSubscriptions({
    dataDir,
    proxyPool: pool,
    controller: 'http://127.0.0.1:19090',
    secret: 'test-only',
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(JSON.parse(options.body).payload))
      return { ok: true }
    },
    ...options,
  })
  t.after(() => pool.stopScheduler())
  return { dataDir, pool, manager, calls }
}

test('parses nodes only; rejects aliases, duplicates, unsafe options and provider-only input', () => {
  assert.equal(parseClash(yaml()).proxies.length, 2)
  const unknown = JSON.parse(yaml(['one']))
  unknown.proxies.push({ name: 'direct', type: 'direct' })
  assert.equal(parseClash(JSON.stringify(unknown)).skipped.length, 1)
  for (const text of [
    'proxies: [',
    'proxy-providers: {}',
    yaml(['same', 'same']),
    'proxies:\n- &a {name: one, type: ss, server: a, port: 80, nested: *a}',
    JSON.stringify({
      proxies: [{ name: 'bad', type: 'ssh', server: 'a', port: 22, 'private-key-path': '/etc/passwd' }],
    }),
  ]) {
    assert.throws(() => parseClash(text))
  }
  assert.throws(() => parseClash('x'.repeat(2 * 1024 * 1024 + 1)), /2 MiB/)
})

test('SSRF protection rejects literal private and unusual addresses', async () => {
  for (const addr of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    '2001:db8::1',
  ])
    assert.equal(isPublicAddress(addr), false, addr)
  assert.equal(isPublicAddress('8.8.8.8'), true)
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
  for (const url of [
    'http://127.1/a',
    'http://2130706433/a',
    'http://[::1]/a',
    'file:///etc/passwd',
    'https://user:pass@example.com/a',
  ])
    await assert.rejects(downloadClash(url))
})

test('stable endpoints, IDs, bindings and persisted pool state on repeated import', async (t) => {
  const { manager, pool, calls } = fixture(t)
  assert.equal((await manager.import({ name: 'airport', yaml: yaml() })).added, 2)
  pool.bind(pool.state.proxies[0].id, 'vm-test')
  pool.reload()
  const before = structuredClone(pool.state)
  const sourceBefore = manager.state.sources[0].nodes.map((n) => [n.key, n.port, n.username, n.password])
  assert.equal((await manager.import({ name: 'airport', yaml: yaml() })).added, 0)
  assert.deepEqual(pool.state, before)
  pool.reload()
  assert.deepEqual(pool.state, before)
  assert.deepEqual(
    manager.state.sources[0].nodes.map((n) => [n.key, n.port, n.username, n.password]),
    sourceBefore,
  )
  assert.equal(pool.state.proxies.find((p) => p.port === 20000).label, 'airport / one')
  assert.deepEqual(calls.at(-1).rules, ['MATCH,REJECT'])
  assert.equal(calls.at(-1)['external-controller'], '127.0.0.1:19090')
  assert.ok(calls.at(-1).listeners.every((n) => n.type === 'socks' && n.users.length === 1 && n.proxy === n.name))
  assert.ok(!JSON.stringify(manager.status()).includes('fixture-only'))
})

test('missing nodes retire without endpoint reuse; returning nodes recover but manual disables remain', async (t) => {
  const { manager, pool, calls } = fixture(t)
  await manager.import({ name: 'airport', yaml: yaml() })
  const [one, two] = pool.state.proxies
  pool.setEnabled(one.id, false)
  await manager.import({ name: 'airport', yaml: yaml(['one']) })
  assert.equal(two.enabled, false)
  assert.equal(calls.at(-1).listeners.length, 1)
  const port = two.port
  await manager.import({ name: 'airport', yaml: yaml(['one', 'three']) })
  assert.notEqual(pool.state.proxies.find((p) => p.label.endsWith('three')).port, port)
  await manager.import({ name: 'airport', yaml: yaml() })
  assert.equal(pool.state.proxies.find((p) => p.id === two.id).enabled, true)
  assert.equal(pool.state.proxies.find((p) => p.id === one.id).enabled, false)
})

test('Mihomo rejection leaves persisted sources and pool unchanged and redacts remote errors', async (t) => {
  const { manager, pool, dataDir } = fixture(t)
  await manager.import({ name: 'airport', yaml: yaml() })
  const state = fs.readFileSync(path.join(dataDir, 'clash/subscriptions.json'), 'utf8')
  const before = JSON.stringify(pool.state)
  manager.fetch = async () => ({ ok: false, status: 400, text: async () => 'password-secret' })
  await assert.rejects(manager.import({ name: 'airport', yaml: yaml(['new']) }), /Mihomo rejected/)
  assert.equal(fs.readFileSync(path.join(dataDir, 'clash/subscriptions.json'), 'utf8'), state)
  assert.equal(JSON.stringify(pool.state), before)
  assert.equal(manager.busy, false)
})

test('restart reapplies persisted listeners and reconciles missing pool records', async (t) => {
  const { manager, pool, dataDir } = fixture(t)
  await manager.import({ name: 'airport', yaml: yaml() })
  pool.remove(pool.state.proxies[0].id)
  const restored = new ClashSubscriptions({
    dataDir,
    proxyPool: pool,
    controller: manager.controller,
    secret: manager.secret,
    fetchImpl: manager.fetch,
  })
  await restored.restore()
  assert.equal(pool.state.proxies.length, 2)
  assert.equal(restored.state.sources[0].nodes.length, 2)
})

test('configuration guard, URL import and administrator-only ACL', async (t) => {
  const { manager } = fixture(t, { download: async () => yaml(['url-node']) })
  assert.equal((await manager.import({ name: 'link', url: 'https://example.com/sub?token=test' })).added, 1)
  await assert.rejects(manager.import({ name: 'link', url: 'https://example.com', yaml: yaml() }), /either/)
  manager.controller = 'http://192.168.1.1:9090'
  await assert.rejects(manager.import({ name: 'link', yaml: yaml() }), /loopback/)
  for (const method of ['GET', 'POST']) {
    assert.equal(authorizePanelRoute(method, '/api/panel/proxies/clash', 'admin').ok, true)
    assert.equal(authorizePanelRoute(method, '/api/panel/proxies/clash', 'user').ok, false)
  }
})
