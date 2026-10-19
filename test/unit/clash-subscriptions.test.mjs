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
  t.after(() => {
    manager.stopScheduler()
    pool.stopScheduler()
  })
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

test('ECH nodes retain secure DNS across import, reimport and restart', async (t) => {
  const { manager, pool, dataDir, calls } = fixture(t)
  const input = {
    proxies: [
      {
        ...JSON.parse(yaml(['ech'])).proxies[0],
        'ech-opts': { enable: true, 'query-server-name': 'cloudflare-ech.com' },
      },
    ],
    dns: { enable: false, nameserver: ['127.0.0.1'] },
  }
  const expectedDns = {
    enable: true,
    ipv6: true,
    'default-nameserver': ['1.1.1.1', '8.8.8.8'],
    nameserver: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'],
  }
  const imported = { name: 'ech-airport', yaml: JSON.stringify(input) }
  await manager.import(imported)
  pool.reload()
  const before = structuredClone(pool.state)
  await manager.import(imported)
  const restored = new ClashSubscriptions({
    dataDir,
    proxyPool: pool,
    controller: manager.controller,
    secret: manager.secret,
    fetchImpl: manager.fetch,
  })
  await restored.restore()
  assert.equal(calls.length, 2) // Unchanged reimport must not reload Mihomo.
  for (const config of calls) {
    assert.deepEqual(config.dns, expectedDns)
    assert.deepEqual(config.proxies[0]['ech-opts'], input.proxies[0]['ech-opts'])
    assert.equal(config.proxies[0]['skip-cert-verify'], undefined)
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'clash/config.yaml'), 'utf8')).dns, expectedDns)
  pool.reload()
  assert.deepEqual(pool.state, before)
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

const persisted = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'clash', 'subscriptions.json'), 'utf8'))
const later = (time, minutes) => new Date(time + minutes * 60000).toISOString()

test('URL and schedule survive restart; status never returns tokens or node credentials', async (t) => {
  let now = Date.parse('2026-10-19T12:00:00Z')
  let downloads = 0
  const url = 'https://provider.example/sub?token=private-fixture-token'
  const download = async (value) => {
    assert.equal(value, url)
    downloads++
    return yaml()
  }
  const { manager, pool, dataDir } = fixture(t, { now: () => now, download })
  await manager.import({ name: 'saved', url })
  const saved = persisted(dataDir).sources[0]
  assert.equal(saved.url, url)
  assert.equal(saved.auto_refresh, true)
  assert.equal(saved.refresh_interval_minutes, 360)
  assert.equal(saved.next_refresh_at, later(now, 360))
  assert.doesNotMatch(JSON.stringify(manager.status()), /private-fixture-token|fixture-only|https:\/\//)
  const restarted = new ClashSubscriptions({
    dataDir,
    proxyPool: pool,
    controller: manager.controller,
    secret: manager.secret,
    fetchImpl: manager.fetch,
    download,
    now: () => now,
  })
  await restarted.restore()
  await restarted.runDue()
  assert.equal(downloads, 1)
  now += 361 * 60000
  await restarted.runDue()
  assert.equal(downloads, 2)
  assert.equal(persisted(dataDir).sources[0].id, saved.id)
  assert.equal(persisted(dataDir).sources[0].last_success_at, later(now, 0))
  assert.equal(persisted(dataDir).sources[0].next_refresh_at, later(now, 360))
})

test('unchanged refresh and multi-source reimport preserve endpoints, config and pool bytes', async (t) => {
  let now = Date.parse('2026-10-19T12:00:00Z')
  const { manager, pool, calls, dataDir } = fixture(t, { now: () => now, download: async () => yaml() })
  await manager.import({ name: 'first', url: 'https://provider.example/first' })
  await manager.import({ name: 'second', yaml: yaml(['other']) })
  const before = structuredClone(manager.state.sources)
  const config = fs.readFileSync(path.join(dataDir, 'clash', 'config.yaml'), 'utf8')
  const poolState = structuredClone(pool.state)
  const count = calls.length
  now += 360 * 60000
  assert.equal((await manager.refresh(before[0].id)).unchanged, true)
  assert.equal((await manager.refresh(before[0].id)).unchanged, true)
  assert.equal(calls.length, count)
  assert.deepEqual(pool.state, poolState)
  assert.equal(fs.readFileSync(path.join(dataDir, 'clash', 'config.yaml'), 'utf8'), config)
  assert.deepEqual(
    persisted(dataDir).sources.map((s) => s.nodes),
    before.map((s) => s.nodes),
  )
  assert.deepEqual(
    manager.state.sources.map((s) => s.id),
    before.map((s) => s.id),
  )
})

test('download failure retains last good nodes, config and success time; retries after 15 minutes', async (t) => {
  let now = Date.parse('2026-10-19T12:00:00Z')
  let broken = false
  let attempts = 0
  const { manager, pool, calls, dataDir } = fixture(t, {
    now: () => now,
    download: async () => {
      attempts++
      if (broken) throw new Error('https://provider.example/private-token secret-password')
      return yaml()
    },
  })
  await manager.import({ name: 'saved', url: 'https://provider.example/sub' })
  const before = structuredClone(manager.state.sources[0])
  const poolState = structuredClone(pool.state)
  const config = fs.readFileSync(path.join(dataDir, 'clash', 'config.yaml'), 'utf8')
  broken = true
  now += 360 * 60000
  await assert.rejects(manager.refresh(before.id), (error) => {
    assert.doesNotMatch(error.message, /private-token|secret-password/)
    return /previous configuration retained/.test(error.message)
  })
  const after = persisted(dataDir).sources[0]
  assert.deepEqual(after.nodes, before.nodes)
  assert.equal(after.last_success_at, before.last_success_at)
  assert.equal(after.last_error, 'refresh_failed')
  assert.equal(after.next_refresh_at, later(now, 15))
  assert.equal(calls.length, 1)
  assert.deepEqual(pool.state, poolState)
  assert.equal(fs.readFileSync(path.join(dataDir, 'clash', 'config.yaml'), 'utf8'), config)
  assert.doesNotMatch(JSON.stringify(manager.status()), /private-token|secret-password/)
  await manager.runDue()
  assert.equal(attempts, 2)
  broken = false
  now += 15 * 60000
  await manager.runDue()
  assert.equal(attempts, 3)
  assert.equal(manager.status().sources[0].last_error, null)
})

test('invalid YAML and controller rejection retain saved configuration on refresh', async (t) => {
  let text = yaml()
  const { manager, calls, dataDir } = fixture(t, { download: async () => text })
  await manager.import({ name: 'saved', url: 'https://provider.example/sub' })
  const id = manager.state.sources[0].id
  const before = persisted(dataDir).sources[0].nodes
  text = 'invalid: yaml'
  await assert.rejects(manager.refresh(id), /refresh failed/)
  assert.deepEqual(persisted(dataDir).sources[0].nodes, before)
  text = yaml(['new'])
  manager.fetch = async () => ({ ok: false, status: 400, text: async () => 'sensitive-provider-error' })
  await assert.rejects(manager.refresh(id), /refresh failed/)
  assert.deepEqual(persisted(dataDir).sources[0].nodes, before)
  assert.equal(calls.length, 1)
})

test('automatic and saved-URL refresh refuse changed or removed bound nodes; explicit import can confirm', async (t) => {
  let text = yaml()
  const { manager, pool, calls, dataDir } = fixture(t, { download: async () => text })
  await manager.import({ name: 'saved', url: 'https://provider.example/sub' })
  const id = manager.state.sources[0].id
  const row = pool.state.proxies[0]
  row.bound_vm_id = JSON.stringify(['vm-01', 'vm-02'])
  pool.save()
  const before = structuredClone(manager.state.sources[0].nodes)
  const parsed = JSON.parse(yaml())
  parsed.proxies[0].password = 'rotated-fixture'
  text = JSON.stringify(parsed)
  await assert.rejects(manager.refresh(id), /Bound nodes changed/)
  assert.deepEqual(persisted(dataDir).sources[0].nodes, before)
  assert.equal(manager.status().sources[0].last_error, 'bound_nodes_changed')
  assert.equal(calls.length, 1)
  text = yaml(['two'])
  await assert.rejects(manager.refresh(id), /Bound nodes changed/)
  assert.equal(calls.length, 1)
  text = JSON.stringify(parsed)
  await manager.import({ name: 'saved', url: 'https://provider.example/sub' })
  assert.equal(calls.length, 2)
  assert.equal(pool.state.proxies[0].id, row.id)
  assert.equal(pool.state.proxies[0].bound_vm_id, row.bound_vm_id)
})

test('unbound nodes can update automatically without changing IDs or listener credentials', async (t) => {
  let text = yaml()
  const { manager, calls } = fixture(t, { download: async () => text })
  await manager.import({ name: 'saved', url: 'https://provider.example/sub' })
  const before = structuredClone(manager.state.sources[0])
  const parsed = JSON.parse(text)
  parsed.proxies[0].server = 'new.example.com'
  text = JSON.stringify(parsed)
  await manager.refresh(before.id)
  const after = manager.state.sources[0]
  assert.equal(calls.length, 2)
  for (const field of ['key', 'port', 'username', 'password'])
    assert.equal(after.nodes[0][field], before.nodes[0][field])
  assert.equal(after.nodes[0].proxy.server, 'new.example.com')
})

test('settings persist interval and pause; YAML import clears saved URL and disables refresh', async (t) => {
  let now = Date.parse('2026-10-19T12:00:00Z')
  let downloads = 0
  const { manager, dataDir } = fixture(t, {
    now: () => now,
    download: async () => {
      downloads++
      return yaml()
    },
  })
  await manager.import({ name: 'saved', url: 'https://provider.example/sub' })
  const id = manager.state.sources[0].id
  manager.configure({ source_id: id, auto_refresh: false, refresh_interval_minutes: 30 })
  assert.equal(persisted(dataDir).sources[0].next_refresh_at, null)
  now += 400 * 60000
  await manager.runDue()
  assert.equal(downloads, 1)
  await manager.refresh(id) // Manual refresh still works while paused.
  assert.equal(manager.status().sources[0].auto_refresh, false)
  manager.configure({ source_id: id, auto_refresh: true, refresh_interval_minutes: 30 })
  assert.equal(persisted(dataDir).sources[0].next_refresh_at, later(now, 30))
  await manager.import({ name: 'saved', yaml: yaml() })
  assert.equal(persisted(dataDir).sources[0].url, null)
  assert.equal(manager.status().sources[0].auto_refresh, false)
  assert.throws(() => manager.configure({ source_id: id, auto_refresh: true }), /Reimport/)
  await assert.rejects(manager.refresh(id), /Reimport/)
})

test('interval validation, busy lock and scheduler lifecycle are bounded', async (t) => {
  let release
  const { manager } = fixture(t, {
    download: () =>
      new Promise((resolve) => {
        release = resolve
      }),
  })
  for (const interval of [0, 14, 10081, 30.5, 'bad'])
    await assert.rejects(
      manager.import({ name: 'bad', yaml: yaml(), refresh_interval_minutes: interval }),
      /Refresh interval/,
    )
  const importing = manager.import({ name: 'saved', url: 'https://provider.example/sub' })
  await assert.rejects(manager.import({ name: 'other', yaml: yaml() }), /in progress/)
  await assert.rejects(manager.refresh('missing'), /in progress/)
  release(yaml())
  await importing
  const id = manager.state.sources[0].id
  assert.throws(() => manager.configure({ source_id: id, auto_refresh: 'true' }), /boolean/)
  assert.throws(
    () => manager.configure({ source_id: id, auto_refresh: true, refresh_interval_minutes: 14 }),
    /Refresh interval/,
  )
  let runs = 0
  manager.runDue = async () => {
    runs++
  }
  manager.startScheduler()
  const timer = manager.timer
  manager.startScheduler()
  assert.equal(manager.timer, timer)
  assert.equal(runs, 1)
  manager.stopScheduler()
  manager.stopScheduler()
  assert.equal(manager.timer, null)
})
