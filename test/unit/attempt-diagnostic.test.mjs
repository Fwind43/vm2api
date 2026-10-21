import test from 'node:test'
import assert from 'node:assert/strict'
import { attemptDiagnostic } from '../../src/lib/protocol/attempt-diagnostic.mjs'
test('diagnostics retain only allowlisted network evidence', () => {
  const d = attemptDiagnostic(1, {
    status: 502,
    body: { error: { message: 'ENOTFOUND https://secret:password@host' } },
  })
  assert.equal(d.failure_stage, 'dns')
  assert.equal(d.network_code, 'ENOTFOUND')
  assert.ok(!JSON.stringify(d).includes('password'))
})
test('generic connection errors do not falsely blame a component', () => {
  const d = attemptDiagnostic(2, { committed: true, body: { error: { message: 'Connection error.' } } })
  assert.equal(d.failure_stage, 'upstream_connection_unspecified')
  assert.equal(d.content_committed, true)
  assert.equal(d.network_code, null)
})
