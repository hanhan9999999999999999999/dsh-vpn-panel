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
import { spawn } from 'node:child_process'

export const name = 'vpn-panel'
export const inject = ['webServer']

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SETTINGS_FILE = path.join(DSH_HOME, 'vpn-panel.json')

const DEFAULTS = {
  scriptsDir: 'D:\\document\\vpn',
  proxyPort: 7891,
  controllerPort: 9090,
  autoStart: false,
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

function writeSettings(patch) {
  const next = { ...readSettings(), ...(patch || {}) }
  // Only known keys, and only sane types — the file is read on every request.
  const clean = {
    scriptsDir: String(next.scriptsDir || DEFAULTS.scriptsDir),
    proxyPort: Number(next.proxyPort) || DEFAULTS.proxyPort,
    controllerPort: Number(next.controllerPort) || DEFAULTS.controllerPort,
    autoStart: next.autoStart === true,
    testUrl: String(next.testUrl || DEFAULTS.testUrl),
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
    if (site === 'cross-site') return 403
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
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

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        resolve(null)
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
            if (method === 'POST' && body === null) return sendJson(res, 400, { ok: false, error: 'bad json' })
            const result = await handler(req, body)
            sendJson(res, result && result.status ? result.status : 200, result && result.body ? result.body : result)
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
    if (state.busy) return { ok: false, error: `busy: ${state.busy}`, status: collectStatus(conf) }
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
    const wanted = String(url.searchParams.get('names') || '')
      .split(',')
      .map((s) => s.trim())
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
    if (!saved.ok) return { ok: false, error: saved.error }
    conf = readSettings()
    // Autostart rides the per-user Run key, the same way the desktop shortcut does.
    if (body && typeof body.autoStart === 'boolean') {
      const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      const command = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path.join(conf.scriptsDir, 'vpn-on.ps1')}"`
      await new Promise((resolve) => {
        const child = body.autoStart
          ? spawn('reg.exe', ['add', runKey, '/v', 'DSHVpn', '/t', 'REG_SZ', '/d', command, '/f'], { windowsHide: true })
          : spawn('reg.exe', ['delete', runKey, '/v', 'DSHVpn', '/f'], { windowsHide: true })
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
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => disposeAll)
  else if (typeof ctx.on === 'function') ctx.on('dispose', disposeAll)
}
