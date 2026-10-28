# 起一个带调试端口的 Chrome，用来登千牛（**不代登录**：只负责把浏览器和登录页打开）。
#
# 用法：
#   & "<skillRoot>\scripts\open_browser.ps1"                       # 默认 9120 + config.chrome_profile
#   & "<skillRoot>\scripts\open_browser.ps1" -Port 9120 -StartUrl "https://qn.taobao.com/home.htm/QnworkbenchHome/"
#   & "<skillRoot>\scripts\open_browser.ps1" -ForceNewProfile      # 换一份全新 profile（要重新登录）
#
# 退出码：0 = 起来了且端口可达；1 = 起不来；2 = 起来了但端口探不到（多半是 profile 被别的 Chrome 占用）
param(
  [int]$Port = 0,
  [string]$Profile = "",
  [string]$StartUrl = "https://qn.taobao.com/home.htm/QnworkbenchHome/",
  [switch]$ForceNewProfile
)

. (Join-Path $PSScriptRoot 'resolve_env.ps1')
$e = $script:TbEnv
if ($Port -eq 0) { $Port = [int]$e.default_port }
if (-not $Profile) { $Profile = $e.chrome_profile }
if (-not $Profile) { $Profile = Join-Path $e.workdir "chrome-profile" }
if ($ForceNewProfile) { $Profile = Join-Path $e.workdir ("chrome-profile-" + (Get-Date -Format "yyyyMMdd-HHmmss")) }
New-Item -ItemType Directory -Force -Path $Profile | Out-Null

if (-not $e.chrome -or -not (Test-Path $e.chrome)) {
  Write-Host "★ 找不到 chrome.exe（config.json 的 chrome 或 TB_CHROME）" -ForegroundColor Red
  exit 1
}

# ⚠️ 端口被别的 Chrome 占着时，新开的进程会把参数转给已有实例然后自己退出 ——
#    结果就是「命令没报错，但 $Port 上什么都没有」。所以启动后必须探活确认。
$args = @("--remote-debugging-port=$Port", "--user-data-dir=$Profile", "--no-first-run", "--no-default-browser-check", $StartUrl)
Write-Host ("启动：{0}  port={1}  profile={2}" -f $e.chrome, $Port, $Profile) -ForegroundColor Cyan
Start-Process -FilePath $e.chrome -ArgumentList $args
Start-Sleep -Seconds 6

try {
  $ver = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 5
  Write-Host ("✓ 端口 $Port 可达：" + (($ver.Content | ConvertFrom-Json).Browser)) -ForegroundColor Green
  Write-Host "  → 请在打开的窗口里登录千牛（本技能不代登录）" -ForegroundColor Yellow
  exit 0
} catch {
  Write-Host ("★ 进程起来了但端口 $Port 探不到 —— 常见原因：这份 profile 已被别的 Chrome 实例占用。" + `
              "换一份 profile（-ForceNewProfile）或换个端口。") -ForegroundColor Red
  exit 2
}
