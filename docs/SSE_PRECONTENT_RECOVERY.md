# Pre-content SSE recovery

Keepalive bytes commit HTTP headers but no longer commit the inference attempt.
Worker content events still close the replay boundary (including tool events).
The existing same-seat retry count, total attempt budget, cancellation and request
deadline remain unchanged. Transport errors have a separate 30000ms hop window;
other errors retain the 10000ms default. Setting same_account_retry_max_hop_ms
or transport_retry_max_hop_ms to zero disables transport replay.

Per-attempt hop_meta.attempt_diagnostics records status, content commitment,
TTFT and allowlisted network codes. Generic Connection error remains
upstream_connection_unspecified: this is not DNS/TLS timing instrumentation
and does not identify Mihomo as the cause. No raw errors or URLs are persisted.

Validation: six focused Node suites: 165 tests, 137 passed, 28 platform skips,
zero failures on Windows. Unix socket tests require Linux CI before deployment.
No production deployment, route changes or real upstream requests performed.
