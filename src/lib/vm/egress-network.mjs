import { createHash } from 'node:crypto'

const POOL_EXHAUSTED = /all predefined address pools have been fully subnetted|could not find an available, non-overlapping IPv4 address pool among the defaults/i
const OVERLAP = /pool overlaps with other one on this address space|invalid pool request.*overlap/i
const MAX_CREATE_ATTEMPTS = 4

function ipv4Range(cidr) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(String(cidr))
  if (!match) throw new Error(`invalid IPv4 range: ${cidr}`)
  const octets = match.slice(1, 5).map(Number)
  const prefix = match[5] === undefined ? 32 : Number(match[5])
  if (octets.some((n) => n > 255) || prefix > 32) throw new Error(`invalid IPv4 range: ${cidr}`)
  const address = octets.reduce((n, octet) => n * 256 + octet, 0)
  const size = 2 ** (32 - prefix)
  const start = Math.floor(address / size) * size
  return [start, start + size - 1]
}

function readArray(result, label) {
  if (!result.ok) throw new Error(`${label}: ${result.stderr || 'command failed'}`)
  let rows
  try {
    rows = JSON.parse(result.stdout)
  } catch {
    throw new Error(`${label}: invalid JSON`)
  }
  if (!Array.isArray(rows)) throw new Error(`${label}: expected an array`)
  return rows
}

function occupiedRanges(runDocker, runIp) {
  const listed = runDocker(['network', 'ls', '-q'])
  if (!listed.ok) throw new Error(`docker network inventory: ${listed.stderr || 'command failed'}`)
  const ids = String(listed.stdout || '').trim().split(/\s+/).filter(Boolean)
  if (!ids.length || ids.some((id) => !/^[a-f\d]{12,64}$/i.test(id))) {
    throw new Error('docker network inventory: missing or invalid network IDs')
  }
  const networks = readArray(runDocker(['network', 'inspect', ...ids]), 'docker network inventory')
  if (networks.length !== ids.length) throw new Error('docker network inventory: incomplete inspection')
  const ranges = []
  const add = (cidr) => {
    if (typeof cidr !== 'string' || !cidr) throw new Error('network inventory: missing CIDR')
    if (!cidr.includes(':')) ranges.push(ipv4Range(cidr))
  }
  for (const network of networks) {
    if (!network.IPAM || (network.IPAM.Config != null && !Array.isArray(network.IPAM.Config))) {
      throw new Error('docker network inventory: invalid IPAM configuration')
    }
    for (const config of network.IPAM.Config || []) add(config.Subnet)
  }
  // Docker allocation does not account for every host/VPN route. Read all tables,
  // not just main, and include interface prefixes even if no route was installed.
  const routes = readArray(runIp(['-j', '-4', 'route', 'show', 'table', 'all']), 'host IPv4 routes')
  for (const route of routes) {
    if (route.dst === 'default' || route.dst === '0.0.0.0/0') continue
    add(route.dst)
  }
  const addresses = readArray(runIp(['-j', '-4', 'address', 'show']), 'host IPv4 addresses')
  for (const iface of addresses) {
    if (!Array.isArray(iface.addr_info)) throw new Error('host IPv4 addresses: missing addr_info')
    for (const address of iface.addr_info) {
      if (address.family !== 'inet') continue
      if (!Number.isInteger(address.prefixlen)) throw new Error('host IPv4 addresses: invalid prefix')
      add(`${address.local}/${address.prefixlen}`)
    }
  }
  if (!addresses.length) throw new Error('host IPv4 addresses: empty inventory')
  return ranges
}

function selectSubnet(name, ranges) {
  // A bounded /16-sized reserve, split into /24s. No daemon configuration changes
  // or pruning of old networks. Hashing spreads concurrent allocations; Docker's
  // overlap check remains authoritative if another creator wins the race.
  const offset = createHash('sha256').update(name).digest().readUInt16BE(0) % 256
  for (let i = 0; i < 256; i++) {
    const subnet = `10.203.${(offset + i) % 256}.0/24`
    const [start, end] = ipv4Range(subnet)
    if (ranges.every(([a, b]) => end < a || start > b)) {
      return { subnet, gateway: subnet.replace('.0/24', '.1') }
    }
  }
  throw new Error('no non-overlapping /24 remains in egress fallback reserve 10.203.0.0/16')
}

/**
 * Keep Docker's normal allocation path. Only its specific default-pool exhaustion
 * error enables explicit, collision-checked fallback. Other failures are returned
 * untouched. Never delete networks, restart Docker, or bypass egress isolation.
 */
export function createEgressBridge(name, bridge, { masquerade, runDocker, runIp }) {
  const base = [
    'network', 'create', '--ipv6=false',
    '--opt', `com.docker.network.bridge.name=${bridge}`,
    '--opt', `com.docker.network.bridge.enable_ip_masquerade=${masquerade}`,
    '--opt', 'com.docker.network.bridge.enable_icc=false',
  ]
  const first = runDocker([...base, name])
  if (first.ok || !POOL_EXHAUSTED.test(`${first.stderr || ''}\n${first.stdout || ''}`)) return first
  let last = first
  try {
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
      const { subnet, gateway } = selectSubnet(name, occupiedRanges(runDocker, runIp))
      last = runDocker([...base, '--subnet', subnet, '--gateway', gateway, name])
      if (last.ok || !OVERLAP.test(`${last.stderr || ''}\n${last.stdout || ''}`)) return last
    }
    return { ...last, ok: false, stderr: `egress subnet allocation raced ${MAX_CREATE_ATTEMPTS} times: ${last.stderr || ''}` }
  } catch (error) {
    return { ok: false, stderr: `egress address-pool fallback refused: ${error.message}; original: ${first.stderr || first.stdout || ''}` }
  }
}
