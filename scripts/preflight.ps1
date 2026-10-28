# 环境自检（开工前先跑）：一口气报出「能不能跑」，而不是跑到一半才炸。
#
# 用法：
#   & "<skillRoot>\scripts\preflight.ps1"                                  # 检查所有已登记的店
#   & "<skillRoot>\scripts\preflight.ps1" -Shop 店名
#   & "<skillRoot>\scripts\preflight.ps1" -Port 9120                       # 只测某个端口
#   & "<skillRoot>\scripts\preflight.ps1" -ProductDir "<素材包>\淘宝\<商品号>"   # 顺带查商品素材
#
# 检查项：
#   1) Node / Python / Chrome 可执行文件能不能解析到
#   2) Python 依赖：openpyxl（读 Excel）、Pillow（图片适配）
#   3) playwright-core 能不能解析到（TB_PLAYWRIGHT → 技能自带 tools/npm → 机器级）
#   4) **按店**的 CDP 端口可达 + **千牛登录态**（只看已有标签页，不代登录、不导航）
#   5) 商品素材目录（可选，-ProductDir）：1比1主图 / 宝贝详情 是否齐
#
# 退出码：0 = 全过（可开工）；1 = 有阻断项（先修）；2 = 只有警告（可开工，但要知道风险）
param(
  [string]$Shop = "",
  [int]$Port = 0,
  [string]$ProductDir = "",
  [switch]$Quiet
)

. (Join-Path $PSScriptRoot 'resolve_env.ps1')
$e = $script:TbEnv
$skillRoot = $script:TbSkillRoot
$portGiven = $Port -gt 0          # 必须记住「有没有显式传 -Port」（下面兜默认值后就分不清了）
if ($Port -eq 0) { $Port = [int]$e.default_port }

$blockers = @()
$warns = @()
function Ok($msg)   { if (-not $Quiet) { Write-Host ("  [ OK ] " + $msg) -ForegroundColor Green } }
function Bad($msg)  { Write-Host ("  [FAIL] " + $msg) -ForegroundColor Red; $script:blockers += $msg }
function Warn($msg) { Write-Host ("  [warn] " + $msg) -ForegroundColor Yellow; $script:warns += $msg }
function Head($msg) { Write-Host ""; Write-Host ("== " + $msg) -ForegroundColor Cyan }

Write-Host "==== 淘宝上架技能 · 开工前自检 ====" -ForegroundColor Cyan

Head "1) 运行时"
if ($e.node -and (Test-Path $e.node)) { Ok "node = $($e.node)" } else { Bad "找不到 node —— 装 Node.js 或在 config.json 里写 node 路径" }
if ($e.python -and (Test-Path $e.python)) { Ok "python = $($e.python)" } else { Bad "找不到 python —— 装 Python 3 或在 config.json 里写 python 路径" }
if ($e.chrome -and (Test-Path $e.chrome)) { Ok "chrome = $($e.chrome)" } else { Warn "没解析到 chrome.exe（只有要新开浏览器时才需要）" }

Head "2) Python 依赖"
if ($e.python -and (Test-Path $e.python)) {
  $dep = & $e.python -c "import openpyxl, PIL; print('openpyxl', openpyxl.__version__, '| Pillow', PIL.__version__)" 2>&1
  if ($LASTEXITCODE -eq 0) { Ok "$dep" } else { Bad "缺依赖：$dep（该解释器要装 openpyxl + Pillow）" }
}

Head "3) playwright-core"
if ($e.node -and (Test-Path $e.node)) {
  $whichPw = Join-Path $skillRoot "scripts\which_pw.js"
  if (-not (Test-Path $whichPw)) {
    Bad "缺 scripts\which_pw.js（自检/依赖判定要用它）"
  } else {
    $pwj = & $e.node $whichPw 2>&1 | Out-String
    if ($pwj -match '"ok":\s*true') {
      $how  = ([regex]::Match($pwj, '"how":\s*"([^"]+)"')).Groups[1].Value
      $spec = ([regex]::Match($pwj, '"spec":\s*"([^"]+)"')).Groups[1].Value
      $specSafe = $spec -replace '\\\\', '\'
      if ($specSafe -match 'tools\\npm') { Ok ("技能自带：$specSafe（换机器也能跑）") }
      elseif ($how -match 'TB_PLAYWRIGHT') { Ok ("TB_PLAYWRIGHT 指定：$specSafe") }
      else { Warn ("仅机器级解析：$specSafe —— 只在这台机器成立；技能自带那份应在 tools\npm\node_modules\playwright-core") }
    } else {
      Bad "playwright-core 找不到 —— 确认技能目录下有 tools\npm\node_modules\playwright-core，或在 config.json 的 playwright_core 写绝对路径"
    }
  }
}

Head "4) CDP 端口 + 千牛登录态（按店）"
# ★ 不写死店铺：以 config.shops 为准；不传 -Shop 就把登记的店逐家查一遍。
# ⚠️ 空对象 `"shops": {}` 的 `.PSObject.Properties.Name` 会返回**一个 $null 元素**（`@($null)` 长度是 1）：
#   ① 不过滤 → 跑出一个「店名空、端口 0」的假店；② 只用 `if ($e.shops)` 判 → 空对象也当真，走了错分支就什么都不查。
$shopNames = if ($e.shops) { @($e.shops.PSObject.Properties.Name | Where-Object { $_ }) } else { @() }
$targets = @()
if ($portGiven) {
  $targets += @{ name = "(命令行 -Port)"; port = $Port }
} elseif ($shopNames.Count -gt 0) {
  if ($Shop) {
    if ($shopNames -contains $Shop) { $targets += @{ name = $Shop; port = [int]$e.shops.$Shop.port } }
    else { Bad "config.shops 里没有店「$Shop」；已登记：$($shopNames -join ' / ')" }
  } else {
    foreach ($n in $shopNames) { $targets += @{ name = $n; port = [int]$e.shops.$n.port } }
    if ($shopNames.Count -gt 1) { Write-Host ("  已登记 $($shopNames.Count) 家店，逐家检查：" + ($shopNames -join ' / ')) -ForegroundColor DarkGray }
  }
} else {
  $targets += @{ name = "(未登记店铺，用 default_port)"; port = [int]$e.default_port }
}
# 卖家域 = 已登录；登录域 = 还没登
$sellerRe = 'qn\.taobao\.com|item\.upload\.taobao\.com|myseller\.taobao\.com|sell\.taobao\.com|sycm\.taobao\.com|i\.taobao\.com'
$loginRe  = 'loginmyseller\.taobao\.com|login\.taobao\.com|login\.m\.taobao\.com'
foreach ($t in $targets) {
  $tp = $t.port
  try {
    $ver = Invoke-WebRequest -Uri "http://127.0.0.1:$tp/json/version" -UseBasicParsing -TimeoutSec 4
    Ok ("[$($t.name)] 端口 $tp 可达：" + (($ver.Content | ConvertFrom-Json).Browser))
    $list = Invoke-WebRequest -Uri "http://127.0.0.1:$tp/json/list" -UseBasicParsing -TimeoutSec 6
    $pages = @(($list.Content | ConvertFrom-Json) | Where-Object { $_.type -eq 'page' })
    # ⚠️ 两条都踩过：① 登录页 URL 的 redirectURL 参数里带着 item.upload.taobao.com；
    #    ② `loginmyseller.taobao.com` 含 `myseller` 子串会被 sellerRe 命中。
    #    → 只匹配 host，且 host 含 `login` 的一律不算卖家域。
    $hostOf = { param($u) if ($u -match '^https?://([^/?#]+)') { $matches[1] } else { '' } }
    $seller = @($pages | Where-Object { $h = & $hostOf $_.url; $h -match $sellerRe -and $h -notmatch 'login' })
    $login  = @($pages | Where-Object { (& $hostOf $_.url) -match $loginRe })
    if ($seller.Count -gt 0) {
      Ok ("[$($t.name)] 千牛/卖家页 $($seller.Count) 个（已登录）")
    } elseif ($login.Count -gt 0) {
      Bad "[$($t.name)] 端口 $tp 停在**卖家登录页** —— 请在该 Chrome 里登录千牛（本技能不代登录、不碰账号密码）"
    } else {
      Bad "[$($t.name)] 端口 $tp 里没有淘宝/千牛页面 —— 在该 Chrome 打开 https://qn.taobao.com/home.htm/QnworkbenchHome/ 并登录"
    }
    if ($pages.Count -gt 8) { Warn "[$($t.name)] 页面数 $($pages.Count) 偏多；连店时会先探活并跳过卡死页" }
  } catch {
    Bad "[$($t.name)] 端口 $tp 不可达 —— 该店 Chrome 没开、或没带 --remote-debugging-port=$tp（可用 scripts/open_browser.ps1 -Port $tp）"
  }
}

Head "5) 商品素材（可选）"
if (-not $ProductDir) {
  Write-Host "  （未传 -ProductDir，跳过；例如 -ProductDir `"D:\...\素材包\淘宝\MZB-001`"）" -ForegroundColor DarkGray
} elseif (-not (Test-Path $ProductDir)) {
  Bad "素材目录不存在：$ProductDir"
} else {
  Ok "素材目录：$ProductDir"
  # 淘宝这边主图/详情/规格图是独立目录；必传的是 1比1主图 + 宝贝详情
  foreach ($need in @('1比1主图', '宝贝详情')) {
    $d = Join-Path $ProductDir $need
    if (Test-Path $d) {
      $n = (Get-ChildItem $d -File -ErrorAction SilentlyContinue).Count
      if ($n -gt 0) { Ok "  $need：$n 个文件" } else { Bad "  $need 目录是空的（必传）" }
    } else { Bad "  缺目录：$need（必传）" }
  }
  foreach ($opt in @('3比4主图', '规格图片', 'SKU搜索主图', '宝贝视频', '白底图')) {
    $d = Join-Path $ProductDir $opt
    if (Test-Path $d) {
      $n = (Get-ChildItem $d -File -ErrorAction SilentlyContinue).Count
      Write-Host ("  [ ·  ] " + $opt + "：" + $n + " 个文件（选传）") -ForegroundColor DarkGray
    }
  }
}

Write-Host ""
if ($blockers.Count -gt 0) {
  Write-Host ("★ 有 $($blockers.Count) 项阻断，先修再开工：") -ForegroundColor Red
  $blockers | ForEach-Object { Write-Host ("   - " + $_) -ForegroundColor Red }
  exit 1
} elseif ($warns.Count -gt 0) {
  Write-Host ("✓ 通过（$($warns.Count) 条警告，看上面 [warn]）") -ForegroundColor Yellow
  exit 2
} else {
  Write-Host "✓ 全部通过，可以开工" -ForegroundColor Green
  exit 0
}
