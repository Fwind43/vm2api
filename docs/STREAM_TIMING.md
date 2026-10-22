# Worker-hop stream timeline

`hop_meta.attempt_diagnostics[].timing` contains allowlisted numeric elapsed milliseconds, or null when unobserved. A fresh monotonic origin is created at each real streamGoWorker invocation, before payload preparation. Existing TTFT, commitment, retry and forwarding logic are unchanged.

- worker_dispatch_ms: about to invoke the local worker request (NOT actual socket write).
- worker_headers_ms: local worker HTTP response headers received, NOT Anthropic headers.
- first_chunk_ms: first local worker response body chunk; may be metadata/keepalive.
- first_event_ms: first parsed JSON event; may be metadata.
- first_thinking_ms / first_text_ms / first_tool_ms: first recognized nonempty thinking, text or tool-argument delta. Text/thinking in Anthropic block-start events are also observed. Tool-start names alone do not count. Recognized Responses deltas are supported; this is not an exhaustive event taxonomy.

Timing never retains text, URLs, credentials or headers. Null is not zero. First text is a control-plane observation, NOT client-render time. Worker chunks can bundle multiple upstream events. No inference of upstream DNS, TCP, TLS, prefill, local admission waiting or CLI startup duration is possible from these fields alone. Mock and non-stream paths have no timeline. Separate hop origins must not be subtracted across attempts. Instrumentation does not itself reduce TTFT.

Validation: deterministic timeline and diagnostic tests plus worker regressions on Windows. Unix socket tests skip on Windows; Linux integration and production collection are still required. No production change or paid inference was performed for this patch.
