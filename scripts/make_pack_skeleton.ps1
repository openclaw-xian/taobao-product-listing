# 素材包骨架生成器（编排）：catId → 一份能被技能读通的素材包
#
#   .\scripts\make_pack_skeleton.ps1 -CatId 50003280 -Out "D:\新素材包"
#
# 做三步：
#   ① scripts\pack_meta.js  打开发布页，从 DOM 读属性清单（属性名/pid/是否必填）
#   ② 同上，调 tb_download_template.js 下该类目官方 SKU 模板（规格列以它为准）
#   ③ scripts\make_pack_skeleton.py 拼出 商品信息.xlsx + 素材目录
#
# 注意：① 需要**已登录**的千牛（本技能不代登录）；② 官方模板表头决定这个类目是单层还是两层规格。
param(
  [Parameter(Mandatory = $true)][string]$CatId,
  [string]$Cat = '',
  [string]$ProductId = '示例商品A-01',
  [Parameter(Mandatory = $true)][string]$Out,
  [double]$ListPrice = 18.8,
  [string]$Port = '9120'
)

$ErrorActionPreference = 'Continue'   # 用 $LASTEXITCODE 显式判成败；'Stop' 会把 python 的 stderr 警告当终止错误
$root = $PSScriptRoot
if ((Split-Path $root -Leaf) -eq 'scripts') { $root = Split-Path $root -Parent }
Set-Location -LiteralPath $root

. (Join-Path $root 'scripts\resolve_env.ps1')
$e = $script:TbEnv
if (-not ($e.python -and (Test-Path $e.python))) { Write-Host "★ 找不到 python（先跑 scripts\preflight.ps1）" -ForegroundColor Red; exit 2 }

$tmp = Join-Path $root ("output\_skeleton\" + $CatId)
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host "==== ① 抓类目元数据（属性清单 + 官方模板）====" -ForegroundColor Cyan
$metaOut = & node "scripts\pack_meta.js" --catid $CatId --out $tmp --port $Port 2>&1
$metaOut | ForEach-Object { Write-Host ("   " + $_) }
if ($LASTEXITCODE -ne 0) { Write-Host ("★ 抓元数据失败（exit {0}）→ 停" -f $LASTEXITCODE) -ForegroundColor Red; exit 1 }

$attrsFile = ($metaOut | Where-Object { $_ -match '^ATTRS=' } | Select-Object -Last 1) -replace '^ATTRS=', ''
$tplFile = ($metaOut | Where-Object { $_ -match '^TPL=' } | Select-Object -Last 1) -replace '^TPL=', ''
$catFromPage = ($metaOut | Where-Object { $_ -match '^CAT=' } | Select-Object -Last 1) -replace '^CAT=', ''
if (-not $Cat) { $Cat = $catFromPage }
if (-not $Cat) { Write-Host "★ 没读到类目路径，请用 -Cat 手动指定" -ForegroundColor Red; exit 2 }
if (-not (Test-Path $attrsFile)) { Write-Host "★ 属性清单文件不存在：$attrsFile" -ForegroundColor Red; exit 2 }
if (-not (Test-Path $tplFile)) { Write-Host "★ 官方模板不存在：$tplFile" -ForegroundColor Red; exit 2 }

Write-Host ""
Write-Host "==== ② 拼装素材包 ====" -ForegroundColor Cyan
$pyArgs = @('scripts\make_pack_skeleton.py', '--catid', $CatId, '--cat', $Cat, '--pid', $ProductId, '--out', $Out,
            '--attrs-file', $attrsFile, '--tpl', $tplFile, '--listprice', $ListPrice)
& $e.python @pyArgs 2>&1 | ForEach-Object { Write-Host ("   " + $_) }
if ($LASTEXITCODE -ne 0) { Write-Host ("★ 生成失败（exit {0}）" -f $LASTEXITCODE) -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "==== ③ 自检：拿生成的包跑一次数据管道（只读，不动页面）====" -ForegroundColor Cyan
& (Join-Path $root 'scripts\run_listing.ps1') -Pack $Out -CatId $CatId -Cat $Cat -DryRun 2>&1 |
  Select-String '商品号|sheet|SKU 共|价格档|一口价|图片       |DryRun 结束|失败' |
  ForEach-Object { Write-Host ("   " + $_) }

Write-Host ""
Write-Host ("素材包已生成：{0}" -f $Out) -ForegroundColor Green
Write-Host ("  下一步：把图放进 淘宝\$ProductId 下各目录 → 跑 run_listing.ps1 -Pack `"$Out`" -CatId $CatId -Cat `"$Cat`"")
