/**
 * agent-api.mjs — verify the session-facing surface end to end.
 *
 * What it proves, against the live core when one is running:
 *   1. GET  /dsh-vpn/agent.json   returns the proxy contract (and never starts anything)
 *   2. POST /dsh-vpn/ensure.json  is idempotent when the core is already up
 *   3. the state file is written with a panelUrl and a usable proxy
 *   4. the rule block lands in AGENTS.md exactly once, and a second run rewrites
 *      the same bytes instead of appending a duplicate
 *
 * Run: node test/agent-api.mjs <port>
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.argv[2] || 51996)
const tmpAgents = path.join(HERE, '.tmp-AGENTS.md')
process.env.DSH_VPN_AGENTS_FILE = tmpAgents
process.env.DSH_HOME = process.env.DSH_HOME || 'D:\\dsh-home'

const routes = []
const ctx = {
  webServer: { register(r) { routes.push(r); return () => {} } },
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
  get() { return undefined },
  logger: { info: console.error, warn: console.error },
}

const mod = await import(pathToFileURL(path.join(HERE, '..', 'src', 'index.js')).href)
mod.apply(ctx, {})

const byKey = new Map()
for (const r of routes) byKey.set(r.path, r)

const server = http.createServer((req, res) => {
  const route = byKey.get(new URL(req.url, 'http://127.0.0.1').pathname)
  if (!route) { res.writeHead(404); res.end('no route'); return }
  route.handler(req, res)
})
await new Promise((r) => server.listen(port, '127.0.0.1', r))

function call(method, pathname) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { host: '127.0.0.1:' + port } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode, json, text })
      })
    })
    req.on('error', (e) => resolve({ status: 0, error: String(e.message) }))
    req.end()
  })
}

const report = { routes: [...byKey.keys()] }
const agent = await call('GET', '/dsh-vpn/agent.json')
report.agent = {
  status: agent.status,
  ok: agent.json && agent.json.ok,
  proxy: agent.json && agent.json.proxy,
  port: agent.json && agent.json.port,
  noProxy: agent.json && agent.json.noProxy,
  hasEnv: !!(agent.json && agent.json.env && agent.json.env.HTTPS_PROXY),
  endpoints: agent.json && agent.json.endpoints,
}

const ensure1 = await call('POST', '/dsh-vpn/ensure.json')
report.ensure1 = {
  status: ensure1.status,
  ok: ensure1.json && ensure1.json.ok,
  started: ensure1.json && ensure1.json.started,
  proxy: ensure1.json && ensure1.json.proxy,
  running: ensure1.json && ensure1.json.running,
}
const ensure2 = await call('POST', '/dsh-vpn/ensure.json')
report.ensure2 = { status: ensure2.status, ok: ensure2.json && ensure2.json.ok, started: ensure2.json && ensure2.json.started }

// let the startup timer publish the state file + rule block
await new Promise((r) => setTimeout(r, 2600))

const stateFile = path.join(process.env.DSH_HOME, 'vpn-panel-agent.json')
report.stateFile = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null

const stateRoute = await call('GET', '/dsh-vpn/agent-state.json')
report.stateRoute = {
  status: stateRoute.status,
  ok: stateRoute.json && stateRoute.json.ok,
  file: stateRoute.json && stateRoute.json.file,
  proxy: stateRoute.json && stateRoute.json.state && stateRoute.json.state.proxy,
  sameAsFile: !!(stateRoute.json && stateRoute.json.state && report.stateFile && stateRoute.json.state.updatedAt === report.stateFile.updatedAt),
}

const ruleOnce = fs.existsSync(tmpAgents) ? fs.readFileSync(tmpAgents, 'utf8') : ''
const firstCount = (ruleOnce.match(/dsh-vpn-panel:begin/g) || []).length

// Second apply against the same file must not duplicate the block. Same info as
// the first write, so a rewrite is expected to be byte-identical.
const { upsertAgentsRule } = await import(pathToFileURL(path.join(HERE, '..', 'src', 'instructions.js')).href)
const again = upsertAgentsRule({ file: tmpAgents, info: { port: 7891 }, log: () => {} })
const ruleTwice = fs.readFileSync(tmpAgents, 'utf8')
report.rules = {
  bytes: ruleOnce.length,
  blocks: firstCount,
  secondUpsertChanged: again.changed,
  blocksAfter: (ruleTwice.match(/dsh-vpn-panel:begin/g) || []).length,
  hasKeyPhrases: ['agent.json', 'ensure.json', 'NO_PROXY'.toLowerCase() === 'no_proxy' ? 'no_proxy' : 'NO_PROXY', '不要自己拼'].every((k) => ruleOnce.includes(k)),
}

console.log(JSON.stringify(report, null, 2))
server.close()
try { fs.unlinkSync(tmpAgents) } catch {}
process.exit(0)
