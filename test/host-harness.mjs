/**
 * Offline harness for dsh-vpn-panel's host half.
 *
 * Loads the plugin with a mock cordis context, mounts every route it registers
 * on a plain HTTP server, and exercises them against the live mihomo process 鈥? * this is how the plugin gets verified without restarting DSH.
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const pluginPath = process.argv[2] || path.join(HERE, '..', 'src', 'index.js')
const port = Number(process.argv[3] || 51999)

const routes = []
const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  effect(fn) {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  get() {
    return undefined
  },
  logger: { info: console.error, warn: console.error },
}

const mod = await import(pathToFileURL(path.resolve(pluginPath)).href)
console.log('exports:', Object.keys(mod).join(','), '| inject:', JSON.stringify(mod.inject))
mod.apply(ctx, {})

const byKey = new Map()
for (const r of routes) byKey.set(r.path, r)
console.log('routes:', [...byKey.keys()].join(' '))

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = byKey.get(url.pathname)
  if (!route) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('no route')
    return
  }
  route.handler(req, res)
})

function call(method, pathname) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: { host: '127.0.0.1:' + port } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {}
          resolve({ status: res.statusCode, json, text })
        })
      },
    )
    req.on('error', (e) => resolve({ status: 0, error: String(e.message) }))
    req.end()
  })
}

await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))

const report = {}
const status = await call('GET', '/dsh-vpn/status.json')
report.status = status.json || status
const nodes = await call('GET', '/dsh-vpn/nodes.json')
report.nodes = nodes.json
  ? { ok: nodes.json.ok, group: nodes.json.group, now: nodes.json.now, listCount: (nodes.json.list || []).length }
  : nodes
const speed = await call('GET', '/dsh-vpn/speed.json')
report.speed = speed.json || speed
const settings = await call('GET', '/dsh-vpn/settings.json')
report.settings = settings.json || settings
const methodGuard = await call('POST', '/dsh-vpn/status.json')
report.methodGuard = { status: methodGuard.status, body: methodGuard.json || methodGuard.text }
const crossSite = await new Promise((resolve) => {
  const req = http.request(
    { host: '127.0.0.1', port, method: 'GET', path: '/dsh-vpn/status.json', headers: { host: '127.0.0.1:' + port, origin: 'http://evil.example' } },
    (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
    },
  )
  req.on('error', (e) => resolve({ status: 0, error: String(e.message) }))
  req.end()
})
report.crossOriginGuard = crossSite

console.log(JSON.stringify(report, null, 2))
server.close()
process.exit(0)
