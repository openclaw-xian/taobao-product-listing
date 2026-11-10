param(
  [string]$ProductId = 'MZB-001',
  [string]$CatId = '50003280',
  [string]$Cat = '宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板',
  [string]$Shop = '',
  [int]$Port = 0,           # 0 = 按 -Shop / config.shops / default_port 解析
  [string]$ProductDir = '',
  # ★ 素材包根目录（如 C:\...\地毯发布素材包）。给了就**自动**做数据管道：
  #   找 商品信息.xlsx → tb_build.py → tb_prep_assets.js（拷图到 output\<商品号>\img）。
  #   这样"安装后只要把素材包路径给它"就能一条命令跑完，不用先手工跑 python。
  [string]$Pack = '',
  [double]$ListPrice = 0,   # 一口价；0 = 让 tb_build 取最低 SKU 价（**会明确打印出来**）
  [string]$SizeSort = 'source',   # source = 照源表顺序；natural = 按数值(宽度优先)
  [switch]$DryRun,          # 只做自检 + 数据准备 + 打印计划，**不碰页面**
  [int]$MainLimit = 0,      # 0 = 按 output\<商品号>\img\1x1 里的实际张数（= 素材目录口径）
  [int]$DetailBatch = 20    # 详情图每批张数：实测一批喂 >20 会被截断
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
if ($root) { Set-Location $root }
$env:TB_CAT = $Cat
$env:TB_CATID = $CatId
$img = "output\$ProductId\img"
$prod = "output\$ProductId\product.json"

# ★★ 解析本次要用的 CDP 端口并**下发**给所有子脚本。
#   踩过：原来只设了 TB_CAT / TB_CATID，**没有 TB_PORT** → preflight 按店从 config.json 解析端口、
#   判定"可以开工"，而后面每个 node 脚本读不到 TB_PORT 就**一律默认 9120** →
#   同事那家店不在 9120 时，自检全绿、16 步却全部 ECONNREFUSED 全红（看着像技能坏了）。
$cfgFile = Join-Path $root 'config.json'
$cfg = $null
try { $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
$shopNames = @()
if ($cfg -and $cfg.PSObject.Properties.Name -contains 'shops' -and $cfg.shops) {
  $shopNames = @($cfg.shops.PSObject.Properties.Name | Where-Object { $_ })
}

# ★★ 首次运行**自动生成 config.json**：装完就报"shops 里没有店"是最常见的卡点。
#   规则：给了 -Shop 就直接写进去（端口取 -Port / default_port / 9120），
#        没给且终端是交互的 → 问一次；非交互（被脚本调用/重定向）→ 打印怎么写，然后停。
if ($shopNames.Count -eq 0) {
  $newPort = if ($Port -gt 0) { $Port } elseif ($cfg -and $cfg.default_port) { [int]$cfg.default_port } else { 9120 }
  $newShop = $Shop
  if (-not $newShop -and -not [Console]::IsInputRedirected) {
    Write-Host "首次运行：config.json 里还没有登记店铺。" -ForegroundColor Cyan
    $newShop = (Read-Host "  你的店名（如 贝语辰的小店3）").Trim()
    $pIn = (Read-Host ("  这个店的 Chrome 调试端口（直接回车 = {0}）" -f $newPort)).Trim()
    if ($pIn -match '^\d+$') { $newPort = [int]$pIn }
  }
  if ($newShop) {
    $base = if ($cfg) { $cfg } else { [pscustomobject]@{} }
    $obj = [ordered]@{}
    foreach ($k in @('chrome', 'chrome_profile', 'node', 'npm', 'python', 'playwright_core', 'workdir')) {
      $obj[$k] = if ($cfg -and $cfg.PSObject.Properties.Name -contains $k) { $cfg.$k } else { '' }
    }
    $obj['default_port'] = $newPort
    $obj['reuse_profile'] = $true
    $obj['shops'] = [ordered]@{}
    $obj['shops'][$newShop] = [ordered]@{ port = $newPort; note = '首次运行自动登记' }
    $json = ($obj | ConvertTo-Json -Depth 6)
    [System.IO.File]::WriteAllText($cfgFile, $json, [System.Text.UTF8Encoding]::new($false))
    Write-Host ("✓ 已写入 config.json：店「{0}」端口 {1}（其余字段留空 = 自动探测）" -f $newShop, $newPort) -ForegroundColor Green
    $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $shopNames = @($newShop)
  } else {
    Write-Host "★ config.json 里没有登记店铺 → 先登记一家，再重跑：" -ForegroundColor Red
    Write-Host '   直接加参数： -Shop "你的店名" -Port 9120    （本脚本会帮你写进 config.json）'
    Write-Host '   或手工编辑 config.json 的 "shops": { "你的店名": { "port": 9120 } }'
    exit 1
  }
}

$usePort = 0
if ($Port -gt 0) {
  $usePort = $Port
} elseif ($Shop) {
  if ($shopNames -contains $Shop) { $usePort = [int]$cfg.shops.$Shop.port }
  else { Write-Host ("★ config.json 的 shops 里没有店「{0}」；已登记：{1}" -f $Shop, ($shopNames -join ' / ')) -ForegroundColor Red; exit 1 }
} elseif ($shopNames.Count -eq 1) {
  $Shop = $shopNames[0]
  $usePort = [int]$cfg.shops.($shopNames[0]).port
} elseif ($shopNames.Count -gt 1) {
  # ★ 多店时**不猜**：猜错就是"填到了另一家店"。要么 -Shop，要么 -Port。
  Write-Host ("★ 已登记 {0} 家店（{1}）→ 请用 -Shop <店名> 或 -Port <端口> 指定这次发哪家" -f $shopNames.Count, ($shopNames -join ' / ')) -ForegroundColor Red
  exit 1
} elseif ($cfg -and $cfg.default_port) {
  $usePort = [int]$cfg.default_port
}
if ($usePort -gt 0) {
  $env:TB_PORT = "$usePort"
  if ($Shop) { $env:TB_SHOP = $Shop }
  $who = if ($Shop) { "（店：$Shop）" } else { '' }
  Write-Host ("本次 CDP 端口：{0}{1}" -f $usePort, $who) -ForegroundColor Cyan
} else {
  Write-Host "⚠ 解析不到端口（config.json 没有 shops 也没有 default_port）→ 子脚本会各自默认 9120" -ForegroundColor Yellow
}

# ★ 先过**开工前自检**：环境不通（端口不可达 / 千牛没登录 / 依赖缺）就**直接停**。
#   实测踩到：调试口的 Chrome 没开时，16 个步骤逐个抛 `connect ECONNREFUSED 127.0.0.1:9120`，
#   看起来像"技能坏了"，其实只是浏览器没起 —— 白白浪费一整轮。
#   （每个脚本连接前还有 `scripts\guard.js` 兜底；这一步是"动手前先看一遍"。）
#   多店铺：-Shop 店家名 透传给 preflight（店铺以 config.json 的 shops 为准，别写死）。
$pre = @{}
if ($Shop) { $pre['Shop'] = $Shop }
if ($Port -gt 0) { $pre['Port'] = $Port }
if ($ProductDir) { $pre['ProductDir'] = $ProductDir }
# -DryRun 只验"装好了没" → 不查端口/登录态（没开浏览器也能跑，新人零成本确认安装）
if ($DryRun) { $pre['SkipCdp'] = $true }
& "$PSScriptRoot\preflight.ps1" @pre
# ⚠️ preflight 的退出码约定是：0=全过 / 1=有阻断 / **2=只有警告（可以开工）**。
#    原来写的是 `-ne 0` 就停 → 只要有一条警告（例如 -SkipCdp、页面数偏多）就被误判成环境不通。
$preCode = $LASTEXITCODE
if ($preCode -eq 1) {
  Write-Host ""
  Write-Host "★ 环境不通（见上面 preflight 结果）→ 已在开工前停下，未改任何东西。"
  Write-Host "  起浏览器（**不代登录**，你自己登千牛）： powershell -File `"$PSScriptRoot\open_browser.ps1`""
  exit 1
}
if ($preCode -eq 2) { Write-Host "⚠ 自检有警告（不阻断）→ 继续" -ForegroundColor Yellow }
Write-Host ""

# ★★ 数据准备：给了 -Pack 就**自动**把素材包跑成 product.json + SKU 导入表 + img。
#   这是"装完一条命令能跑"的关键一步 —— 原来只打印一段提示就 exit 1，新人必然卡在这儿。
if ($Pack) {
  Write-Host "==== 数据准备（-Pack：素材包 → product.json / SKU 导入表 / 图片）====" -ForegroundColor Cyan
  $packOut = @(& "$PSScriptRoot\build_from_pack.ps1" -Pack $Pack -ProductId $ProductId -CatId $CatId -ListPrice $ListPrice -SizeSort $SizeSort 2>&1)
  # ★ 必须看**退出码**，不能只看 product.json 在不在：output\<商品号>\ 里可能留着**上次的旧产物**，
  #   数据准备其实失败了也会被判成"已就绪"，然后整条链跑在过期数据上（实测踩到）。
  $packCode = $LASTEXITCODE
  $packOut | ForEach-Object { Write-Host $_ }
  # 从 build_from_pack 最后一行 PRODUCT_ID= 取回真实商品号（可能被素材目录名改写）。
  #   别用 -match + $Matches（在 ForEach-Object/管道里 $Matches 会被覆盖，实测没解析上）→ 用 StartsWith。
  $prefix = 'PRODUCT_ID='
  foreach ($line in @($packOut)) {
    $s = ("" + $line).Trim()
    if ($s.StartsWith($prefix)) { $ProductId = $s.Substring($prefix.Length).Trim() }
  }
  if ($packCode -ne 0) {
    Write-Host ("★ 数据准备失败（build_from_pack 退出码 {0}）→ 停。上面第一行就是原因。" -f $packCode) -ForegroundColor Red
    Write-Host "  （不会拿 output 里的旧产物凑合往下跑 —— 那样会把过期数据发到店里）"
    exit 1
  }
  Write-Host ("   → 本次商品号：" + $ProductId) -ForegroundColor Cyan
  # 商品号可能被素材目录名改写 → 路径要重新指向
  $img = "output\$ProductId\img"
  $prod = "output\$ProductId\product.json"
  if (-not (Test-Path $prod)) {
    Write-Host "★ 数据准备没成功（没有 $prod）→ 先解决上面 build_from_pack 报的问题，再重跑" -ForegroundColor Red
    exit 1
  }
  Write-Host ""
} elseif (-not (Test-Path $prod)) {
  Write-Host "★ 找不到 $prod —— 两种办法："
  Write-Host "   ① 推荐：给 -Pack 让本脚本自动做数据管道，例："
  Write-Host '      -Pack "D:\...\地毯发布素材包" -ProductId xxx -CatId 50000582 -Cat "居家布艺 > 地毯"'
  Write-Host "   ② 手工跑（等价于 ① 内部做的事）："
  Write-Host "      python scripts\tb_build.py --xlsx `"<素材包>\商品信息.xlsx`" --product-id $ProductId --out output\$ProductId"
  Write-Host "      node   scripts\tb_prep_assets.js --pack `"<素材包>`" --product output\$ProductId\product.json"
  exit 1
}

# ★ 图片张数**按素材目录实际数**，不写死（2026-10-14 修，两条都是实测踩出来的）：
#   · 详情图写死 `--skip 20 --limit 20` 时：素材 ≤20 张的商品（MZB-001=20 / PE-001=19 / MZB-003=11）
#     第二批拿到**空切片** → tb_upload_detail.js 第 42 行直接 `process.exit(2)` → 整链记成"失败步"，
#     而其实什么都没坏（假失败，害人去查一个不存在的 bug）。只有 DT（26 张）恰好 20+6 才通过。
#   · 主图写死 `--limit 5` 时：素材 10 张的商品（PE-001）**静默只传 5 张**，核对清单也看不出来 —— 比报错更危险。
#     → 默认"素材目录有几张就传几张"，要少传就显式给 -MainLimit 并把差额打印出来。
function Get-ImgCount([string]$d) {
  if (-not (Test-Path $d)) { return 0 }
  return @(Get-ChildItem -LiteralPath $d -File | Where-Object { $_.Name -match '\.(jpe?g|png|webp)$' }).Count
}
$mainTotal = Get-ImgCount "$img\1x1"
$detailTotal = Get-ImgCount "$img\detail"
# ★ 淘宝 1:1 主图**平台上限就是 5 张**（发布页原文：「至多可上传5张」）。
#   原来默认"目录有几张就传几张" → 素材 10 张的商品（MZB-001）会去填第 6 个槽，必然失败。
$PLATFORM_MAIN_MAX = 5
$mainCount = if ($MainLimit -gt 0) { [Math]::Min($MainLimit, $mainTotal) } else { [Math]::Min($PLATFORM_MAIN_MAX, $mainTotal) }
Write-Host ("图片素材：1x1 主图 {0} 张（本次传 {1}）；宝贝详情 {2} 张（每批 {3}）" -f $mainTotal, $mainCount, $detailTotal, $DetailBatch)
if ($mainTotal -gt $mainCount) {
  Write-Host ("  ℹ️ 1x1 主图素材 {0} 张，本次传前 {1} 张（平台上限 {2} 张；要改顺序就调整 img\1x1 里的文件名）" -f $mainTotal, $mainCount, $PLATFORM_MAIN_MAX) -ForegroundColor DarkGray
}
if ($mainTotal -eq 0 -or $detailTotal -eq 0) {
  Write-Host "  ⚠️ 有图片目录是空的 —— 先跑 scripts\tb_prep_assets.js 把素材包的图拷进 output\<商品号>\img\ 再跑本编排" -ForegroundColor Yellow
}

# ★ 历史（2026-10-13 实测：地毯 DT-雨棚消音垫-1057991085138 端到端全绿）：
#   · 去掉「3b 计价单位」：那是墙纸类目的复合控件（脚本留着：scripts\tb_fill_measure.js），别的类目没这个字段
#   · 详情图改成**完整闭环分批**：一次喂太多会被截断（26 张只进 18 张），
#     且"上一批还挂着待确定"时再传下一批会被吞点击 → 每批 ≤20 张，各自「上传 → 自动全选 → 点确定」
#   · 规格图加「核查 src 不重复」：只看「9 图位/9 有图/0 空位」会被骗，实测 9 个槽挂过同一张图
#   · 收尾加「保存草稿」：本店草稿箱已可写入（门禁 18）
$steps = [ordered]@{}
$steps['1 entry/cat/brand']       = "node scripts\tb_enter_form.js --catid $CatId --force --product $prod"
# ★ 填属性前先清**任何**残留弹窗：实测「批量导入」之类的浮层停在页面正中会盖住中间那排属性
#   （品牌 p-20000 / 主图案类型 / 适用空间 的坐标全落在它范围内 → 真实鼠标点全部点不中，
#    表现成「无选项 / 读回为空」，同事那台的"品牌输入被残留遮罩挡住"就是这一类）。
$steps['1b clear dialogs']        = "node scripts\close_dialogs.js --all"
$steps['2 title/attrs/code']      = "node scripts\tb_fill_basic.js --product $prod"
$steps['3 sku/listprice']         = "node scripts\tb_import_sku.js --product $prod"
$steps['3c recheck attrs']        = "node scripts\tb_fill_basic.js --product $prod"
$steps['4a close panel']          = "node scripts\close_material_panel.js"
if ($mainCount -gt 0) {
  $steps["4 main images ($mainCount)"] = "node scripts\tb_upload_main.js --dir $img\1x1 --limit $mainCount"
} else {
  Write-Host "  [skip] 4 main images：$img\1x1 里没有图" -ForegroundColor Yellow
}
$steps['4b close panel']          = "node scripts\close_material_panel.js"
if ($detailTotal -gt 0) {
  # 分批 = 每批各自走完「上传 → 自动全选 → 确定」，不跨批挂待确定状态
  $done = 0; $n = 0
  while ($done -lt $detailTotal) {
    $n++
    $lim = [Math]::Min($DetailBatch, $detailTotal - $done)
    $steps[("5.{0} detail images ({1}-{2})" -f $n, ($done + 1), ($done + $lim))] =
      "node scripts\tb_upload_detail.js --dir $img\detail --skip $done --limit $lim --batch $lim"
    $done += $lim
  }
} else {
  Write-Host "  [skip] 5 detail images：$img\detail 里没有图" -ForegroundColor Yellow
}
$steps['5c close panel']          = "node scripts\close_material_panel.js"
$steps['5d clear dialogs']        = "node scripts\close_dialogs.js --all"
$steps['6 spec add-image']        = "node scripts\tb_spec_add_image.js --product $prod"
$steps['7 spec images']           = "node scripts\tb_fill_spec_images.js --dir $img\spec --product $prod"
$steps['7b verify spec images']   = "node tests\verify_spec_images.js"
$steps['8 spec confirm']          = "node scripts\tb_spec_add_image.js --confirm"
$steps['9 checklist']             = "node scripts\tb_checklist.js --product $prod"
$steps['10 save draft']           = "node scripts\tb_save_draft.js"

# ★ -DryRun：只做"自检 + 数据准备"，把**将要执行的每一步**列出来，**不碰任何页面**。
#   给第一次装好的人一个零风险确认方式（不用拿真店铺试）。
if ($DryRun) {
  Write-Host ""
  Write-Host "==================== DryRun：只打印计划，不动页面 ====================" -ForegroundColor Cyan
  Write-Host ("商品号   : " + $ProductId)
  Write-Host ("类目     : " + $Cat + "  (catId " + $CatId + ")")
  Write-Host ("端口     : " + $(if ($env:TB_PORT) { $env:TB_PORT } else { "（未解析）" }) + $(if ($Shop) { "  店：$Shop" } else { "" }))
  Write-Host ("product.json : " + $(if (Test-Path $prod) { "✓ 已就绪" } else { "✗ 缺失（正式跑时给 -Pack 会自动生成）" }))
  Write-Host ("图片素材 : 1:1 " + $mainTotal + " 张（本次传 " + $mainCount + "） / 详情 " + $detailTotal + " 张（每批 " + $DetailBatch + "）")
  Write-Host ""
  Write-Host ("将按顺序执行 " + $steps.Count + " 步：") -ForegroundColor Green
  $i = 0
  foreach ($k in $steps.Keys) {
    $i++
    Write-Host ("  {0,2}. {1,-24} {2}" -f $i, $k, $steps[$k])
  }
  Write-Host ""
  Write-Host "★ DryRun 结束：什么都没有提交、没有打开页面。去掉 -DryRun 即可正式跑。" -ForegroundColor Yellow
  exit 0
}

$bad = @()
foreach ($k in $steps.Keys) {
  Write-Host ""
  Write-Host ("===== " + $k + " =====")
  # ★ 捕获输出并落盘：**完全没有输出 = 疑似空跑**，也算失败。
  #   实测踩到：核对清单在整链里跑过一次"exit 0 但一行输出都没有"（单跑正常、14 项全绿）——
  #   这种静默空跑会被当成绿，比报错更危险。
  $o = (Invoke-Expression $steps[$k] 2>&1 | Out-String)
  $code = $LASTEXITCODE
  Write-Host $o.TrimEnd()
  if ($code -ne 0) { $bad += ($k + " (exit=" + $code + ")"); Write-Host "  [X] failed" }
  elseif ([string]::IsNullOrWhiteSpace($o)) { $bad += ($k + " (无输出=疑似空跑)"); Write-Host "  [X] 无输出" }
}
Write-Host ""
if ($bad.Count -eq 0) { Write-Host "DONE: all green" }
else { Write-Host "DONE: failed steps"; $bad | ForEach-Object { Write-Host ("   - " + $_) } }
Write-Host "NOTE: review the page and submit it yourself."
