param(
  [Parameter(Mandatory = $true)][string]$Pack,
  [string]$ProductId = '',
  [string]$CatId = '',
  [double]$ListPrice = 0,
  [string]$SizeSort = 'source'
)
# 把**素材包**一路准备成可跑的产物（不用人肉记三条命令）：
#   商品信息.xlsx ──tb_build.py──▶ output\<商品号>\product.json + sku_import*.xlsx
#   淘宝\<商品号>\ 的图 ──tb_prep_assets.js──▶ output\<商品号>\img\{1x1,3x4,detail,spec,skusearch}
# 缺该类目的官方 SKU 模板时会**尽力自动下载**（需要已有该类目的发布页；下不到只警告不阻塞）。
#
# 用法：
#   powershell -File scripts\build_from_pack.ps1 -Pack "D:\...\地毯发布素材包" -CatId 50000582
#   （-ProductId 可省：素材包 淘宝\ 下只有一个目录时自动取它）
# 输出：最后一行 PRODUCT_ID=<商品号>，供上层脚本解析
$ErrorActionPreference = 'Continue'
$skillRoot = Split-Path -Parent $PSScriptRoot
if ($skillRoot) { Set-Location $skillRoot }
. (Join-Path $PSScriptRoot 'resolve_env.ps1')
$e = $script:TbEnv

function Die($msg) { Write-Host ("★ " + $msg) -ForegroundColor Red; exit 1 }

if (-not (Test-Path -LiteralPath $Pack)) { Die ("-Pack 指向的目录不存在：" + $Pack) }
$packRoot = (Resolve-Path -LiteralPath $Pack).Path

# ---------- ① 找数据表 ----------
$xlsx = Join-Path $packRoot '商品信息.xlsx'
if (-not (Test-Path -LiteralPath $xlsx)) {
  $fe = Join-Path $packRoot '发品excel'
  if (Test-Path -LiteralPath $fe) {
    $cand = @(Get-ChildItem -LiteralPath $fe -File | Where-Object { $_.Extension -in '.xlsx', '.xls' })
    if ($ProductId) {
      $hit = @($cand | Where-Object { $_.BaseName -eq $ProductId })
      if ($hit.Count) { $xlsx = $hit[0].FullName }
    }
    if (-not (Test-Path -LiteralPath $xlsx) -and $cand.Count -eq 1) { $xlsx = $cand[0].FullName }
  }
}
if (-not (Test-Path -LiteralPath $xlsx)) {
  Die ("素材包里找不到数据表：需要在 <素材包>\商品信息.xlsx，或 <素材包>\发品excel\<商品号>.xlsx。" + "`n   现在看的是：" + $packRoot)
}
Write-Host ("① 数据表：" + $xlsx) -ForegroundColor Cyan

# ---------- ② 淘宝素材目录 → 商品号 ----------
$tbDir = Join-Path $packRoot '淘宝'
$subs = @()
if (Test-Path -LiteralPath $tbDir) { $subs = @(Get-ChildItem -LiteralPath $tbDir -Directory) }
if ($subs.Count -eq 0) { Die ("素材包里没有 淘宝\<商品号>\ 目录：" + $tbDir) }
# ★ 目录名就是权威：给定 ProductId 若不存在、且只有一个子目录，就用那个子目录的名字
if (-not $ProductId -or -not (Test-Path -LiteralPath (Join-Path $tbDir $ProductId))) {
  if ($subs.Count -eq 1) { $ProductId = $subs[0].Name }
  else { Die ("商品号对不上。淘宝\ 下有 {0} 个目录（{1}）→ 请用 -ProductId 指定其中一个" -f $subs.Count, (($subs | ForEach-Object { $_.Name }) -join ' / ')) }
} elseif ($subs.Count -eq 1 -and $subs[0].Name -ne $ProductId) {
  Write-Host ("   ⚠ -ProductId「{0}」与素材目录「{1}」不一致 → 以**目录名**为准（Excel 里的商品标识应与目录名相同）" -f $ProductId, $subs[0].Name) -ForegroundColor Yellow
  $ProductId = $subs[0].Name
}
Write-Host ("② 商品号：" + $ProductId) -ForegroundColor Cyan

$out = "output\$ProductId"
$prodJson = Join-Path $out 'product.json'

# ---------- ③ 官方 SKU 模板（按类目） ----------
$tplDir = 'output\_downloads'
$tpl = ''
if ($CatId) {
  if (Test-Path $tplDir) {
    $cand = @(Get-ChildItem -LiteralPath $tplDir -File | Where-Object { $_.Name -like ("SKU模板_" + $CatId + "_*") } | Sort-Object LastWriteTime -Descending)
    if ($cand.Count) { $tpl = $cand[0].FullName }
  }
  if (-not $tpl) {
    Write-Host ("③ 缺类目 {0} 的官方 SKU 模板 → 尝试自动下载（要有该类目的发布页）" -f $CatId) -ForegroundColor Yellow
    if ($e.node -and (Test-Path $e.node)) {
      & $e.node "scripts\tb_download_template.js" --catid $CatId --out $tplDir 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host ("   " + $_) }
      $cand = @(Get-ChildItem -LiteralPath $tplDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ("SKU模板_" + $CatId + "_*") } | Sort-Object LastWriteTime -Descending)
      if ($cand.Count) { $tpl = $cand[0].FullName }
    }
    if ($tpl) {
      Write-Host ("   ✓ 已下载：" + $tpl) -ForegroundColor Green
    } else {
      Write-Host "   ✗ 没下到模板（通常是因为还没有该类目的发布页）" -ForegroundColor Red
      Write-Host "     → product.json 仍可生成；但「SKU 批量导入」那一步会失败。" -ForegroundColor Yellow
      Write-Host "     补救：先跑一次入口进到该类目的发布页（scripts\tb_enter_form.js --catid $CatId），再重跑本脚本" -ForegroundColor Yellow
    }
  } else {
    Write-Host ("③ 官方 SKU 模板：" + $tpl) -ForegroundColor Cyan
  }
} else {
  Write-Host "③ 没给 -CatId → 跳过模板（SKU 导入那步可能会失败）" -ForegroundColor Yellow
}

# ---------- ④ 数据管道 ----------
if (-not ($e.python -and (Test-Path $e.python))) { Die "找不到 python（先跑 scripts\preflight.ps1 看怎么装）" }
$env:TB_XLSX = $xlsx
if ($tpl) { $env:TB_TEMPLATE = $tpl } else { Remove-Item Env:\TB_TEMPLATE -ErrorAction SilentlyContinue }
$buildArgs = @('scripts\tb_build.py', '--product-id', $ProductId, '--out', $out, '--size-sort', $SizeSort)
if ($ListPrice -gt 0) { $buildArgs += @('--list-price', ("{0}" -f $ListPrice)) }
Write-Host "④ 数据管道 tb_build.py …" -ForegroundColor Cyan
& $e.python @buildArgs 2>&1 | ForEach-Object { Write-Host ("   " + $_) }
if (-not (Test-Path $prodJson)) { Die ("tb_build 没产出 " + $prodJson) }

# ---------- ⑤ 拷图 ----------
if ($e.node -and (Test-Path $e.node)) {
  Write-Host "⑤ 拷图 tb_prep_assets.js …" -ForegroundColor Cyan
  & $e.node "scripts\tb_prep_assets.js" --pack $packRoot --product $prodJson 2>&1 | ForEach-Object { Write-Host ("   " + $_) }
} else {
  Write-Host "⑤ 跳过拷图（没有 node）" -ForegroundColor Yellow
}

# ---------- ⑥ 汇总 ----------
function Count-Img([string]$d) {
  if (-not (Test-Path $d)) { return 0 }
  return @(Get-ChildItem -LiteralPath $d -File | Where-Object { $_.Name -match '\.(jpe?g|png|webp)$' }).Count
}
$img = Join-Path $out 'img'
$c11 = Count-Img (Join-Path $img '1x1')
$cdet = Count-Img (Join-Path $img 'detail')
$cspec = Count-Img (Join-Path $img 'spec')
$c34 = Count-Img (Join-Path $img '3x4')

Write-Host ""
Write-Host "==================== 数据就绪 ====================" -ForegroundColor Green
Write-Host ("product.json : " + $prodJson)
Write-Host ("SKU 导入表   : " + (Join-Path $out 'sku_import_官方模板.xlsx') + "  （存在=" + (Test-Path (Join-Path $out 'sku_import_官方模板.xlsx')) + "）")
Write-Host ("图片         : 1:1 主图 {0} / 3:4 {1} / 宝贝详情 {2} / 规格图 {3}" -f $c11, $c34, $cdet, $cspec)
if ($c11 -eq 0 -or $cdet -eq 0) {
  Write-Host "  ⚠ 主图或详情图是 0 张 → 素材目录里没图？跑起来会跳过图片步骤" -ForegroundColor Yellow
}
Write-Host "PRODUCT_ID=$ProductId" -ForegroundColor Green
# ★ 这一行**必须走成功流**（Write-Output）：Write-Host 只写宿主、不进管道，
#   调用方 `$out = & build_from_pack.ps1 ...` 会**捕获不到**（实测踩到：商品号没传回去，
#   上层还在用默认 MZB-001，图片张数、product.json 路径全指错）。
Write-Output ("PRODUCT_ID=" + $ProductId)
exit 0
