import { safeTiming } from '../transport/stream-timing.mjs'
// Bounded metadata only: never persist arbitrary error messages, URLs or credentials.
export function attemptDiagnostic(attemptNo, result = {}, policy = {}) {
  const error = result?.body?.error || result?.error || {}
  const hay = `${error.code || ''} ${error.message || ''}`
  const network =
    /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ERR_TLS_CERT_ALTNAME_INVALID/i
      .exec(hay)?.[0]
      ?.toUpperCase() || null
  return {
    attempt: attemptNo,
    timing: safeTiming(result?.timing),
    upstream_status: result?.status ?? null,
    content_committed: result?.committed === true,
    first_token_ms: result?.ttftMs ?? null,
    network_code: network,
    failure_stage:
      network === 'ENOTFOUND' || network === 'EAI_AGAIN'
        ? 'dns'
        : network === 'ECONNREFUSED'
          ? 'connect'
          : network === 'ERR_TLS_CERT_ALTNAME_INVALID'
            ? 'tls'
            : /connection error/i.test(hay)
              ? 'upstream_connection_unspecified'
              : 'unknown',
    transport_failure: policy?.reason === 'proxy_transport_failure',
  }
}
