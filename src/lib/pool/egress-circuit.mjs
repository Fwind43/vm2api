import { createHash } from 'node:crypto'

// Only the bound snapshot is visible here. A sidecar's hidden route changes
// require a revision propagated by its manager; a display name is not identity.
export function egressKey(vm) {
  const proxy = vm?.proxy
  if (!proxy?.id) return null
  const route = [
    proxy.id,
    proxy.scheme,
    proxy.host,
    proxy.server,
    proxy.port,
    proxy.url,
    proxy.username,
    proxy.password,
    proxy.revision,
    proxy.config_version,
    vm.node_id,
  ]
  return createHash('sha256').update(JSON.stringify(route)).digest('hex')
}

/** Process-local transport isolation, separate from credential/quota state. */
export class EgressCircuit {
  constructor({ openMs = 30_000, maxOpenMs = 300_000, now = Date.now, random = Math.random } = {}) {
    this.openMs = openMs
    this.maxOpenMs = maxOpenMs
    this.now = now
    this.random = random
    this.states = new Map()
  }

  inspect(key, now = this.now()) {
    const state = key && this.states.get(key)
    if (!state || state.closed) return { ok: true }
    if (now < state.until) return { ok: false, until: state.until }
    if (state.probe) return { ok: false, until: now + 1000 }
    return { ok: true, halfOpen: true }
  }

  admit(key) {
    if (!key) return { ok: true, release() {}, success() {}, failure() {} }
    const view = this.inspect(key)
    if (!view.ok) return view
    let state = this.states.get(key)
    if (!state) {
      state = { closed: true, failures: 0, probe: null }
      this.states.set(key, state)
    }
    const token = Symbol('egress-lease')
    if (!state.closed) state.probe = token
    // Object identity is the generation. Old in-flight successes/failures must
    // never close or extend a newer outage, including a recovered generation.
    let active = true
    return {
      ok: true,
      release: () => {
        if (!active) return
        active = false
        if (state && this.states.get(key) === state && state.probe === token) state.probe = null
      },
      success: () => {
        if (!active || !state || this.states.get(key) !== state || state.probe !== token) return
        this.states.set(key, { closed: true, failures: 0, probe: null })
      },
      failure: () => {
        if (!active || this.states.get(key) !== state) return
        const failures = (state?.failures || 0) + 1
        const delay = Math.min(this.maxOpenMs, this.openMs * 2 ** Math.min(failures - 1, 10))
        this.states.set(key, {
          failures,
          until: this.now() + Math.min(this.maxOpenMs, Math.round(delay * (0.9 + this.random() * 0.2))),
          probe: null,
        })
      },
    }
  }
}
