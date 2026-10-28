param(
  [string]$ProductId = 'MZB-001',
  [string]$CatId = '50003280',
  [string]$Cat = '宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板',
  [string]$Shop = '',
  [string]$ProductDir = '',
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

# ★ 先过**开工前自检**：环境不通（端口不可达 / 千牛没登录 / 依赖缺）就**直接停**。
#   实测踩到：调试口的 Chrome 没开时，16 个步骤逐个抛 `connect ECONNREFUSED 127.0.0.1:9120`，
#   看起来像"技能坏了"，其实只是浏览器没起 —— 白白浪费一整轮。
#   （每个脚本连接前还有 `scripts\guard.js` 兜底；这一步是"动手前先看一遍"。）
#   多店铺：-Shop 店家名 透传给 preflight（店铺以 config.json 的 shops 为准，别写死）。
$pre = @{}
if ($Shop) { $pre['Shop'] = $Shop }
if ($ProductDir) { $pre['ProductDir'] = $ProductDir }
& "$PSScriptRoot\preflight.ps1" @pre
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "★ 环境不通（见上面 preflight 结果）→ 已在开工前停下，未改任何东西。"
  Write-Host "  起浏览器（**不代登录**，你自己登千牛）： powershell -File `"$PSScriptRoot\open_browser.ps1`""
  exit 1
}
Write-Host ""

if (-not (Test-Path $prod)) {
  Write-Host "★ 找不到 $prod —— 先跑数据管道把素材包读成 product.json + SKU 导入表："
  Write-Host "    python scripts\tb_build.py --xlsx `"<素材包>\发品excel\<商品号>.xlsx`" --product-id $ProductId --out output\$ProductId"
  Write-Host "    （换过类目还要加 --from-template output\_downloads\SKU模板_<catId>_*.xls，模板用 scripts\tb_download_template.js 下）"
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
$mainCount = if ($MainLimit -gt 0) { [Math]::Min($MainLimit, $mainTotal) } else { $mainTotal }
Write-Host ("图片素材：1x1 主图 {0} 张（本次传 {1}）；宝贝详情 {2} 张（每批 {3}）" -f $mainTotal, $mainCount, $detailTotal, $DetailBatch)
if ($mainTotal -gt $mainCount) {
  Write-Host ("  ⚠️ -MainLimit 限成 {0} 张：素材目录里还有 {1} 张这次不会传（核对清单的'主图空槽'口径要按 {0} 看）" -f $mainCount, ($mainTotal - $mainCount)) -ForegroundColor Yellow
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
$steps['6 spec add-image']        = "node scripts\tb_spec_add_image.js --product $prod"
$steps['7 spec images']           = "node scripts\tb_fill_spec_images.js --dir $img\spec --product $prod"
$steps['7b verify spec images']   = "node tests\verify_spec_images.js"
$steps['8 spec confirm']          = "node scripts\tb_spec_add_image.js --confirm"
$steps['9 checklist']             = "node scripts\tb_checklist.js --product $prod"
$steps['10 save draft']           = "node scripts\tb_save_draft.js"

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
