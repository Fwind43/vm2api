// Local worker-hop observations, not upstream DNS/TCP/TLS timings.
export const timingKeys = Object.freeze([
  'worker_dispatch_ms', 'worker_headers_ms', 'first_chunk_ms', 'first_event_ms',
  'first_thinking_ms', 'first_text_ms', 'first_tool_ms',
])
export function safeTiming(value) {
  return Object.fromEntries(timingKeys.map(k => [k,
    Number.isFinite(value?.[k]) && value[k] >= 0 ? value[k] : null]))
}
export function createStreamTiming(now = () => performance.now()) {
  const start = now()
  const values = {}
  const mark = key => {
    if (timingKeys.includes(key) && values[key] == null) values[key] = Math.max(0, now() - start)
  }
  const nonempty = v => typeof v === 'string' && v.length > 0
  const block = b => {
    if (!b) return
    if (nonempty(b.text)) mark('first_text_ms')
    if (nonempty(b.thinking)) mark('first_thinking_ms')
  }
  return {
    mark,
    observe(event) {
      if (!event || typeof event !== 'object') return
      mark('first_event_ms')
      if (event.type === 'content_block_delta') {
        block(event.delta)
        if (nonempty(event.delta?.partial_json)) mark('first_tool_ms')
        if (event.delta?.type === 'thinking_delta' && event.delta.estimated_tokens > 0) mark('first_thinking_ms')
      }
      if (event.type === 'content_block_start') block(event.content_block)
      if (nonempty(event.delta)) {
        if (event.type === 'response.output_text.delta') mark('first_text_ms')
        if (['response.reasoning_text.delta', 'response.reasoning_summary_text.delta'].includes(event.type)) mark('first_thinking_ms')
        if (event.type === 'response.function_call_arguments.delta') mark('first_tool_ms')
      }
    },
    snapshot: () => safeTiming(values),
  }
}
