# 对 [From..To] 之间新增的代码做安全扫描。命中任何一项返回 1。
param([Parameter(Mandatory)][string]$From,[Parameter(Mandatory)][string]$To,[string]$Report)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$hits = New-Object System.Collections.Generic.List[string]
$diff = git diff $From $To -U0 --no-color -- studio ':(exclude)*package-lock.json' ':(exclude)*.md' ':(exclude)studio/docs' ':(exclude)*.test.ts' ':(exclude)*.test.mjs'
$file = ''
$rules = [ordered]@{
  '键盘/屏幕/剪贴板监控' = 'uiohook|iohook|node-global-key-listener|robotjs|desktopCapturer|clipboard\.(read|write)|getDisplayMedia|SetWindowsHookEx|GetAsyncKeyState'
  '文件监视' = 'chokidar|fs\.watch\(|fs\.watchFile|FileSystemWatcher'
  '读取 Codex/Claude 本地记录' = '\.codex[\\/]|\.claude[\\/]|sessions[\\/]|history\.jsonl|\.credentials\.json|os\.homedir\(\)'
  '动态执行/下载运行' = '\beval\(|new Function\(|vm\.runIn|child_process|execSync|spawnSync|Invoke-Expression|DownloadString'
  '遥测/统计' = 'sentry|posthog|mixpanel|segment\.io|google-analytics|telemetry|amplitude'
}
$allowHost = 'api\.deepseek\.com|open\.bigmodel\.cn|api\.anthropic\.com|gorilla-api\.dxxapi\.com|github\.com|githubusercontent\.com|localhost|127\.0\.0\.1|172\.16\.8\.85|192\.168\.|10\.|example\.com|w3\.org|json-schema\.org|npmjs\.org|openai\.com|anthropic\.com|electronjs\.org'
foreach ($line in $diff) {
  if ($line -match '^\+\+\+ b/(.*)$') { $file = $Matches[1]; continue }
  if ($line -notmatch '^\+' -or $line -match '^\+\+\+') { continue }
  $text = $line.Substring(1)
  foreach ($k in $rules.Keys) { if ($text -match $rules[$k]) { $hits.Add(('[' + $k + '] ' + $file + ': ' + $text.Trim())) } }
  foreach ($m in [regex]::Matches($text, 'https?://([A-Za-z0-9\.\-]+)')) { if ($m.Groups[1].Value -notmatch $allowHost) { $hits.Add(('[新增外部地址] ' + $file + ': ' + $m.Value)) } }
}
$pkg = git diff $From $To -U0 --no-color -- '*package.json' | Where-Object { $_ -match '^\+\s+"[^"]+":\s*"[\^~]?[0-9]' }
foreach ($p in $pkg) { $hits.Add('[依赖变化] ' + $p.Trim()) }
Set-Location (Join-Path $repo 'studio')
$audit = npm audit --omit=dev --audit-level=high 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { $hits.Add('[npm audit 发现高危漏洞] 见报告'); }
if ($Report) { (@('范围: ' + $From + '..' + $To, '命中 ' + $hits.Count + ' 项', '') + $hits + @('', '--- npm audit ---', $audit)) | Set-Content -LiteralPath $Report -Encoding UTF8 }
if ($hits.Count -gt 0) { $hits | Select-Object -First 30 | ForEach-Object { Write-Host $_ }; exit 1 }
Write-Host '安全扫描通过'
exit 0
