import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'
import { parseDocument } from 'yaml'

export const CLASH_MAX_BYTES = 2 * 1024 * 1024
const MAX_NODES = 500
const TYPES = new Set([
  'ss',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'tuic',
  'socks5',
  'http',
  'snell',
  'wireguard',
  'ssh',
  'mieru',
  'anytls',
])
const fail = (message) => {
  throw new Error(message)
}

export function parseClash(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > CLASH_MAX_BYTES) fail('Clash YAML must be at most 2 MiB')
  let doc
  try {
    const parsed = parseDocument(text, { uniqueKeys: true })
    if (parsed.errors.length) fail('invalid_yaml')
    doc = parsed.toJS({ maxAliasCount: 30 })
  } catch {
    fail('Invalid Clash YAML')
  }
  if (!Array.isArray(doc?.proxies) || !doc.proxies.length)
    fail('Clash YAML needs a non-empty proxies list (provider-only and Base64 subscriptions are not supported)')
  if (doc.proxies.length > MAX_NODES) fail(`At most ${MAX_NODES} nodes per import`)
  const names = new Set()
  const proxies = []
  const skipped = []
  for (const p of doc.proxies) {
    const name = typeof p?.name === 'string' ? p.name.trim() : ''
    if (!name || name.length > 200 || names.has(name))
      fail('Node names must be unique, non-empty and at most 200 characters')
    names.add(name)
    if (!TYPES.has(p.type)) {
      skipped.push({ name, reason: 'unsupported_type' })
      continue
    }
    if (typeof p.server !== 'string' || !p.server.trim() || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535)
      fail('Invalid node server or port')
    // Never import executable/local-file options or chained references from an untrusted document.
    const forbidden = new Set([
      'dialer-proxy',
      'proxy',
      'interface-name',
      'routing-mark',
      'ip-version',
      'private-key-path',
      'certificate',
      'private-key',
    ])
    const walk = (obj, depth = 0) => {
      if (depth > 20) fail('Node options are too deeply nested')
      if (!obj || typeof obj !== 'object') return
      for (const [key, value] of Object.entries(obj)) {
        if (forbidden.has(key)) fail('Node contains unsupported local-file or chained-proxy options')
        walk(value, depth + 1)
      }
    }
    walk(p)
    proxies.push({ ...p, name })
  }
  if (!proxies.length) fail('No supported Clash nodes found')
  return { proxies, skipped }
}

export function isPublicAddress(address) {
  const a = address.toLowerCase().split('%')[0]
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number)
    return !(
      x === 0 ||
      x === 10 ||
      x === 127 ||
      x >= 224 ||
      (x === 100 && y >= 64 && y <= 127) ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && (y === 168 || y === 0)) ||
      (x === 198 && (y === 18 || y === 19))
    )
  }
  // Only global-unicast IPv6; reject mapped IPv4, loopback, ULA and link-local.
  return net.isIPv6(a) && /^[23][0-9a-f]{0,3}:/.test(a) && !a.startsWith('2001:db8:')
}

export async function downloadClash(raw, redirects = 0) {
  let url
  try {
    url = new URL(raw)
  } catch {
    fail('Invalid subscription URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || redirects > 4)
    fail('Subscription URL must use HTTP(S), without URL credentials')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host) && !isPublicAddress(host))
    fail('Private subscription addresses are not allowed; upload YAML instead')
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(
      url,
      {
        headers: { 'User-Agent': 'clash.meta/vm2api', Accept: 'application/yaml, text/yaml, text/plain' },
        signal: AbortSignal.timeout(15000),
        lookup: (hostname, options, cb) =>
          dns.lookup(hostname, { all: true }, (err, addresses) => {
            if (err) return cb(new Error('Subscription DNS lookup failed'))
            if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
              return cb(new Error('Private subscription addresses are not allowed; upload YAML instead'))
            // Pin the validated address; do not resolve it again during connect.
            cb(null, options.all ? addresses : addresses[0].address, addresses[0].family)
          }),
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume()
          if (!res.headers.location) return reject(new Error('Invalid subscription redirect'))
          let next
          try {
            next = new URL(res.headers.location, url).href
          } catch {
            return reject(new Error('Invalid subscription redirect'))
          }
          resolve(downloadClash(next, redirects + 1))
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`Subscription returned HTTP ${res.statusCode}`))
          return
        }
        const chunks = []
        let size = 0
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > CLASH_MAX_BYTES) req.destroy(new Error('Subscription exceeds 2 MiB'))
          else chunks.push(chunk)
        })
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        res.on('error', () => reject(new Error('Subscription download failed')))
      },
    )
    req.on('error', (error) =>
      reject(
        new Error(
          error.message?.includes('Private subscription')
            ? error.message
            : 'Subscription download failed (network, timeout or size limit)',
        ),
      ),
    )
  })
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
}

/** Optional Mihomo sidecar. One fixed, authenticated SOCKS listener per node. */
export class ClashSubscriptions {
  constructor({
    dataDir,
    proxyPool,
    controller = process.env.VM2API_CLASH_CONTROLLER,
    secret = process.env.VM2API_CLASH_SECRET,
    host = process.env.VM2API_CLASH_PROXY_HOST || '127.0.0.1',
    listen = process.env.VM2API_CLASH_LISTEN || '127.0.0.1',
    portStart = Number(process.env.VM2API_CLASH_PORT_START || 20000),
    fetchImpl = fetch,
    download = downloadClash,
  } = {}) {
    this.dir = path.join(dataDir, 'clash')
    this.proxyPool = proxyPool
    this.controller = controller?.replace(/\/$/, '')
    this.secret = secret
    this.host = host
    this.listen = listen
    this.portStart = portStart
    this.fetch = fetchImpl
    this.download = download
    this.busy = false
    this.state = { version: 1, sources: [] }
    const statePath = path.join(this.dir, 'subscriptions.json')
    if (fs.existsSync(statePath)) this.state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  }

  status() {
    return {
      configured: !!(this.controller && this.secret),
      sources: this.state.sources.map((s) => ({
        id: s.id,
        name: s.name,
        nodes: s.nodes.filter((n) => !n.retired).length,
        retired: s.nodes.filter((n) => n.retired).length,
        updated_at: s.updated_at,
      })),
    }
  }

  config(state) {
    const nodes = state.sources.flatMap((s) => s.nodes.filter((n) => !n.retired))
    return {
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'warning',
      ipv6: true,
      'external-controller': new URL(this.controller).host,
      secret: this.secret,
      'geo-auto-update': false,
      'geodata-loader': 'standard',
      // ECH needs HTTPS (type 65) records; the system resolver cannot supply them.
      // Use our own resolver policy instead of importing subscription DNS settings.
      dns: {
        enable: true,
        ipv6: true,
        'default-nameserver': ['1.1.1.1', '8.8.8.8'],
        nameserver: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'],
      },
      proxies: nodes.map((n) => ({ ...n.proxy, name: n.key })),
      listeners: nodes.map((n) => ({
        name: n.key,
        type: 'socks',
        listen: this.listen,
        port: n.port,
        udp: false,
        proxy: n.key,
        users: [{ username: n.username, password: n.password }],
      })),
      rules: ['MATCH,REJECT'],
    }
  }

  async apply(state) {
    if (!this.controller || !this.secret)
      fail('Enable the Mihomo sidecar and configure VM2API_CLASH_CONTROLLER / VM2API_CLASH_SECRET first')
    const endpoint = new URL(this.controller)
    if (
      endpoint.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== '/' ||
      endpoint.search ||
      endpoint.hash
    )
      fail('Mihomo controller must be a local HTTP loopback endpoint')
    const config = this.config(state)
    let res
    try {
      res = await this.fetch(`${this.controller}/configs?force=true`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: JSON.stringify(config) }),
        signal: AbortSignal.timeout(20000),
      })
    } catch {
      fail('Cannot reach the Mihomo controller; previous subscription was not changed')
    }
    // Do not echo Mihomo's body: validation errors can include node credentials.
    if (!res.ok) fail(`Mihomo rejected the configuration (HTTP ${res.status}); check supported node options`)
    return config
  }

  async restore() {
    if (this.state.sources.length) {
      await this.apply(this.state)
      this.syncPool()
    }
  }

  // Reconcile persisted source state after import/restart, without changing existing IDs or bindings.
  syncPool(previous) {
    const records = this.state.sources.flatMap((s) =>
      s.nodes.map((n) => ({ host: this.host, port: n.port, username: n.username, password: n.password })),
    )
    const result = this.proxyPool.importParsed(records)
    let changed = false
    for (const source of this.state.sources) {
      for (const node of source.nodes) {
        const row = this.proxyPool.state.proxies.find(
          (p) => p.host === this.host && p.port === node.port && p.username === node.username,
        )
        if (!row) continue
        const label = `${source.name} / ${node.proxy.name}`.slice(0, 64)
        if (row.label !== label) {
          row.label = label
          changed = true
        }
        if (node.retired && row.enabled) this.proxyPool.setEnabled(row.id, false)
        // Only auto-enable nodes previously retired by this subscription, not manually disabled ones.
        if (
          !node.retired &&
          previous?.nodes.some((n) => n.key === node.key && n.retired && n.resume_enabled !== false) &&
          !row.enabled
        )
          this.proxyPool.setEnabled(row.id, true)
      }
    }
    if (changed) this.proxyPool.save()
    return result
  }

  async import({ name, url, yaml } = {}) {
    if (this.busy) fail('Another Clash import is in progress')
    if (!this.controller || !this.secret) fail('Enable the Mihomo sidecar first')
    name = typeof name === 'string' ? name.trim() : ''
    if (!name || name.length > 80) fail('Subscription name is required (at most 80 characters)')
    if (!!url === !!yaml) fail('Provide either a subscription URL or YAML, not both')
    this.busy = true
    try {
      const { proxies, skipped } = parseClash(url ? await this.download(url) : yaml)
      const previous = this.state.sources.find((s) => s.name === name)
      const source = { id: previous?.id || crypto.randomUUID(), name, updated_at: new Date().toISOString(), nodes: [] }
      const used = new Set(this.state.sources.flatMap((s) => s.nodes.map((n) => n.port)))
      for (const proxy of proxies) {
        const old = previous?.nodes.find((n) => n.proxy.name === proxy.name)
        let port = old?.port
        if (!port) {
          port = this.portStart
          while (used.has(port)) port++
          if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('Clash listener port range exhausted')
          used.add(port)
        }
        source.nodes.push({
          key: old?.key || `clash-${crypto.randomUUID()}`,
          port,
          username: old?.username || crypto.randomBytes(12).toString('hex'),
          password: old?.password || crypto.randomBytes(24).toString('hex'),
          retired: false,
          proxy,
        })
      }
      // Missing nodes are retained, not silently replaced: bound slots must never switch exits.
      const retired = previous?.nodes.filter((n) => !proxies.some((p) => p.name === n.proxy.name)) || []
      source.nodes.push(
        ...retired.map((n) => ({
          ...n,
          retired: true,
          resume_enabled: n.retired
            ? n.resume_enabled
            : this.proxyPool.state.proxies.find(
                (p) => p.host === this.host && p.port === n.port && p.username === n.username,
              )?.enabled !== false,
        })),
      )
      const next = { version: 1, sources: [...this.state.sources.filter((s) => s.name !== name), source] }
      const config = await this.apply(next)
      try {
        atomicWrite(path.join(this.dir, 'config.yaml'), config)
        atomicWrite(path.join(this.dir, 'subscriptions.json'), next)
      } catch {
        await this.apply(this.state).catch(() => {})
        fail('Cannot persist Clash state; check data directory permissions')
      }
      this.state = next
      const result = this.syncPool(previous)
      return {
        added: result.added,
        updated: proxies.length - result.added,
        retained_disabled: retired.length,
        skipped,
        source: { id: source.id, name: source.name, nodes: proxies.length },
      }
    } finally {
      this.busy = false
    }
  }
}
