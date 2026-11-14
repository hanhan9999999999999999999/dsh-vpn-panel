/**
 * proxy-info.js — the one shape every consumer sees.
 *
 * A model, a shell script and the panel must all agree on where the proxy is,
 * so this module is the single place that decides the answer. Nothing here
 * probes the network: it takes the settings and a status snapshot and formats
 * them into the contract below.
 *
 * Contract (stable — agents and scripts are told to read these keys):
 *
 *   ok           boolean   false only when the proxy is down and could not be started
 *   proxy        string    http://host:port     ← use this for HTTP(S) proxying
 *   httpProxy    string    same value, spelled for HTTP_PROXY
 *   httpsProxy   string    same value, spelled for HTTPS_PROXY
 *   socksProxy   string    socks5h://host:port  (mihomo mixed port speaks both)
 *   noProxy      string    loopback list; local services must never be proxied
 *   port         number    the mixed port
 *   running      boolean   something is listening on that port right now
 *   systemProxy  boolean   the Windows system proxy points at us
 *   node         string    current node name, null when unknown
 *   nodeCount    number
 *   endpoints    object    relative API paths, for callers that already have a base URL
 *   env          object    ready-to-use environment variables
 *   curl         string    copy-paste curl invocation
 *   updatedAt    number    epoch ms
 *
 * `host` is always 127.0.0.1: the proxy binds loopback only, and handing out
 * `localhost` would make some clients resolve ::1 first and miss the listener.
 */

export const LOOPBACK = '127.0.0.1'

/** Loopback hosts that must bypass the proxy (Windows also honours the suffix). */
export const NO_PROXY = '127.0.0.1,localhost,::1,*.localhost'

/**
 * @param {{proxyPort:number, controllerPort:number}} conf
 * @param {{running?:boolean, systemProxy?:boolean, node?:string|null, nodeCount?:number, lastError?:string}} status
 */
export function proxyInfo(conf, status = {}) {
  const port = Number(conf.proxyPort)
  const httpProxy = `http://${LOOPBACK}:${port}`
  const socksProxy = `socks5h://${LOOPBACK}:${port}`
  const running = status.running === true
  return {
    ok: running,
    proxy: httpProxy,
    httpProxy,
    httpsProxy: httpProxy,
    socksProxy,
    allProxy: socksProxy,
    noProxy: NO_PROXY,
    host: LOOPBACK,
    port,
    controllerPort: Number(conf.controllerPort),
    running,
    systemProxy: status.systemProxy === true,
    node: status.node || null,
    nodeCount: Number(status.nodeCount || 0),
    error: status.lastError || '',
    endpoints: {
      info: '/dsh-vpn/agent.json',
      ensure: '/dsh-vpn/ensure.json',
      status: '/dsh-vpn/status.json',
      power: '/dsh-vpn/power.json',
      nodes: '/dsh-vpn/nodes.json',
      select: '/dsh-vpn/select.json',
    },
    env: {
      HTTP_PROXY: httpProxy,
      HTTPS_PROXY: httpProxy,
      ALL_PROXY: socksProxy,
      NO_PROXY: NO_PROXY,
      // Lower-case twins: curl, git, pip and most Node tooling read these.
      http_proxy: httpProxy,
      https_proxy: httpProxy,
      all_proxy: socksProxy,
      no_proxy: NO_PROXY,
    },
    curl: `curl -x '${httpProxy}' https://example.com`,
    updatedAt: Date.now(),
  }
}

/**
 * Shell snippets for the platforms DSH runs on. Kept here so the rule block,
 * the README and the tool result never drift apart.
 */
export function usageSnippets(info) {
  return {
    powershell: [
      `$env:HTTP_PROXY='${info.httpProxy}'; $env:HTTPS_PROXY='${info.httpProxy}'`,
      `# loopback stays direct`,
      `$env:NO_PROXY='${info.noProxy}'`,
    ].join('\n'),
    bash: `export http_proxy='${info.httpProxy}' https_proxy='${info.httpProxy}' no_proxy='${info.noProxy}'`,
    curl: info.curl,
    node: `import { ProxyAgent } from 'undici'\nfetch(url, { dispatcher: new ProxyAgent('${info.httpProxy}') })`,
  }
}
