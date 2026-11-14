# dsh-vpn-panel

在 DSH 的**设置页**里加一个 `VPN` 栏目：一键开关本机代理内核、切换节点、测速、刷新订阅。

它本身不是代理，也不带节点。它做的是把「启动 / 停止本机 mihomo 内核 + 改写 Windows 系统代理」
这件事搬进 DSH 的面板里，省掉去桌面上点快捷方式。

配套的脚本与配置生成器在 [vpn-toolkit](https://github.com/hanhan9999999999999999999/vpn-toolkit)。

## 声明

本插件是**本地进程管理与界面接入的技术示例，仅供学习与研究使用**。

- 不提供、不内置、也不推荐任何节点、订阅源或可用服务；
- 不含代理内核，内核与订阅由使用者自行获取；
- 请遵守所在国家或地区的法律法规，使用后果由使用者自行承担。

## Notice

A technical example of local process management and host-UI integration, provided
**for study and research only**. No nodes, subscriptions, services or proxy core
are bundled or endorsed. You are responsible for how you use it and for the laws
that apply to you.

## 装

```sh
# 从 npm（发布后）
dsh plugin --profile desktop add dsh-vpn-panel

# 或者直接从仓库
dsh plugin --profile desktop add https://github.com/hanhan9999999999999999999/dsh-vpn-panel
```

装完重启 DSH，**设置 → VPN** 就在左侧栏目里。

## 面板上有什么

- **总开关** — 打开 / 关闭（等价于执行 `vpn-on.ps1` / `vpn-off.ps1`）
- **状态卡** — 内核是否在跑、系统代理是否指向本机端口、当前节点、节点数、上次测速
- **节点列表** — 带搜索框，点一行即切换（写 mihomo 的 `手动切换` 组）
- **四个按钮** — 测下载速度 / 测节点延迟 / 更新订阅节点 / 刷新状态
- **设置** — 代理端口、控制端口、脚本目录、测速地址、开机自启
- **日志** — 可折叠，出错时看得到 PowerShell 的真实输出

## 它依赖什么

面板假设 `scriptsDir`（默认 `D:\document\vpn`）下有：

| 文件 | 作用 |
| --- | --- |
| `vpn-on.ps1` | 启动内核并打开系统代理 |
| `vpn-off.ps1` | 停止内核并还原系统代理 |
| `vpn-refresh.ps1` | 重新抓订阅、重建配置、重启内核 |

这些脚本在 vpn-toolkit 仓库里；目录不同就在面板设置里改 `scriptsDir`。
另外 `controllerPort`（默认 9090）要对上 mihomo 的 `external-controller`。

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

# 客户端：假 __ModuleLoader__ + 假 React，验证槽位注册与渲染
node test/client-sim.cjs
```

`lib/client.js` 是手写的模块包（`window.__ModuleLoader__.load(...)`），只依赖宿主提供的 `react`，
没有构建步骤；改完直接重启 DSH 就生效。

MIT.
