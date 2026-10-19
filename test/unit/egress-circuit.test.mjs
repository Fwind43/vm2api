import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EgressCircuit, egressKey } from '../../src/lib/pool/egress-circuit.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { mapUpstreamError, rewritePoolErrorForClient } from '../../src/lib/core/errors.mjs'

test('client mapping preserves egress 503 identity and retry hints without leaking internal details', () => {
  for (const [retryMs, expected] of [
    [30500, 31],
    [0, 1],
    ['invalid', 1],
  ]) {
    const body = {
      type: 'error',
      error: {
        type: 'api_error',
        code: 'pool_egress_unavailable',
        message: 'private-route-details',
        details: { retry_after_ms: retryMs },
      },
    }
    const mapped = rewritePoolErrorForClient(mapUpstreamError(503, body), body)
    assert.equal(mapped.status, 503)
    assert.equal(mapped.body.error.type, 'api_error')
    assert.equal(mapped.body.error.code, 'pool_egress_unavailable')
    assert.equal(mapped.retryAfterSec, expected)
    assert.equal(JSON.stringify(mapped).includes('private-route-details'), false)
  }
})

function clocked() {
  let now = 1000
  return {
    circuit: new EgressCircuit({ now: () => now, random: () => 0.5 }),
    tick: (ms) => {
      now += ms
    },
  }
}

function success() {
  return {
    ok: true,
    status: 200,
    terminalState: 'verified',
    body: {
      type: 'message',
      id: 'msg_ok',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}

function transportError() {
  return {
    ok: false,
    status: 502,
    terminalState: 'transport_error',
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        code: 'upstream_network_error',
        message: 'Connection error.',
        details: { upstream_type: 'api_error', upstream_status: 502 },
      },
    },
  }
}

function fixture(t, { shared = false, slots = 2, maxConcurrency = 2 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-egress-circuit-'))
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir)
  const vms = []
  for (let i = 1; i <= slots; i++) {
    const id = `vm-0${i}`
    const proxyId = shared ? 'shared' : `proxy-${i}`
    const vm = {
      id,
      name: id,
      status: 'running',
      schedulable: true,
      proxy_cli_enabled: true,
      proxy: { id: proxyId, url: `socks5h://127.0.0.1:${shared ? 10001 : 10000 + i}` },
      runtime: { worker_socket: path.join(dir, id, 'run', 'worker.sock') },
      policy: { maxConcurrency, concurrencyOverride: true, weight: 1, priority: 0 },
      claude: {
        account_uuid: `account-${i}`,
        account_tier: 'max',
        access_token: `test-access-${i}`,
        refresh_token: `test-refresh-${i}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(vm))
    vms.push(vm)
  }
  const cooldowns = []
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: {
      get: () => null,
      upsert() {},
      clearExpired() {},
      clearRecoveredAuthCooldown() {},
      markCooldown: (...args) => cooldowns.push(args),
    },
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fallback_wait_timeout_ms: 5000, sticky_wait_timeout_ms: 5000 },
  })
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return { root, pool, vms, cooldowns }
}

function open(pool, vm) {
  const lease = pool.egressCircuit.admit(egressKey(vm))
  assert.equal(lease.ok, true)
  lease.failure()
  lease.release()
  pool.notifyCapacity()
}

const request = { model: 'claude-test', allowWait: true }

test('egress identity ignores display names, separates route revisions, and does not expose credentials', () => {
  const vm = { proxy: { id: 'px-1', url: 'socks5://user:secret@localhost:1' } }
  const key = egressKey(vm)
  assert.match(key, /^[a-f0-9]{64}$/)
  assert.equal(egressKey({ ...vm, name: 'renamed', proxy: { ...vm.proxy, name: 'new label' } }), key)
  assert.notEqual(egressKey({ proxy: { ...vm.proxy, url: 'socks5://localhost:2' } }), key)
  assert.notEqual(egressKey({ proxy: { ...vm.proxy, revision: 2 } }), key)
  assert.equal(egressKey({}), null)
})

test('egress opens, admits one half-open probe, and recovers without switching routes', () => {
  const { circuit, tick } = clocked()
  circuit.admit('exit').failure()
  assert.deepEqual(circuit.inspect('exit'), { ok: false, until: 31000 })
  assert.equal(circuit.admit('exit').ok, false)
  assert.equal(circuit.admit('other').ok, true)
  tick(30000)
  const probe = circuit.admit('exit')
  assert.equal(probe.ok, true)
  assert.equal(circuit.admit('exit').ok, false)
  probe.success()
  assert.deepEqual(circuit.inspect('exit'), { ok: true })
  probe.release()
  assert.equal(circuit.admit('exit').ok, true)
})

test('failed probes back off, released probes do not leak, and stale leases cannot alter generations', () => {
  const { circuit, tick } = clocked()
  const first = circuit.admit('exit')
  const stale = circuit.admit('exit')
  first.failure()
  stale.success()
  stale.failure()
  assert.equal(circuit.inspect('exit').until, 31000)
  tick(30000)
  const cancelled = circuit.admit('exit')
  cancelled.release()
  const probe = circuit.admit('exit')
  assert.equal(probe.ok, true)
  cancelled.failure()
  assert.equal(circuit.inspect('exit').ok, false)
  probe.failure()
  assert.equal(circuit.inspect('exit').until, 91000)
  tick(60000)
  const recovered = circuit.admit('exit')
  recovered.success()
  stale.failure()
  recovered.failure()
  assert.equal(circuit.inspect('exit').ok, true)
})

test('repeated half-open failures cap at five minutes', () => {
  const { circuit, tick } = clocked()
  let elapsed = 1000
  for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
    circuit.admit('exit').failure()
    assert.equal(circuit.inspect('exit').until, elapsed + delay)
    tick(delay)
    elapsed += delay
  }
})

test('shared exit failure skips all bound accounts but leaves a healthy exit schedulable', async (t) => {
  const { pool, vms, cooldowns } = fixture(t)
  open(pool, vms[0])
  const selected = await pool.selectAndReserve(request)
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  selected.release()
  assert.deepEqual(cooldowns, [])
})

test('all accounts on a failed shared exit return explicit 503 and retry hint without waiting', async (t) => {
  const { pool, vms, cooldowns } = fixture(t, { shared: true })
  open(pool, vms[0])
  const started = Date.now()
  const runner = new FailoverRunner({ scheduler: pool })
  const result = await runner.run({
    requestId: 'egress-unavailable',
    model: request.model,
    canonicalBody: { model: request.model },
    callAttempt: () => assert.fail('must not execute'),
  })
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'pool_egress_unavailable')
  assert.equal(result.body.error.type, 'api_error')
  assert.ok(result.retryAfterSec >= 1 && result.retryAfterSec <= 34)
  assert.ok(Date.now() - started < 2000)
  assert.deepEqual(cooldowns, [])
})

test('exhausted replay opens the shared exit without cooling down account credentials', async (t) => {
  const { pool, vms, cooldowns } = fixture(t, { shared: true })
  const runner = new FailoverRunner({ scheduler: pool, config: { same_account_retry_delay_ms: 0 } })
  const seen = []
  const result = await runner.run({
    requestId: 'egress-replay',
    model: request.model,
    canonicalBody: { model: request.model },
    callAttempt: ({ candidate }) => {
      seen.push(candidate.accountId)
      return transportError()
    },
  })
  assert.equal(result.ok, false)
  // Existing avoid semantics try the other idle account before the one replay.
  assert.deepEqual(seen, ['account-1', 'account-2', 'account-1'])
  assert.equal(pool.egressCircuit.inspect(egressKey(vms[0])).ok, false)
  assert.deepEqual(cooldowns, [])
  const next = await pool.selectAndReserve(request)
  assert.equal(next.reason, 'pool_egress_unavailable')
})

test('one transient failure still replays on the same account and does not open the exit', async (t) => {
  const { pool, vms } = fixture(t, { slots: 1 })
  const runner = new FailoverRunner({ scheduler: pool, config: { same_account_retry_delay_ms: 0 } })
  let calls = 0
  const result = await runner.run({
    requestId: 'egress-transient',
    model: request.model,
    canonicalBody: { model: request.model },
    callAttempt: () => (++calls === 1 ? transportError() : success()),
  })
  assert.equal(result.ok, true)
  assert.equal(calls, 2)
  assert.equal(pool.egressCircuit.inspect(egressKey(vms[0])).ok, true)
})

test('half-open reservation is atomic across accounts and cancellation releases the probe', async (t) => {
  const { pool, vms } = fixture(t, { shared: true })
  const { circuit, tick } = clocked()
  // Eligibility uses the scheduler wall clock, so inject a synchronized clock.
  let now = Date.now()
  circuit.now = () => now
  pool.egressCircuit = circuit
  open(pool, vms[0])
  now += 30000
  // Fast-forward the gate without changing global Date.now.
  circuit.states.get(egressKey(vms[0])).until = Date.now() - 1
  const candidates = await pool.eligibleCandidates({ model: request.model, excluded: new Set() })
  const a = pool.reserve(candidates[0])
  const b = pool.reserve(candidates[1])
  assert.ok(a)
  assert.equal(b, null)
  a.release()
  const next = pool.reserve(candidates[1])
  assert.ok(next)
  next.egressLease.success()
  next.release()
  assert.equal(pool.egressCircuit.inspect(egressKey(vms[0])).ok, true)
})

test('normal request-capacity contention still waits and succeeds after release', async (t) => {
  const { pool } = fixture(t, { slots: 1, maxConcurrency: 1 })
  const first = await pool.selectAndReserve(request)
  assert.equal(first.ok, true)
  const waiting = pool.selectAndReserve(request)
  const timer = setTimeout(() => first.release(), 50)
  t.after(() => clearTimeout(timer))
  const second = await waiting
  assert.equal(second.ok, true)
  assert.ok(second.waitMs >= 20)
  second.release()
})

test('an existing seat queue exits promptly when its last healthy exit opens', async (t) => {
  const { pool, vms } = fixture(t, { slots: 1, maxConcurrency: 1 })
  pool.config.default_session_slots = 1
  const first = await pool.selectAndReserve({ ...request, seatKey: 'first-conversation' })
  assert.equal(first.ok, true)
  let done = false
  const waiting = pool.selectAndReserve({ ...request, seatKey: 'second-conversation' }).then((value) => {
    done = true
    return value
  })
  const timer = setTimeout(() => open(pool, vms[0]), 50)
  t.after(() => {
    clearTimeout(timer)
    first.release()
  })
  const result = await waiting
  assert.equal(done, true)
  assert.equal(result.reason, 'pool_egress_unavailable')
  assert.ok(result.waitMs < 2000)
})

test('diagnostic pin bypasses an open exit and the kill switch restores legacy selection', async (t) => {
  const { pool, vms } = fixture(t, { slots: 1 })
  open(pool, vms[0])
  const pinned = await pool.selectAndReserve({ ...request, pinVmId: 'vm-01' })
  assert.equal(pinned.ok, true)
  assert.equal(pinned.egressLease, null)
  pinned.release()
  pool.config.egress_circuit_enabled = false
  const legacy = await pool.selectAndReserve(request)
  assert.equal(legacy.ok, true)
  assert.equal(legacy.egressLease, null)
  legacy.release()
})
