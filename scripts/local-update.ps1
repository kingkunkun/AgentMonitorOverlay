# 每天本地更新: 拉取你的 fork 最新代码 -> 安全扫描 -> 编译打包 -> 替换安装。数据目录不动。
# 扫描不通过时不编译、不安装；人工审查后用 -Approve 放行。
param([switch]$Approve,[switch]$Force)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$work = 'D:\Codex\sync-reports'
New-Item -ItemType Directory -Force $work | Out-Null
$stamp = Get-Date -Format yyyyMMdd-HHmmss
Start-Transcript -Path "$work\run-$stamp.log" | Out-Null
Set-Location $repo
$stateFile = "$work\last-installed.txt"
git fetch origin
git merge --ff-only origin/master
if ($LASTEXITCODE -ne 0) { Write-Host '本地 master 与远端分叉，已停止'; Stop-Transcript | Out-Null; exit 1 }
$new = (git rev-parse HEAD).Trim()
$old = if (Test-Path $stateFile) { (Get-Content $stateFile -Raw).Trim() } else { $new }
if ($old -eq $new -and -not $Force) { Write-Host '没有新提交，无需更新'; Stop-Transcript | Out-Null; exit 0 }
$report = "$work\security-$stamp.txt"
& "$PSScriptRoot\security-check.ps1" -From $old -To $new -Report $report
if ($LASTEXITCODE -ne 0 -and -not $Approve) {
  Write-Host "安全扫描未通过，未编译未安装。报告: $report"
  Stop-Transcript | Out-Null; exit 2
}
Set-Location "$repo\studio"
npm install
npm run build
npm run package:portable
Get-Process WorkStudio -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 3
$apps = 'D:\Codex\AMO-Platform-win\AMO Platform\apps\studio'
$dest = "$apps\ws-$stamp"
Copy-Item "$repo\studio\release\WorkStudio" $dest -Recurse
if (-not (Test-Path "$dest\WorkStudio.exe")) { throw '打包结果缺少 WorkStudio.exe' }
(Get-Item "$apps\current").Delete()
New-Item -ItemType Junction -Path "$apps\current" -Target $dest | Out-Null
Set-Content -LiteralPath $stateFile -Value $new
Write-Host "已安装 $new 到 $dest；数据目录未改动"
Stop-Transcript | Out-Null
