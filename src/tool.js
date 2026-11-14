/**
 * tool.js — expose the proxy to the model as a tool.
 *
 * The rule block in AGENTS.md tells a session *what* to do; this tool is *how*
 * it does it without guessing a port or shelling around. A tool call also shows
 * up in the transcript, so the user can see the proxy being used instead of
 * wondering where a stray `HTTPS_PROXY` came from.
 *
 * Registration is best-effort by design: `@deepseek-ai/dsh-tools` ships inside
 * the host's app.asar, which a plugin's node_modules cannot resolve. If neither
 * import works we fall back to a local compiler (same shape, no runtime arg
 * validation) — and if even that fails, the plugin keeps serving its HTTP
 * routes, which the rule block also documents.
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const TOOL_NAME = 'vpn_proxy'

/**
 * Author-facing parameter map (name → value spec). The host turns this into
 * JSON Schema; `required: true` lifts an entry into the parent `required` array.
 */
export function vpnProxyParameters() {
  return {
    action: {
      type: 'string',
      enum: ['ensure', 'info', 'status', 'off'],
      description:
        'ensure (default): return the proxy URL, starting the local core first if it is not running. '
        + 'info: return the proxy URL only, never start anything. '
        + 'status: kernel, system proxy, current node and recent log. '
        + 'off: stop the core and restore the system proxy.',
    },
    reason: {
      type: 'string',
      description: 'One short sentence: what you are about to fetch. Recorded in the reply, not used for routing.',
    },
  }
}

export function vpnProxySpec() {
  return {
    name: TOOL_NAME,
    description:
      'Get the local VPN proxy URL before any outbound request, and start the core if it is down.\n\n'
      + '**Call this instead of inventing a proxy URL.** Ports and nodes change; the panel is the only '
      + 'side that knows the live values. Typical use: `vpn_proxy({action:"ensure"})` → read `proxy` '
      + 'from the result → put it in HTTP(S)_PROXY or `curl -x`.\n\n'
      + '- `ensure` is idempotent and takes a few seconds when it has to start the core; concurrent '
      + 'callers share one start.\n'
      + '- `ok:false` means the proxy is genuinely unavailable. Report the `error`/`lastLog` to the user '
      + 'and stop — do not fall back to a direct connection and do not build another tunnel.\n'
      + '- Never proxy loopback (`127.0.0.1`, `localhost`, `::1`).\n'
      + '- The proxy lives and dies with DSH; there is nothing to clean up after use.',
    parameters: vpnProxyParameters(),
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          ok: { type: 'boolean' },
          proxy: { type: 'string' },
          running: { type: 'boolean' },
          node: { type: ['string', 'null'] },
        },
        required: ['text', 'ok'],
      },
      render: (value) => (value && typeof value.text === 'string' ? value.text : JSON.stringify(value)),
    },
    timeoutMs: 130_000,
    isConcurrencySafe: () => false,
  }
}

/** Fallback compiler: same output shape, no runtime argument validation. */
export function defineToolCompat(options) {
  const { name, description, parameters, output, execute } = options || {}
  if (typeof name !== 'string' || !name) throw new Error('defineTool: name required')
  if (!output || typeof output.render !== 'function') throw new Error(`defineTool(${name}): output.render required`)
  if (typeof execute !== 'function') throw new Error(`defineTool(${name}): execute required`)
  return {
    name,
    description,
    parameters: toJsonSchema(parameters || {}),
    output: { schema: output.schema || { type: 'object' }, render: output.render },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(typeof options.isConcurrencySafe === 'function' ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
    execute: (args, exec) => execute(args, exec),
  }
}

function toJsonSchema(map) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(map)) {
    if (!spec || typeof spec !== 'object') continue
    const { required: mark, ...rest } = spec
    if (mark === true) required.push(key)
    properties[key] = rest
  }
  return required.length ? { type: 'object', properties, required } : { type: 'object', properties }
}

export async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (mod && typeof mod.defineTool === 'function') return mod.defineTool
  } catch {}
  const override = process.env.DSH_TOOLS_PATH
  if (override) {
    try {
      const mod = await import(pathToFileURL(path.resolve(override)).href)
      if (mod && typeof mod.defineTool === 'function') return mod.defineTool
    } catch {}
  }
  return defineToolCompat
}

/**
 * Build the tool's execute handler. `deps` are supplied by index.js so this
 * module stays free of the settings/state plumbing.
 *
 * @param {{ensure:Function, status:Function, power:Function, describe:Function}} deps
 */
export function makeVpnProxyHandler(deps) {
  return async function vpnProxy(args = {}) {
    const action = typeof args.action === 'string' ? args.action : 'ensure'
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''

    if (action === 'off') {
      const out = await deps.power(false)
      return {
        ok: out.ok === true,
        text: `已关闭本机代理内核（系统代理已还原）。\n${out.message || ''}`.trim(),
        running: false,
        proxy: out.info ? out.info.proxy : '',
      }
    }

    if (action === 'status') {
      const st = await deps.status()
      const info = deps.describe(st)
      return {
        ok: true,
        text: [
          `内核：${info.running ? '运行中' : '未运行'}（${info.proxy}）`,
          `系统代理：${info.systemProxy ? '指向本机代理' : '未接管'}`,
          `节点：${info.node || '未知'}（共 ${info.nodeCount} 个）`,
          st && st.lastLog ? `\n--- 最近日志 ---\n${String(st.lastLog).slice(-1200)}` : '',
        ].filter(Boolean).join('\n'),
        proxy: info.proxy,
        running: info.running,
        node: info.node,
      }
    }

    if (action === 'info') {
      const st = await deps.status()
      const info = deps.describe(st)
      return {
        ok: info.running,
        text: info.running
          ? `本机代理：${info.proxy}\n（HTTP(S) 与 SOCKS5 共用此端口；回环地址不要走代理）`
          : `本机代理未运行。改用 ${TOOL_NAME}({action:"ensure"}) 拉起，或用 stop 状态的 lastLog 排查。`,
        proxy: info.proxy,
        running: info.running,
        node: info.node,
      }
    }

    // ensure (default)
    const out = await deps.ensure()
    const info = out.info
    const env = info.env || {}
    const head = out.started
      ? `本机代理已启动：${info.proxy}`
      : `本机代理已在运行：${info.proxy}`
    const tail = out.log ? `\n--- 启动日志 ---\n${String(out.log).slice(-1200)}` : ''
    const failNote = info.ok
      ? ''
      : `\n代理没有起来（${info.error || 'unknown'}）。把上面日志交给用户，不要改成直连。`
    return {
      ok: info.ok,
      text: [
        head + (reason ? `\n用途：${reason}` : ''),
        `节点：${info.node || '未知'}（共 ${info.nodeCount} 个）`,
        '',
        '用法：',
        `  PowerShell: $env:HTTP_PROXY='${env.HTTP_PROXY}'; $env:HTTPS_PROXY='${env.HTTPS_PROXY}'`,
        `  bash:       export http_proxy='${env.http_proxy}' https_proxy='${env.https_proxy}'`,
        `  curl:       ${info.curl}`,
        failNote + tail,
      ].filter(Boolean).join('\n'),
      proxy: info.proxy,
      running: info.running,
      node: info.node,
      error: info.ok ? undefined : info.error,
    }
  }
}
