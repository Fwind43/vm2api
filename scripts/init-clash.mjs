import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function initClash({ dataDir, secret, controller = 'http://127.0.0.1:19090' }) {
  if (!secret || secret.length < 24)
    throw new Error('Set VM2API_CLASH_SECRET to a random value of at least 24 characters')
  const endpoint = new URL(controller)
  if (
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('Use a local loopback HTTP controller URL, for example http://127.0.0.1:19090')
  }
  const dir = path.join(dataDir, 'clash')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'config.yaml')
  const config = {
    'external-controller': endpoint.host,
    secret,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'warning',
    'geo-auto-update': false,
    rules: ['MATCH,REJECT'],
  }
  try {
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    return { created: true }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    // Never overwrite a live/persisted subscription configuration.
    return { created: false }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = initClash({
    dataDir: process.env.KIN_DATA_DIR || path.resolve('data'),
    secret: process.env.VM2API_CLASH_SECRET,
    controller: process.env.VM2API_CLASH_CONTROLLER,
  })
  console.log(
    result.created ? 'Created initial Mihomo config (no subscription nodes).' : 'Existing Mihomo config preserved.',
  )
}
