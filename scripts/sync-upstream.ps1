# 同步上游 kadhygh/AgentMonitorOverlay -> 自己的 fork -> 本地重新构建并安装 WorkStudio。数据目录不动。
# 用法: scripts/sync-upstream.ps1 [-AllowMerge]   (默认只 fast-forward, 分叉时停下)
param([switch]$AllowMerge)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
git fetch upstream
if ($AllowMerge) { git merge --no-edit upstream/master } else { git merge --ff-only upstream/master }
if ($LASTEXITCODE -ne 0) { Write-Host "无法自动合并，请手动处理冲突"; exit 1 }
git push origin master
Set-Location "$repo\studio"
npm install; npm run build; npm run package:portable
Get-Process WorkStudio -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 3
$apps = "D:\Codex\AMO-Platform-win\AMO Platform\apps\studio"
$new = "$apps\ws-" + (Get-Date -Format yyyyMMdd-HHmmss)
Copy-Item "$repo\studio\release\WorkStudio" $new -Recurse
(Get-Item "$apps\current").Delete()
New-Item -ItemType Junction -Path "$apps\current" -Target $new | Out-Null
Write-Host "已安装到 $new ; 数据目录 studio\.data 未改动"
