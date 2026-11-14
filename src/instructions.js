/**
 * instructions.js — teach every future session to use this proxy.
 *
 * The panel is useless to a model that does not know it exists: a session that
 * needs the internet will otherwise hand-roll a proxy URL from memory, guess a
 * port, or curl straight out and fail. So installing the plugin also installs a
 * short rule into the agent instruction chain:
 *
 *   ~/.agents/AGENTS.md   ← read by @deepseek-ai/dsh-agent-instructions
 *
 * That file is user-global, so the rule survives profile changes and stays in
 * place in safe mode, where third-party prompt injectors are gone.
 *
 * Writing into a file the user also edits demands care:
 *   - the rule lives between two markers and only that range is ever replaced;
 *   - the previous file is copied to AGENTS.md.dsh-vpn.bak before the first change;
 *   - the write is atomic (tmp + rename), so a crash cannot truncate the file;
 *   - if anything is unexpected (markers unbalanced, file unreadable) it bails
 *     out and reports instead of guessing.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const RULE_BEGIN = '<!-- dsh-vpn-panel:begin v2 -->'
export const RULE_END = '<!-- dsh-vpn-panel:end -->'

/** Default target: the user-global instruction chain DSH reads for every profile. */
export function defaultAgentsFile() {
  return process.env.DSH_VPN_AGENTS_FILE || path.join(os.homedir(), '.agents', 'AGENTS.md')
}

/**
 * The rule itself. Written for a model that has never seen this plugin, in the
 * same language the sessions run in, with the port left as a placeholder so a
 * changed port never leaves a stale literal behind.
 */
export function buildRuleBlock(info) {
  const src = info || {}
  const panelHint = src.panelUrl
    ? `\`${src.panelUrl}\`（重装或换端口后以状态文件的 \`panelUrl\` 为准）`
    : '读状态文件的 `panelUrl` 字段（插件起来时才写；没有就用下一个办法）'
  const portHint = src.port ? `\`${src.port}\`` : '读状态文件的 `port` 字段（默认 7891）'
  return `${RULE_BEGIN}
## 联网必须走 VPN 插件代理（dsh-vpn-panel）

**需要访问外网时，先向插件要代理；不要自己拼代理链接、不要猜端口、不要另起隧道。**
插件是唯一知道「本机代理端口 / 内核是否在跑 / 当前节点」的一方。

### 取代理（从上往下，第一条成功就停）

1. **有工具就直接调**：\`vpn_proxy\`，参数 \`{"action":"ensure"}\`。
   内核没开它会顺手拉起（等价于 \`vpn-on.ps1\`），返回里有 \`proxy\`。
2. **读状态文件**：\`$env:DSH_HOME\\vpn-panel-agent.json\`（DSH_HOME 就是 DSH 的数据目录；
   没导出这个变量就看 DSH 实际使用的 home）。\`running:true\` 就直接用里面的 \`proxy\`。
3. **状态文件说没运行**：用文件里的 \`panelUrl\` 打
   \`POST \${panelUrl}/dsh-vpn/ensure.json\`，它会拉起内核并把代理还给你。
4. **以上都不行**：跑插件自带的内核脚本
   \`assets/vpn/vpn-on.ps1 -Port <端口> -WatchPid <本进程pid>\`（设置里改过 \`scriptsDir\` 就用那个目录）。
   没有脚本 = 插件没装好，**停下来告诉用户**。

### 用代理

拿到 \`<proxy>\`（形如 \`http://127.0.0.1:<端口>\`）后原样代入，**不要改写端口**：

- PowerShell：\`$env:HTTP_PROXY='<proxy>'; $env:HTTPS_PROXY='<proxy>'\`
- bash/zsh：\`export http_proxy='<proxy>' https_proxy='<proxy>' no_proxy='127.0.0.1,localhost,::1'\`
- curl：\`curl -x '<proxy>' <url>\`
- Node：\`new ProxyAgent('<proxy>')\`（undici）
- Python：\`proxies={'https': '<proxy>'}\`

### 硬性要求

- **回环地址不挂代理**：访问 \`127.0.0.1\` / \`localhost\` / \`::1\` 的服务时保持直连。
- **\`ensure\` 返回 \`ok:false\` 就停**：把 \`error\` / \`lastLog\` 原样贴给用户。不要退化成直连，
  不要自建代理或隧道，不要换别的代理源——那会把「插件坏了」伪装成「网络坏了」。
- **不要改 mihomo 配置、不要 kill 内核**；要关就走插件的 \`power.json\`（\`{"on":false}\`）。
- 代理生命周期跟随 DSH：DSH 退出时插件自己收尾，会话不需要关它。

### 本机已知入口

- 面板：${panelHint}
- 代理混合端口：${portHint}（**以返回值为准**，可被设置改掉）
- 控制器：默认 9090（mihomo \`external-controller\`，只读用）

${RULE_END}
`
}

function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function atomicWrite(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Insert or refresh the rule block. Idempotent: the same input twice rewrites
 * the same bytes, so the plugin can call it on every start.
 *
 * @param {{file?:string, info?:object, log?:(m:string)=>void}} options
 * @returns {{ok:boolean, changed:boolean, file:string, reason?:string, backup?:string}}
 */
export function upsertAgentsRule(options = {}) {
  const file = options.file || defaultAgentsFile()
  const log = options.log || (() => {})
  const block = buildRuleBlock(options.info || {}).trimEnd()

  let original = readTextOrNull(file)
  if (original === null) {
    // Missing file is fine — but only create it when its directory already
    // exists (an .agents dir means DSH is installed and this is the right place).
    if (!fs.existsSync(path.dirname(file))) {
      return { ok: false, changed: false, file, reason: 'no .agents directory next to ' + file }
    }
    original = ''
  }

  const begin = original.indexOf(RULE_BEGIN)
  const end = original.indexOf(RULE_END)
  let next
  let changed = false

  if (begin >= 0 && end > begin) {
    next = original.slice(0, begin) + block + original.slice(end + RULE_END.length)
    changed = next !== original
  } else if (begin >= 0 || end >= 0) {
    // Half a block: someone edited by hand or a previous write was interrupted.
    // Refuse rather than duplicate the rule.
    return { ok: false, changed: false, file, reason: 'unbalanced rule markers — fix by hand' }
  } else {
    const head = original.trimEnd()
    next = (head ? head + '\n\n' : '') + block + '\n'
    changed = true
  }

  if (!changed) return { ok: true, changed: false, file }

  let backup = null
  if (original) {
    backup = file + '.dsh-vpn.bak'
    try {
      fs.writeFileSync(backup, original, 'utf8')
    } catch (err) {
      // A failed backup must not block the rule (the file is append-only for us),
      // but it is worth reporting.
      log('AGENTS.md 备份失败：' + String((err && err.message) || err))
      backup = null
    }
  }

  try {
    atomicWrite(file, next)
  } catch (err) {
    return { ok: false, changed: false, file, reason: String((err && err.message) || err) }
  }
  log(`已把 VPN 代理规则写入 ${file}`)
  return { ok: true, changed: true, file, backup: backup || undefined }
}
