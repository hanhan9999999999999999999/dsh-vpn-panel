/**
 * dsh-vpn-panel — host half.
 *
 * Serves a tiny JSON API under /dsh-vpn/* that drives the local mihomo based
 * free-VPN stack (D:\document\vpn by default) and is consumed by the client
 * bundle's Settings section:
 *
 *   GET  /dsh-vpn/status.json     runtime state (port listening, system proxy, current node)
 *   POST /dsh-vpn/power.json      { on: true|false }  → vpn-on.ps1 / vpn-off.ps1
 *   GET  /dsh-vpn/nodes.json      groups + node list from the mihomo controller
 *   POST /dsh-vpn/select.json     { name } → pin a node in the select group
 *   GET  /dsh-vpn/delay.json      latency probe for a node subset
 *   GET  /dsh-vpn/speed.json      real download throughput through the proxy
 *   POST /dsh-vpn/refresh.json    pull subscriptions + rebuild config + restart
 *   GET  /dsh-vpn/settings.json   panel settings (ports, scripts dir, autostart)
 *   POST /dsh-vpn/settings.json   write panel settings
 *
 * Everything is loopback-only: the routes exist for the desktop/web client that
 * runs on this machine, and writes are refused for cross-site or foreign hosts.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'

export const name = 'vpn-panel'
export const inject = ['webServer']

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SETTINGS_FILE = path.join(DSH_HOME, 'vpn-panel.json')

const DEFAULTS = {
  scriptsDir: 'D:\\document\\vpn',
  proxyPort: 7891,
  controllerPort: 9090,
  // Opens the VPN when DSH starts and closes it when DSH exits. This is not an
  // OS autostart: nothing is registered to run at boot.
  autoStart: true,
  testUrl: 'http://speed.cloudflare.com/__down?bytes=5000000',
}

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  } catch {
    return { ...DEFAULTS }
  }
}

function coercePort(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  // A port outside 1..65535 gets persisted, then net/http throws ERR_SOCKET_BAD_PORT
  // on every later status poll — the panel locks itself out with no way back from the UI.
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${label} 必须是 1..65535 的整数（收到 ${JSON.stringify(value)}）`)
  }
  return n
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...(patch || {}) }
  // Only known keys, and only sane types — the file is read on every request.
  let clean
  try {
    clean = {
      scriptsDir: String(next.scriptsDir || DEFAULTS.scriptsDir),
      proxyPort: coercePort(next.proxyPort, DEFAULTS.proxyPort, 'proxyPort'),
      controllerPort: coercePort(next.controllerPort, DEFAULTS.controllerPort, 'controllerPort'),
      autoStart: next.autoStart === true,
      testUrl: String(next.testUrl || DEFAULTS.testUrl),
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(clean, null, 2), 'utf8')
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  return { ok: true, settings: clean }
}

function isLoopbackHostname(input) {
  const h = String(input || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  return !!m && Number(m[1]) === 127 && [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

function requestRejection(req) {
  try {
    const headers = (req && req.headers) || {}
    let host = null
    try {
      host = new URL('http://' + String(headers.host || ''))
    } catch {
      return 403
    }
    if (!isLoopbackHostname(host.hostname)) return 403
    const site = String(headers['sec-fetch-site'] || '').toLowerCase()
    // same-site = another port/host under the same registrable domain; the panel
    // is loopback-only, so anything that is not same-origin is a foreign caller.
    if (site === 'cross-site' || site === 'same-site') return 403
    const origin = headers.origin
    if (typeof origin === 'string' && origin) {
      // `Origin: null` is what file:// pages and sandboxed iframes send. Treating it
      // as "no origin header" let any local HTML file drive power/settings.
      if (origin === 'null') return 403
      try {
        if (new URL(origin).host.toLowerCase() !== host.host.toLowerCase()) return 403
      } catch {
        return 403
      }
    }
    return null
  } catch {
    return 403
  }
}

function sendJson(res, code, body) {
  try {
    const text = JSON.stringify(body)
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(text)
  } catch {
    try {
      res.statusCode = 500
      res.end()
    } catch {}
  }
}

const BODY_TOO_LARGE = Symbol('body-too-large')

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        // Drain instead of destroying the socket: a destroyed socket answers with
        // "socket hang up", so the client shows a network error instead of a status.
        chunks.length = 0
        req.removeAllListeners('data')
        req.resume()
        resolve(BODY_TOO_LARGE)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function portOpen(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {}
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    try {
      socket.connect(port, host)
    } catch {
      finish(false)
    }
  })
}

function controllerRequest(conf, method, apiPath, body, timeout = 4000) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(
      {
        host: '127.0.0.1',
        port: conf.controllerPort,
        method,
        path: apiPath,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : undefined,
        timeout,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            json = null
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, code: res.statusCode, json, text })
        })
      },
    )
    req.on('timeout', () => {
      try {
        req.destroy()
      } catch {}
      resolve({ ok: false, code: 0, json: null, text: 'timeout' })
    })
    req.on('error', (err) => resolve({ ok: false, code: 0, json: null, text: String(err.message || err) }))
    if (payload) req.write(payload)
    req.end()
  })
}

const state = {
  busy: null, // 'on' | 'off' | 'refresh'
  lastLog: '',
  lastError: '',
  lastActionAt: 0,
}

/* ── lifetime: leave nothing behind when DSH goes away ──────────────────
 *
 * vpn-on.ps1 starts mihomo with Start-Process (a detached, reparented process)
 * and writes two persistent values into the user's registry:
 *
 *   ProxyEnable = 1                 ← survives every reboot
 *   ProxyServer = 127.0.0.1:7891    ← survives every reboot
 *
 * Killing mihomo does not clear them. After a shutdown or a crashed DSH the
 * machine boots with the system proxy still pointed at a port nothing listens
 * on, and every app that honours the system proxy has no network — which looks
 * exactly like "the internet is broken", not like "a VPN was left running".
 * So the panel has to undo them itself, both on a clean exit and on the next
 * start (in case the previous exit never ran).
 */

const PROXY_REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

function regRunSync(args) {
  try {
    const res = spawnSync('reg.exe', args, { windowsHide: true, timeout: 3000, encoding: 'utf8' })
    return { ok: res.status === 0, out: String(res.stdout || '') }
  } catch {
    return { ok: false, out: '' }
  }
}

/** ProxyEnable on the current user. Reads the live registry, not a cached copy. */
function systemProxyEnabledSync() {
  const { out } = regRunSync(['query', PROXY_REG, '/v', 'ProxyEnable'])
  return /\b0x1\b|\b1\b/.test(out.split('ProxyEnable').pop() || '')
}

function systemProxyServerSync() {
  const { out } = regRunSync(['query', PROXY_REG, '/v', 'ProxyServer'])
  const tail = out.split('ProxyServer').pop() || ''
  const m = /REG_SZ\s+(\S+)/.exec(tail)
  return m ? m[1].trim() : ''
}

/**
 * Point the system proxy back at "off", synchronously.
 * Must be synchronous: on exit this is the last code that runs, and an async
 * child never gets to finish. Registry writes take single-digit milliseconds.
 */
function restoreProxySync() {
  regRunSync(['add', PROXY_REG, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'])
  for (const value of ['ProxyServer', 'ProxyOverride', 'AutoConfigURL']) {
    regRunSync(['delete', PROXY_REG, '/v', value, '/f'])
  }
}

/** Only undo the proxy if it is *this* panel's proxy — never a user's own. */
function restoreProxyIfOursSync(conf) {
  const server = systemProxyServerSync()
  const ours = server === `127.0.0.1:${conf.proxyPort}` || server.endsWith(`:${conf.proxyPort}`)
  if (!ours) return false
  restoreProxySync()
  return true
}

function killCoreSync() {
  try {
    spawnSync('taskkill', ['/F', '/T', '/IM', 'mihomo.exe'], { windowsHide: true, timeout: 5000 })
  } catch {}
}


function runPowerShell(scriptPath, args = [], timeoutMs = 60000) {
  return new Promise((resolve) => {
    const exists = (() => {
      try {
        return fs.existsSync(scriptPath)
      } catch {
        return false
      }
    })()
    if (!exists) return resolve({ ok: false, code: -1, out: '', err: `script not found: ${scriptPath}` })
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { windowsHide: true },
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.stderr.on('data', (d) => {
      err += d.toString()
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, code: -1, out, err: String(e.message || e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, out, err })
    })
  })
}

function readRegValue(keyPath, valueName) {
  return new Promise((resolve) => {
    const child = spawn('reg.exe', ['query', keyPath, '/v', valueName], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const m = new RegExp(valueName + '\\s+(REG_\\w+)\\s+(.+)', 'i').exec(out)
      if (!m) return resolve(null)
      let value = m[2].trim()
      // reg.exe prints DWORDs as 0x1 — normalise so callers can compare numbers.
      if (/^0x[0-9a-f]+$/i.test(value)) value = String(parseInt(value, 16))
      resolve(value)
    })
  })
}

async function collectStatus(conf) {
  const listening = await portOpen(conf.proxyPort)
  const proxyEnable = await readRegValue(
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    'ProxyEnable',
  )
  const proxyServer = await readRegValue(
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    'ProxyServer',
  )
  let group = null
  let node = null
  let nodeCount = 0
  if (listening) {
    const res = await controllerRequest(conf, 'GET', '/proxies')
    if (res.ok && res.json && res.json.proxies) {
      const proxies = res.json.proxies
      const select = proxies['手动切换']
      const auto = proxies['自动选择']
      const target = select || auto
      if (target) {
        group = select ? '手动切换' : '自动选择'
        node = target.now || null
        nodeCount = Array.isArray(target.all) ? target.all.length : 0
      } else {
        nodeCount = Object.keys(proxies).length
      }
    }
  }
  return {
    running: listening,
    proxyPort: conf.proxyPort,
    controllerPort: conf.controllerPort,
    scriptsDir: conf.scriptsDir,
    systemProxy: String(proxyEnable) === '1',
    proxyServer: proxyServer || '',
    group,
    node,
    nodeCount,
    busy: state.busy,
    lastLog: state.lastLog.slice(-4000),
    lastError: state.lastError,
    lastActionAt: state.lastActionAt,
    settings: conf,
    time: Date.now(),
  }
}

/**
 * Real throughput through the local mixed proxy: plain HTTP GET (no CONNECT),
 * 6 seconds of streaming after the first byte, hard stop at 20 s overall.
 * Throughput is measured from the first byte, so slow DNS/connect does not
 * masquerade as a slow link.
 */
function speedThroughProxy(conf, url) {
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(url)
    } catch {
      return resolve({ ok: false, error: 'bad testUrl' })
    }
    if (target.protocol !== 'http:') return resolve({ ok: false, error: 'testUrl must be http://' })
    const started = Date.now()
    let firstByteAt = null
    let bytes = 0
    let done = false
    let guard = null
    const finish = (extra) => {
      if (done) return
      done = true
      if (guard) clearTimeout(guard)
      const span = firstByteAt ? (Date.now() - firstByteAt) / 1000 : (Date.now() - started) / 1000
      const seconds = Math.max(0.05, span)
      resolve({
        ok: bytes > 0,
        bytes,
        seconds: Number(seconds.toFixed(2)),
        kbps: Math.round(bytes / 1024 / seconds),
        ...extra,
      })
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port: conf.proxyPort,
        method: 'GET',
        path: url,
        headers: { host: target.host, 'user-agent': 'dsh-vpn-panel', connection: 'close' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          try {
            res.destroy()
          } catch {}
          return finish({ ok: false, error: 'http ' + res.statusCode })
        }
        res.on('data', (chunk) => {
          if (firstByteAt === null) firstByteAt = Date.now()
          bytes += chunk.length
          if (Date.now() - firstByteAt > 6000) {
            try {
              req.destroy()
            } catch {}
            finish({})
          }
        })
        res.on('end', () => finish({}))
        res.on('error', () => finish({ partial: true }))
      },
    )
    guard = setTimeout(() => {
      try {
        req.destroy()
      } catch {}
      finish({ ok: false, error: 'timeout' })
    }, 20000)
    req.on('error', (err) => {
      if (bytes > 0) finish({ partial: true })
      else finish({ ok: false, error: String(err.message || err) })
    })
    req.end()
  })
}

export function apply(ctx) {
  const disposers = []
  let conf = readSettings()
  let startupTimer = null
  let shutDown = false

  /**
   * Tear the VPN down on the way out: kill the core, then put the system proxy
   * back. Registry first would leave a window where apps still point at a dying
   * port; killing first means "not listening" is already true when the proxy
   * settings change, which is the state apps recover from cleanly.
   */
  const stopVpnForExit = () => {
    if (shutDown) return
    shutDown = true
    state.busy = null
    killCoreSync()
    restoreProxyIfOursSync(conf)
    // Flush the WinINet connection cache so already-running apps drop the dead
    // proxy immediately instead of after a reconnect timeout.
    //
    // This must be synchronous, and must NOT be detached. A detached Windows
    // child starts without a console; PowerShell in that state exits 0 and
    // never executes -File (verified side by side: identical arguments
    // non-detached write the log, detached leave it empty). Synchronous is also
    // the only safe form inside process.on('exit'). Bounded so a wedged script
    // cannot hold the shutdown open.
    try {
      const offScript = path.join(conf.scriptsDir, 'vpn-off.ps1')
      if (fs.existsSync(offScript)) {
        spawnSync(
          'powershell.exe',
          ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', offScript],
          { timeout: 10000, windowsHide: true, stdio: 'ignore' },
        )
      }
    } catch {}
  }

  // Backstop for exits that skip module disposal (window closed, process
  // terminated). process.on('exit') can still run spawnSync, which is why the
  // registry repair above is synchronous.
  try {
    process.on('exit', stopVpnForExit)
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stopVpnForExit)
  } catch {}


  const route = (apiPath, method, handler) =>
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: apiPath,
        handler: async (req, res) => {
          const deny = requestRejection(req)
          if (deny !== null) return sendJson(res, deny, { ok: false, error: 'forbidden' })
          const wanted = String(req.method || 'GET').toUpperCase()
          if (wanted !== method) return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          try {
            const body = method === 'POST' ? await readBody(req) : null
            if (body === BODY_TOO_LARGE) return sendJson(res, 413, { ok: false, error: 'body too large' })
            if (method === 'POST' && body === null) return sendJson(res, 400, { ok: false, error: 'bad json' })
            const result = await handler(req, body)
            // NOTE: several routes carry a payload field literally named `status`
            // (power/refresh/settings/save). Reading it as the HTTP code made
            // res.statusCode an object, writeHead() threw, and every one of those
            // routes answered 500 with an empty body while the action had already
            // run. Use an explicit numeric field instead.
            const code = result && Number.isInteger(result.httpStatus) ? result.httpStatus : 200
            sendJson(res, code, result && result.body ? result.body : result)
          } catch (err) {
            state.lastError = String((err && err.stack) || err)
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          }
        },
      }),
    )

  route('/dsh-vpn/status.json', 'GET', async () => collectStatus(conf))

  route('/dsh-vpn/power.json', 'POST', async (req, body) => {
    const on = body && body.on === true
    if (state.busy) return { ok: false, error: `busy: ${state.busy}`, status: await collectStatus(conf) }
    state.busy = on ? 'on' : 'off'
    state.lastError = ''
    try {
      const script = path.join(conf.scriptsDir, on ? 'vpn-on.ps1' : 'vpn-off.ps1')
      const res = await runPowerShell(script, [], 90000)
      state.lastLog = (res.out || '') + (res.err ? '\n[stderr]\n' + res.err : '')
      state.lastActionAt = Date.now()
      if (!res.ok) state.lastError = (res.err || res.out || `exit ${res.code}`).slice(-2000)
      const status = await collectStatus(conf)
      return { ok: res.ok, action: on ? 'on' : 'off', status, log: state.lastLog.slice(-3000) }
    } finally {
      state.busy = null
    }
  })

  route('/dsh-vpn/nodes.json', 'GET', async () => {
    if (!(await portOpen(conf.proxyPort))) return { ok: false, error: 'proxy not running' }
    const res = await controllerRequest(conf, 'GET', '/proxies')
    if (!res.ok || !res.json) return { ok: false, error: res.text || 'controller error' }
    const proxies = res.json.proxies || {}
    const groups = []
    const nodes = []
    for (const [key, value] of Object.entries(proxies)) {
      if (!value || typeof value !== 'object') continue
      if (value.type === 'Selector' || value.type === 'URLTest' || value.type === 'Fallback') {
        groups.push({ name: key, type: value.type, now: value.now || null, all: value.all || [] })
      } else if (value.type && !['Direct', 'Reject', 'Pass', 'Compatible'].includes(value.type)) {
        const history = Array.isArray(value.history) ? value.history : []
        const last = history.length ? history[history.length - 1] : null
        nodes.push({ name: key, type: value.type, delay: last ? last.delay : null })
      }
    }
    const preferred = groups.find((g) => g.name === '手动切换') || groups.find((g) => g.name === '自动选择') || groups[0]
    return {
      ok: true,
      groups,
      nodes,
      group: preferred ? preferred.name : null,
      now: preferred ? preferred.now : null,
      list: preferred ? preferred.all : nodes.map((n) => n.name),
    }
  })

  route('/dsh-vpn/select.json', 'POST', async (req, body) => {
    const nodeName = body && typeof body.name === 'string' ? body.name : ''
    if (!nodeName) return { ok: false, error: 'name required' }
    if (!(await portOpen(conf.proxyPort))) return { ok: false, error: 'proxy not running' }
    const res = await controllerRequest(conf, 'GET', '/proxies')
    const proxies = (res.json && res.json.proxies) || {}
    const groupName = proxies['手动切换'] ? '手动切换' : proxies['自动选择'] ? '自动选择' : null
    if (!groupName) return { ok: false, error: 'no selectable group' }
    const put = await controllerRequest(
      conf,
      'PUT',
      '/proxies/' + encodeURIComponent(groupName),
      { name: nodeName },
    )
    return { ok: put.ok, code: put.code, group: groupName, name: nodeName, error: put.ok ? undefined : put.text }
  })

  route('/dsh-vpn/delay.json', 'GET', async (req) => {
    if (!(await portOpen(conf.proxyPort))) return { ok: false, error: 'proxy not running' }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    // Node names routinely contain commas ("日本 01, 大阪"), so a comma-joined list
    // splits real nodes in half. Prefer repeated ?name= params; keep `names` for
    // backward compatibility only.
    const repeated = url.searchParams.getAll('name').map((s) => s.trim()).filter(Boolean)
    const wanted = (repeated.length
      ? repeated
      : String(url.searchParams.get('names') || '').split(',').map((s) => s.trim())
    )
      .filter(Boolean)
      .slice(0, 60)
    if (!wanted.length) return { ok: false, error: 'names required' }
    const probeUrl = 'http://www.gstatic.com/generate_204'
    const results = []
    const queue = [...wanted]
    const worker = async () => {
      while (queue.length) {
        const nodeName = queue.shift()
        const started = Date.now()
        const res = await controllerRequest(
          conf,
          'GET',
          `/proxies/${encodeURIComponent(nodeName)}/delay?url=${encodeURIComponent(probeUrl)}&timeout=3000`,
          undefined,
          5000,
        )
        const ms = res.ok && res.json && typeof res.json.delay === 'number' ? res.json.delay : null
        results.push({ name: nodeName, delay: ms, elapsed: Date.now() - started })
      }
    }
    await Promise.all(Array.from({ length: 8 }, worker))
    results.sort((a, b) => (a.delay === null ? 99999 : a.delay) - (b.delay === null ? 99999 : b.delay))
    return { ok: true, results }
  })

  route('/dsh-vpn/speed.json', 'GET', async () => {
    if (!(await portOpen(conf.proxyPort))) return { ok: false, error: 'proxy not running' }
    const result = await speedThroughProxy(conf, conf.testUrl)
    return result
  })

  route('/dsh-vpn/refresh.json', 'POST', async () => {
    if (state.busy) return { ok: false, error: `busy: ${state.busy}` }
    state.busy = 'refresh'
    state.lastError = ''
    try {
      const res = await runPowerShell(path.join(conf.scriptsDir, 'vpn-refresh.ps1'), [], 20 * 60 * 1000)
      state.lastLog = (res.out || '') + (res.err ? '\n[stderr]\n' + res.err : '')
      state.lastActionAt = Date.now()
      if (!res.ok) state.lastError = (res.err || res.out || `exit ${res.code}`).slice(-2000)
      return { ok: res.ok, log: state.lastLog.slice(-6000), status: await collectStatus(conf) }
    } finally {
      state.busy = null
    }
  })

  route('/dsh-vpn/settings.json', 'GET', async () => ({ ok: true, settings: conf }))

  // A separate path on purpose: two handler registrations on one exact path are
  // order-dependent in the host router, so GET /settings.json must stay unique.
  route('/dsh-vpn/settings/save.json', 'POST', async (req, body) => {
    const saved = writeSettings(body || {})
    if (!saved.ok) return { ok: false, error: saved.error, httpStatus: 400 }
    conf = readSettings()
    // `autoStart` means "open the VPN when DSH starts", NOT "start with Windows".
    // The old build wrote a Run-key entry for it, which brought the proxy up on
    // boot while DSH was closed — the one state that leaves a machine offline.
    // Anything left by that build is removed here.
    if (body && typeof body.autoStart === 'boolean') {
      await new Promise((resolve) => {
        const child = spawn(
          'reg.exe',
          ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'DSHVpn', '/f'],
          { windowsHide: true },
        )
        child.on('close', () => resolve())
        child.on('error', () => resolve())
      })
    }
    return { ok: true, settings: conf, status: await collectStatus(conf) }
  })

  const disposeAll = () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {}
    }
    disposers.length = 0
    if (startupTimer) clearTimeout(startupTimer)
    try {
      process.removeListener('exit', stopVpnForExit)
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, stopVpnForExit)
    } catch {}
    stopVpnForExit()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => disposeAll)
  else if (typeof ctx.on === 'function') ctx.on('dispose', disposeAll)

  /* ── open with DSH, not with the machine ────────────────────────────────
   *
   * There is deliberately no Run-key entry: booting the PC must not resurrect
   * the VPN while DSH is not running. The lifetime is DSH's own — the proxy
   * opens shortly after the panel loads and is closed again on dispose.
   *
   * Before opening, the previous exit is checked: if the system proxy still
   * points at our port while nothing is listening (a hard shutdown, a crash, a
   * killed process), it is repaired first, so a bad shutdown cannot leave the
   * machine without network.
   */
  startupTimer = setTimeout(async () => {
    startupTimer = null
    try {
      const listening = await portOpen(conf.proxyPort)
      if (!listening) {
        if (restoreProxyIfOursSync(conf)) {
          state.lastLog = `清理了上次残留的系统代理（指向 127.0.0.1:${conf.proxyPort}，端口无人监听）`
        }
      }
      if (!conf.autoStart) return
      if (listening) {
        state.lastLog = `VPN 已在 127.0.0.1:${conf.proxyPort} 上运行，接管现有实例`
        return
      }
      state.busy = 'on'
      state.lastError = ''
      state.lastActionAt = Date.now()
      const res = await runPowerShell(
        path.join(conf.scriptsDir, 'vpn-on.ps1'),
        ['-Port', String(conf.proxyPort)],
        120000,
      )
      state.lastLog = (res.out || '') + (res.err ? '\n[stderr]\n' + res.err : '')
      if (!res.ok) state.lastError = (res.err || res.out || `exit ${res.code}`).slice(-2000)
    } catch (err) {
      state.lastError = String((err && err.message) || err)
    } finally {
      state.busy = null
    }
  }, 1500)
  if (startupTimer && typeof startupTimer.unref === 'function') startupTimer.unref()
}
