# vpn-on.ps1  --  start mihomo and switch the Windows system proxy on
# Layout: <root>\bin\mihomo.exe, <root>\data\config.yaml, <root>\data\ (geo files, cache)
# -WatchPid <pid>  arms watchdog.ps1, which restores the proxy if that process dies
# without running its exit handlers (killed, crashed, host restart).
param([int]$Port = 7891, [int]$WatchPid = 0)
$ErrorActionPreference = 'Stop'
$root  = $PSScriptRoot
$exe   = Join-Path $root 'bin\mihomo.exe'
$data  = Join-Path $root 'data'
$cfg   = Join-Path $data 'config.yaml'
$reg   = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'

if (-not (Test-Path $exe)) { Write-Host "[X] mihomo.exe missing: $exe" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $cfg)) { Write-Host "[X] config.yaml missing: $cfg" -ForegroundColor Red; exit 1 }

Get-Process mihomo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400

Start-Process -FilePath $exe -ArgumentList @('-d', $data, '-f', $cfg) -WindowStyle Hidden | Out-Null

$ok = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { $ok = $true; break }
}
if (-not $ok) { Write-Host "[X] mihomo did not open port $Port" -ForegroundColor Red; exit 2 }

Set-ItemProperty -Path $reg -Name ProxyEnable  -Value 1 -Type DWord
Set-ItemProperty -Path $reg -Name ProxyServer  -Value "127.0.0.1:$Port" -Type String
Set-ItemProperty -Path $reg -Name ProxyOverride -Value 'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>' -Type String
Remove-ItemProperty -Path $reg -Name AutoConfigURL -ErrorAction SilentlyContinue

if (-not ('WinInetRefresh' -as [type])) {
    Add-Type -Namespace W -Name WinInetRefresh -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("wininet.dll", SetLastError = true)]
public static extern bool InternetSetOption(System.IntPtr h, int o, System.IntPtr b, int l);
'@
}
[W.WinInetRefresh]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
[W.WinInetRefresh]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null

# ── safety net ────────────────────────────────────────────────────────────────
# The proxy values above live in the registry and outlive this process. If DSH is
# killed hard, its exit hook never runs and the machine keeps a proxy pointing at
# a dead port -- which the user experiences as "no internet". The watchdog below
# watches the DSH process and undoes everything when it disappears.
# 先把同端口的旧看门狗清掉：DSH 重载会换掉 host pid，旧看门狗盯着的那个 pid 已经死了，
# 留着它就会在新 host 刚把 VPN 拉起来的瞬间把 VPN 拆掉（表现为"重开 DSH 反而断网"）。
# 只认带 -WatchPid 的真看门狗，并且跳过自己与自己的祖先链 —— 否则调用方脚本里
# 只要出现 watchdog.ps1 字样就会被误杀（调试时踩过一次）。
$selfIds = New-Object 'System.Collections.Generic.HashSet[int]'
$cur = $PID
for ($i = 0; $i -lt 6 -and $cur -gt 0; $i++) {
    [void]$selfIds.Add($cur)
    $cur = [int](Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue).ParentProcessId
}
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
      $_.CommandLine -like '*watchdog.ps1*' -and
      $_.CommandLine -like '*-WatchPid*' -and
      $_.CommandLine -like "*-Port $Port*" -and
      -not $selfIds.Contains([int]$_.ProcessId)
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if ($WatchPid -gt 0) {
    $wd  = Join-Path $root 'watchdog.ps1'
    $off = Join-Path $root 'vpn-off.ps1'
    if (Test-Path $wd) {
        $argList = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$wd`"",
                     '-WatchPid', $WatchPid, '-Port', $Port, '-OffScript', "`"$off`"")
        Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden | Out-Null
        Write-Host "[OK] watchdog armed for pid $WatchPid" -ForegroundColor DarkGray
    }
}

$code = curl.exe -s -o NUL -x "http://127.0.0.1:$Port" --max-time 15 -w "%{http_code}" http://www.gstatic.com/generate_204
Write-Host ""
Write-Host "[OK] system proxy -> 127.0.0.1:$Port   probe: HTTP $code" -ForegroundColor Green
Write-Host "     dashboard: http://127.0.0.1:9090"
