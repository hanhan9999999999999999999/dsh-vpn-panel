# dsh-vpn-panel

在 DSH 的**设置页**里加一个 `VPN` 栏目：一键开关本机代理内核、切换节点、测速、刷新订阅。

它本身不是代理服务，也不带节点。它做的是把「启动 / 停止本机 mihomo 内核 + 改写 Windows 系统代理」
这件事搬进 DSH 的面板里，省掉去桌面上点快捷方式。

包里自带整套脚本与一份配置骨架（`assets/vpn/`：`vpn-on/off/refresh.ps1`、`watchdog.ps1`、
`data/config.example.yaml`）。内核（`mihomo.exe`）与 geo 数据按体积与分发理由不进仓库，
首次使用把它们放到 `assets/vpn/bin/` 与 `assets/vpn/data/`（见「它依赖什么」）；想用自己那份，
把设置里的 `scriptsDir` 指过去即可。

配套的配置生成器与订阅处理脚本在 [vpn-toolkit](https://github.com/hanhan9999999999999999999/vpn-toolkit)。

## 声明

本插件是**本地进程管理与界面接入的技术示例，仅供学习与研究使用**。

- 不内置、也不推荐任何节点或订阅源——`assets/vpn/subs/` 与 `data/config.yaml` 都不进仓库，节点由使用者自行准备；
- 仓库里没有内核二进制：`mihomo` 请从它的官方 release 自取，本仓库只做进程管理与界面接入；
- 请遵守所在国家或地区的法律法规，使用后果由使用者自行承担。

## Notice

A technical example of local process management and host-UI integration, provided
**for study and research only**. The scripts and a config skeleton are bundled; the
proxy core binary and geo data are not (fetch mihomo from its own release). No nodes,
subscriptions or services are included or endorsed.
You are responsible for how you use it and for the laws that apply to you.

## 装

```sh
dsh plugin --profile desktop add https://github.com/hanhan9999999999999999999/dsh-vpn-panel
```

只从仓库装。同名 npm 包已由作者撤回（撤回前已发布的版本带 deprecate 警告），不要用 `npm i dsh-vpn-panel`。

装完重启 DSH，**设置 → VPN** 就在左侧栏目里。

## 面板上有什么

- **总开关** — 打开 / 关闭（等价于执行 `vpn-on.ps1` / `vpn-off.ps1`）
- **状态卡** — 内核是否在跑、系统代理是否指向本机端口、当前节点、节点数、上次测速
- **节点列表** — 带搜索框，点一行即切换（写 mihomo 的 `手动切换` 组）
- **四个按钮** — 测下载速度 / 测节点延迟 / 更新订阅节点 / 刷新状态
- **设置** — 代理端口、控制端口、脚本目录、测速地址、开机自启
- **日志** — 可折叠，出错时看得到 PowerShell 的真实输出

## 它依赖什么

**脚本自带，内核自备**：`assets/vpn/` 里已经带好全部脚本与一份配置骨架——
`vpn-on.ps1` / `vpn-off.ps1` / `vpn-refresh.ps1` / `watchdog.ps1`、`data\config.example.yaml`。
`scriptsDir` 留空或指错时，插件自动回退到这份内置运行时（只有「入口脚本 + watchdog 都在」的外部目录才会被优先采用）。

要让它真跑起来，缺两样东西，自己补：

| 缺什么 | 放哪 | 从哪来 |
| --- | --- | --- |
| `mihomo.exe` | `assets/vpn/bin/mihomo.exe` | [mihomo releases](https://github.com/MetaCubeX/mihomo/releases) 的 windows-amd64 版，重命名成 `mihomo.exe` |
| `Country.mmdb` / `geosite.dat` | `assets/vpn/data/` | mihomo release 的 `country.mmdb` / `geosite.dat`（或者把 `geodata-mode: false` 保留，缺失时只影响 geosite 规则） |

然后把 `data/config.example.yaml` 复制成 `data/config.yaml` 并填 `proxies`（见下面「节点得你自己准备」）。

想用自己那份（比如 vpn-toolkit 生成的一套），把设置里的 `scriptsDir` 指过去，它需要：

| 文件 | 作用 |
| --- | --- |
| `vpn-on.ps1` | 启动内核并打开系统代理 |
| `vpn-off.ps1` | 停止内核并还原系统代理 |
| `vpn-refresh.ps1` | 重新抓订阅、重建配置、重启内核 |
| `watchdog.ps1` | 跟随 `-WatchPid` 看护：宿主进程没了就收尾 |

另外 `controllerPort`（默认 9090）要对上 mihomo 的 `external-controller`。

**节点得你自己准备**：包里带的是内核与脚本，`assets/vpn/data/config.yaml`（真正可用的配置，
里面有节点）和 `assets/vpn/subs/*.txt`（订阅原文）都**不进仓库**，也写在 `.gitignore` 里。
首次使用把 `data/config.example.yaml` 复制成 `data/config.yaml` 并填 `proxies`，
或者让 `vpn-refresh.ps1` 从你的订阅生成。

## 本机路由（只接受回环访问）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-vpn/status.json` | 内核进程、系统代理、当前节点、节点数、日志尾巴 |
| POST | `/dsh-vpn/power.json` | `{"on": true}` 开，`{"on": false}` 关 |
| GET | `/dsh-vpn/nodes.json` | 节点列表（读 `127.0.0.1:9090/proxies`） |
| POST | `/dsh-vpn/select.json` | `{name}` 切换节点 |
| GET | `/dsh-vpn/delay.json` | 批量测延迟 |
| GET | `/dsh-vpn/speed.json` | 经本机代理实测下载速度 |
| POST | `/dsh-vpn/refresh.json` | 重建配置并重启内核 |
| GET | `/dsh-vpn/settings.json` | 读设置 |
| POST | `/dsh-vpn/settings/save.json` | 写设置 |

每个响应都是 JSON；跨站请求与非回环地址直接 403，方法不对 405。

## 给 agent 用：别再自己拼代理链接

装完这个插件，DSH 里的**每个会话**都会知道「要连外网就借这个插件的代理」，不用你在
prompt 里反复交代，会话也不用自己去猜 `http://127.0.0.1:xxxx` 到底是什么端口。

三样东西一起构成这份「代理入口」：

**1. `vpn_proxy` 工具**（宿主注入了 tools 服务时自动注册）

| 参数 | 说明 |
| --- | --- |
| `action: "ensure"` | 内核没在跑就拉起来，返回可用的代理地址（幂等，多个会话同时调只启动一次） |
| `action: "info"` | 只读当前代理契约，不启动任何东西 |
| `action: "status"` | 内核 / 系统代理 / 当前节点 |
| `action: "off"` | 关掉内核并还原系统代理 |

**2. HTTP 入口**（同一条回环规则）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-vpn/agent.json` | 纯读代理契约，永不拉起进程 |
| POST | `/dsh-vpn/ensure.json` | 允许拉起；`{"ok": true, "proxy": "http://127.0.0.1:7891", "started": true}` |
| GET | `/dsh-vpn/agent-state.json` | 最近一次发布的状态文件内容 |

**3. 注入到 `~/.agents/AGENTS.md` 的规则块**

插件启动时（以及每次开关、改设置之后）把一段带标记的规则写进 agent 指令链：

```
<!-- dsh-vpn-panel:begin v2 -->
…规则正文…
<!-- dsh-vpn-panel:end -->
```

规则块**幂等**：重写时整段替换，不会越堆越多；写之前留 `AGENTS.md.dsh-vpn.bak`。
不想要就把它删掉，或把设置里的 `injectAgentRule` 设为 `false`。
`~/.agents/` 不存在时插件不会替它创建目录——那种情况下只有工具和 HTTP 入口可用。

规则要求会话按这条链取代理：`vpn_proxy` 工具 → 读 `$DSH_HOME\vpn-panel-agent.json`
→ `POST /dsh-vpn/ensure.json` → 跑 `vpn-on.ps1`；`ensure` 返回 `ok: false` 就停下来
报告，不许退化直连、不许自建隧道、不许改 mihomo 配置或 kill 内核。

环境变量名就是那四个：`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`
（大小写两套都给）。`NO_PROXY` 固定含 `127.0.0.1,localhost,::1,*.localhost`——
回环一律直连，别把 DSH 自己的本地请求也塞进代理。

## 设置文件

`%USERPROFILE%\.dsh\vpn-panel.json`：

```json
{
  "proxyPort": 7891,
  "controllerPort": 9090,
  "scriptsDir": "D:\\document\\vpn",
  "testUrl": "http://speed.cloudflare.com/__down?bytes=5000000",
  "autoStart": false
}
```

`testUrl` 必须是 `http://`——测速走的是普通 HTTP GET 穿代理，不解 CONNECT。
`autoStart` 打开后会在 `HKCU\...\Run` 写一个 `DSHVpn` 值，开机自动执行 `vpn-on.ps1`。

## 开发

```sh
# 宿主端：假 cordis 上下文，起一个端口把路由跑起来
node test/host-harness.mjs ./src/index.js 51999

# agent 侧：工具注册、ensure 幂等、状态文件、AGENTS.md 规则块
node test/agent-api.mjs 51996

# 两套一起
npm test

# 客户端：假 __ModuleLoader__ + 假 React，验证槽位注册与渲染
node test/client-sim.cjs
```

`test/agent-api.mjs` 会临时把规则写到一个 `.tmp-AGENTS.md`（`DSH_VPN_AGENTS_FILE` 覆盖目标），
不碰你真正的 `~/.agents/AGENTS.md`。

`lib/client.js` 是手写的模块包（`window.__ModuleLoader__.load(...)`），只依赖宿主提供的 `react`，
没有构建步骤；改完直接重启 DSH 就生效。

MIT.
