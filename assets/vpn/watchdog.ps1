# watchdog.ps1 -- 守住系统代理，别让 DSH 死了以后机器像断网
#
# vpn-on.ps1 把系统代理指到 127.0.0.1:<Port>。这个值写在注册表里，能活过进程、活过重启；
# 而 mihomo 是 detached 子进程。DSH 被强杀（任务管理器结束、崩溃、蓝屏前一刻）时，
# 退出钩子根本没机会跑 —— 代理继续指着没人监听的端口，整台机器就"断网"了。
#
# 这个脚本起一个独立小进程盯着 **DSH 桌面端本体**（不是那个会因为重启而换 pid 的 host 子进程），
# 确认它真的没了、并且代理确实是本插件设的，才收掉 mihomo 并把代理还原。
# 代理已经被别人改过 / 关掉？一个字都不动。
#
# 用法: watchdog.ps1 -WatchPid <DSH host pid> -OffScript <vpn-off.ps1> -Port <7891>

param(
  [int]$WatchPid = 0,
  [string]$OffScript = '',
  [int]$Port = 7891
)

$ErrorActionPreference = 'SilentlyContinue'
$reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'

# 同一个端口只允许一个看门狗：重复拉起时后到者直接退出。
$mutexName = "Global\dsh-vpn-watchdog-$Port"
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$acquired = $false
try { $acquired = $mutex.WaitOne(0) } catch { $acquired = $false }
if (-not $acquired) { exit 0 }

function Get-ParentPid([int]$procId) {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop
    return [int]$p.ParentProcessId
  } catch { return 0 }
}

# 往上找到最外层的那个应用进程：host 子进程会因为桌面端重载而换 pid，
# 但桌面端本体不会 —— 盯着它才不会在"DSH 重启"时误判成"用户关掉了 DSH"。
function Get-GuardPid([int]$procId) {
  if ($procId -le 0) { return 0 }
  $cur = $procId
  for ($i = 0; $i -lt 5; $i++) {
    $parent = Get-ParentPid $cur
    if ($parent -le 4) { break }
    $name = (Get-Process -Id $parent -ErrorAction SilentlyContinue).ProcessName
    if (-not $name) { break }
    if ($name -in @('explorer', 'services', 'wininit', 'winlogon', 'svchost', 'cmd', 'powershell', 'pwsh', 'WindowsTerminal', 'conhost')) { break }
    $cur = $parent
  }
  return $cur
}

function Test-ProxyIsOurs {
  $server = [string](Get-ItemProperty -Path $reg -Name ProxyServer -ErrorAction SilentlyContinue).ProxyServer
  if (-not $server) { return $false }
  return ($server -eq "127.0.0.1:$Port") -or $server.EndsWith(":$Port")
}

function Restore-Proxy {
  Get-Process mihomo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Set-ItemProperty -Path $reg -Name ProxyEnable -Value 0 -Type DWord
  Remove-ItemProperty -Path $reg -Name ProxyServer -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $reg -Name ProxyOverride -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $reg -Name AutoConfigURL -ErrorAction SilentlyContinue

  if (-not ('WinInetRefresh' -as [type])) {
    Add-Type -Namespace W -Name WinInetRefresh -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("wininet.dll", SetLastError = true)]
public static extern bool InternetSetOption(System.IntPtr h, int o, System.IntPtr b, int l);
'@
  }
  [W.WinInetRefresh]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
  [W.WinInetRefresh]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
}

$guard = Get-GuardPid $WatchPid
if ($guard -le 0) { $guard = $WatchPid }

while ($true) {
  if ($guard -gt 0) {
    if (-not (Get-Process -Id $guard -ErrorAction SilentlyContinue)) {
      # 宽限期：桌面端重启时旧 pid 会先消失几秒，别在这时候把 VPN 拆了。
      $alive = $false
      foreach ($wait in @(2, 2, 2, 2)) {
        Start-Sleep -Seconds $wait
        if (Get-Process -Id $guard -ErrorAction SilentlyContinue) { $alive = $true; break }
      }
      if (-not $alive) { break }
    }
  } else {
    if (-not (Get-Process mihomo -ErrorAction SilentlyContinue)) { break }
  }
  Start-Sleep -Seconds 2
}

# 只在"代理确实是本插件设的那一个"时才收尾；用户自己改过就碰不得。
if (-not (Test-ProxyIsOurs)) {
  try { $mutex.ReleaseMutex() } catch {}
  exit 0
}

$done = $false
if ($OffScript -and (Test-Path $OffScript)) {
  try {
    & powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $OffScript | Out-Null
    $done = $true
  } catch {}
}
if (-not $done) { Restore-Proxy }

try { $mutex.ReleaseMutex() } catch {}
exit 0
