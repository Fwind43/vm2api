import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

function fixture(role = 'admin') {
  const calls = []
  const manager = {
    status: () => ({ configured: true, sources: [{ id: 'source-1', has_url: true }] }),
    import: async (body) => {
      calls.push(['import', body])
      return { added: 1 }
    },
    refresh: async (id) => {
      calls.push(['refresh', id])
      return { unchanged: true }
    },
    configure: (body) => {
      calls.push(['configure', body])
      return { source: { id: body.source_id, auto_refresh: body.auto_refresh } }
    },
  }
  let input
  let response
  const handle = createPanelHandler({
    cfg: { paths: {} },
    clashSubscriptions: manager,
    requireAuth(req) {
      req.panelUser = 'fixture'
      req.panelRole = role
      return true
    },
    readBody: async () => input,
    json(_res, status, body) {
      response = { status, body }
    },
  })
  return {
    manager,
    calls,
    async request(method, body) {
      input = body
      response = null
      await handle({ method }, {}, new URL('http://localhost/api/panel/proxies/clash'))
      return response
    },
  }
}

test('Clash endpoint dispatches legacy import, refresh and configure actions', async () => {
  const f = fixture()
  assert.equal((await f.request('GET')).body.sources[0].has_url, true)
  const legacy = { name: 'airport', yaml: 'proxies: []' }
  assert.equal((await f.request('POST', legacy)).status, 200)
  assert.deepEqual(f.calls.at(-1), ['import', legacy])
  assert.equal((await f.request('POST', { action: 'refresh', source_id: 'source-1' })).body.unchanged, true)
  assert.deepEqual(f.calls.at(-1), ['refresh', 'source-1'])
  const config = { action: 'configure', source_id: 'source-1', auto_refresh: false, refresh_interval_minutes: 60 }
  assert.equal((await f.request('POST', config)).body.source.auto_refresh, false)
  assert.deepEqual(f.calls.at(-1), ['configure', config])
  const count = f.calls.length
  assert.equal((await f.request('POST', { action: 'unknown' })).status, 400)
  assert.equal(f.calls.length, count)
  assert.equal((await f.request('DELETE')).status, 405)
})

test('Clash refresh endpoint returns safe manager failure and remains admin-only', async () => {
  const f = fixture()
  f.manager.refresh = async () => {
    throw new Error('Subscription refresh failed; previous configuration retained')
  }
  const failure = await f.request('POST', { action: 'refresh', source_id: 'source-1' })
  assert.equal(failure.status, 400)
  assert.match(failure.body.error.message, /previous configuration retained/)
  for (const role of ['user', 'super']) {
    const restricted = fixture(role)
    for (const action of ['import', 'refresh', 'configure']) {
      assert.equal((await restricted.request('POST', { action, source_id: 'source-1' })).status, 403)
    }
    assert.equal((await restricted.request('GET')).status, 403)
    assert.equal(restricted.calls.length, 0)
  }
})
