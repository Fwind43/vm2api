import test from 'node:test'
import assert from 'node:assert/strict'
import { createStreamTiming, safeTiming } from '../../src/lib/transport/stream-timing.mjs'
import { attemptDiagnostic } from '../../src/lib/protocol/attempt-diagnostic.mjs'
test('monotonic timeline separates thinking and visible text without retaining content', () => {
  let t = 100
  const x = createStreamTiming(() => t)
  x.mark('worker_dispatch_ms')
  t = 120; x.mark('worker_headers_ms')
  t = 130; x.observe({type: 'message_start'})
  assert.equal(x.snapshot().first_text_ms, null)
  t = 140; x.observe({type: 'content_block_delta', delta: {thinking: 'secret'}})
  t = 180; x.observe({type: 'content_block_delta', delta: {text: 'answer'}})
  t = 200; x.observe({type: 'content_block_delta', delta: {text: 'more'}})
  const d = attemptDiagnostic(1, {timing: x.snapshot()})
  assert.equal(d.timing.first_event_ms, 30)
  assert.equal(d.timing.first_thinking_ms, 40)
  assert.equal(d.timing.first_text_ms, 80)
  assert.equal(d.timing.worker_dispatch_ms, 0)
  assert.ok(!JSON.stringify(d).includes('secret'))
})
test('empty events and signatures are not generated text', () => {
  const x = createStreamTiming(() => 0)
  x.observe({type:'content_block_delta', delta:{text:'', signature:'secret'}})
  assert.equal(x.snapshot().first_text_ms, null)
  assert.equal(x.snapshot().first_thinking_ms, null)
  x.observe({type:'content_block_delta', delta:{type:'thinking_delta', estimated_tokens:1}})
  assert.equal(x.snapshot().first_thinking_ms, 0)
})
test('Responses deltas and tool arguments have separate clocks', () => {
  let t=0; const x=createStreamTiming(() => t)
  t=10; x.observe({type:'response.reasoning_summary_text.delta',delta:'a'})
  t=20; x.observe({type:'response.function_call_arguments.delta',delta:'{}'})
  t=30; x.observe({type:'response.output_text.delta',delta:'b'})
  assert.equal(x.snapshot().first_thinking_ms,10)
  assert.equal(x.snapshot().first_tool_ms,20)
  assert.equal(x.snapshot().first_text_ms,30)
})
test('allowlist rejects invalid numeric values and arbitrary properties', () => {
  const s=safeTiming({first_text_ms:-1, first_tool_ms:Infinity, first_event_ms:'2', url:'secret'})
  assert.ok(Object.values(s).every(v=>v===null))
  assert.ok(!JSON.stringify(s).includes('secret'))
})
