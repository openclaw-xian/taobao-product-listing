# 一条命令自检：证明「这套技能在当前机器上可用」。
#
# 为什么要有它：交接文档里的「记得做」全都会腐烂（BOM、门禁编号、引用路径…）。
# 凡是能机械检查的，就不要靠记性 —— 这个脚本就是那些检查的落点。
#
# 用法：
#   & "<skillRoot>\scripts\selftest.ps1"           # 全跑（含 preflight：会连 CDP 端口看千牛登录态）
#   & "<skillRoot>\scripts\selftest.ps1" -Quick    # 跳过 preflight（不碰浏览器/端口）
#
# 退出码：0 = 全绿可开工；1 = 有失败项（每条都带「怎么修」）
param(
  [switch]$Quick
)

$ErrorActionPreference = 'Continue'
$skillRoot = Split-Path -Parent $PSScriptRoot
$script:pass = 0
$script:fail = New-Object System.Collections.Generic.List[string]

function Ok($msg)  { Write-Host ("  [ OK ] " + $msg) -ForegroundColor Green; $script:pass++ }
function Bad($msg, $fix) {
  Write-Host ("  [FAIL] " + $msg) -ForegroundColor Red
  if ($fix) { Write-Host ("         修法：" + $fix) -ForegroundColor DarkYellow }
  $script:fail.Add($msg)
}
function Warn($msg) { Write-Host ("  [warn] " + $msg) -ForegroundColor Yellow; $script:pass++ }
function Head($msg) { Write-Host ("" + $msg) -ForegroundColor Cyan }

Write-Host "==== 淘宝上架技能 · 自检 ====" -ForegroundColor Cyan
Write-Host ("技能根 = " + $skillRoot)

# ---------- 1) .ps1 必须带 BOM ----------
Head "== 1) .ps1 编码（UTF-8 带 BOM）=="
$ps1 = Get-ChildItem (Join-Path $skillRoot "scripts\*.ps1")
foreach ($f in $ps1) {
  $b = [System.IO.File]::ReadAllBytes($f.FullName)
  $bom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  if ($bom) { Ok ($f.Name + " BOM ok") }
  else { Bad ($f.Name + " 缺 BOM（PS 5.1 会按 GBK 读，中文串烂掉）") "补 BOM：python -c `"p=r'<path>';d=open(p,'rb').read();open(p,'wb').write(b'\xef\xbb\xbf'+d if not d.startswith(b'\xef\xbb\xbf') else d)`"" }
}

# ---------- 1b) 文件不能是「空的/被截断的」----------
# 为什么要有这条：改脚本时很容易写出「同一表达式里既 open('w') 又 .read()」的写法 ——
# 'w' 先把文件截断，后面读到的就是空的 → 文件只剩 3 字节 BOM，脚本静默变成空脚本（实测踩过，事故 F）。
Head "== 1b) 脚本非空（防自我截断）=="
$minBytes = 200
$thin = @()
foreach ($f in @(Get-ChildItem (Join-Path $skillRoot "scripts\*.*") | Where-Object { $_.Extension -in @('.ps1', '.js', '.py') })) {
  if ($f.Length -lt $minBytes) { $thin += ("$($f.Name) ($($f.Length)B)") }
}
if ($thin.Count -eq 0) { Ok ("脚本都不小于 " + $minBytes + " 字节") }
else { Bad ("这些脚本异常小、像是被截断了：" + ($thin -join ', ')) "从 _backup / 版本记录恢复；改文件时永远「先读完再写」" }

# ---------- 2) 运行环境 ----------
Head "== 2) 运行环境 =="
. (Join-Path $skillRoot "scripts\resolve_env.ps1")
if (-not $TbEnv.python -or -not (Test-Path $TbEnv.python)) { Bad "python 没解析出来" "检查 config.json 的 python / 环境变量 MIMO_PYTHON" }
else { Ok ("python = " + $TbEnv.python) }
if (-not $TbEnv.node -or -not (Test-Path $TbEnv.node)) { Bad "node 没解析出来" "装 Node.js 或在 config.json 里写 node 路径" }
else { Ok ("node = " + $TbEnv.node) }

$py = $TbEnv.python
$node = $TbEnv.node
if ($py -and $node) {

  # ---------- 3) 语法 ----------
  Head "== 3) 语法 =="
  $pyFiles = @(Get-ChildItem (Join-Path $skillRoot "scripts\*.py") -ErrorAction SilentlyContinue)
  if ($pyFiles.Count -eq 0) { Warn "scripts 下还没有 .py（数据管道待建）" }
  else {
    $badPy = 0
    foreach ($f in $pyFiles) { & $py -m py_compile $f.FullName 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { $badPy++; Bad ("python 语法错：" + $f.Name) "看 py_compile 的报错行号" } }
    if ($badPy -eq 0) { Ok ($pyFiles.Count.ToString() + " 个 .py 语法通过") }
  }
  $jsFiles = @(Get-ChildItem (Join-Path $skillRoot "scripts\*.js") -ErrorAction SilentlyContinue)
  $badJs = 0
  foreach ($f in $jsFiles) { & $node --check $f.FullName 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { $badJs++; Bad ("js 语法错：" + $f.Name) "看 node --check 的报错" } }
  if ($badJs -eq 0) { Ok ($jsFiles.Count.ToString() + " 个 .js 语法通过") }

  # ---------- 4) SKILL.md 门禁编号 ----------
  Head "== 4) SKILL.md 门禁编号 =="
  $skillPath = Join-Path $skillRoot "SKILL.md"
  $txt = [System.IO.File]::ReadAllText($skillPath, [System.Text.Encoding]::UTF8)
  $expected = 1
  $gaps = @()
  foreach ($m in [regex]::Matches($txt, "(?m)^(\d+)\. ")) {
    $n = [int]$m.Groups[1].Value
    if ($n -eq $expected) { $expected++ } elseif ($n -gt $expected) { $gaps += ("缺 " + $expected); $expected = $n + 1 }
  }
  if ($expected -le 1) { Bad "SKILL.md 里一条编号门禁都没有" "把「坑/规则」写成编号门禁（抖店那边是 1..48）" }
  elseif ($gaps.Count -eq 0) { Ok ("门禁编号 1.." + ($expected - 1) + " 连续") }
  else { Bad ("门禁编号不连续：" + ($gaps -join ", ")) "补上缺号，或把后面整体重编号" }
  $maxGate = $expected - 1
  $refMax = 0
  foreach ($m in [regex]::Matches($txt, "门禁\s*(\d+)")) { $v = [int]$m.Groups[1].Value; if ($v -gt $refMax) { $refMax = $v } }
  if ($refMax -le $maxGate) { Ok ("「门禁 N」引用最大 = " + $refMax + " ≤ 实际 " + $maxGate) }
  else { Bad ("「门禁 N」引用越界：引用了 门禁 " + $refMax + "，但只到 " + $maxGate) "插入/删除门禁后反向引用没同步" }

  # ---------- 5) 必备文件 ----------
  Head "== 5) 必备文件 =="
  $must = @(
    "SKILL.md", "config.json", "locales\zh-CN.json", "locales\en-US.json",
    "scripts\resolve_env.ps1", "scripts\preflight.ps1", "scripts\selftest.ps1", "scripts\open_browser.ps1",
    "scripts\pwresolver.js", "scripts\which_pw.js",
    "tools\npm\node_modules\playwright-core"
  )
  $miss = @()
  foreach ($m in $must) { if (-not (Test-Path (Join-Path $skillRoot $m))) { $miss += $m } }
  if ($miss.Count -eq 0) { Ok ($must.Count.ToString() + " 个必备文件/目录都在") }
  else { Bad ("缺文件：" + ($miss -join ", ")) "从备份补齐；这些是交接与自检的支点" }

  # ---------- 6) config.json ----------
  Head "== 6) config.json（店铺登记）=="
  try { $cfg = Get-Content -Raw -Encoding UTF8 (Join-Path $skillRoot "config.json") | ConvertFrom-Json } catch { $cfg = $null }
  if (-not $cfg) { Bad "config.json 解析失败" "看是否被写坏（重复键/少逗号）；PS 5.1 读它必须显式 -Encoding UTF8" }
  else {
    $shopNames = if ($cfg.shops) { @($cfg.shops.PSObject.Properties.Name | Where-Object { $_ }) } else { @() }
    if ($shopNames.Count -eq 0) { Warn "config.shops 里还没登记店（登录千牛后把店名+端口填进去；单店也建议登记）" }
    else {
      $ports = @(); $badShop = @()
      foreach ($n in $shopNames) { $p = $cfg.shops.$n.port; if (-not $p) { $badShop += $n } else { $ports += [int]$p } }
      $dup = @($ports | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
      if ($badShop.Count -gt 0) { Bad ("这些店没有 port：" + ($badShop -join ', ')) "一店一 Chrome 实例一端口，补上 port" }
      elseif ($dup.Count -gt 0) { Bad ("端口重复：" + ($dup -join ', ')) "一店一端口：两家店共用端口 = 其实在同一家店里填表" }
      else { Ok ("shops：" + $shopNames.Count + " 家 / 端口 " + ($ports -join ', ')) }
    }
  }

  # ---------- 7) playwright-core ----------
  Head "== 7) playwright-core =="
  $pw = & $node (Join-Path $skillRoot "scripts\which_pw.js") 2>&1 | Out-String
  if ($pw -match '"ok":\s*true') {
    $spec = ([regex]::Match($pw, '"spec":\s*"([^"]+)"')).Groups[1].Value
    $specSafe = $spec -replace '\\\\', '\'
    if ($specSafe -match 'tools\\npm') { Ok ("技能自带副本（换机器也能跑）：" + $specSafe) }
    else { Warn ("仅机器级解析：" + $specSafe) }
  } else { Bad "playwright-core 解析失败" "确认 tools\npm\node_modules\playwright-core 在" }

  # ---------- 7b) 夹具干跑（待建）----------
  Head "== 7b) 夹具干跑 =="
  $fixture = Join-Path $skillRoot "tests\fixture_out\product.json"
  if (Test-Path $fixture) { Ok "夹具在（$fixture）" }
  else { Warn "还没有回归夹具（tests\fixture_out）—— 做法照 douyin-product-listing；有它才能在不动真店的情况下回归" }
}

# ---------- 8) preflight ----------
if ($Quick) {
  Head "== 8) preflight（-Quick 跳过）=="
  Write-Host "  跳过了（要连 CDP 端口/看千牛登录态就跑不带 -Quick 的）" -ForegroundColor DarkGray
} else {
  Head "== 8) preflight（端口/千牛登录态）=="
  $pf = & (Join-Path $skillRoot "scripts\preflight.ps1") 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) { Ok "preflight 通过" }
  elseif ($LASTEXITCODE -eq 2) { Warn "preflight 有警告（exit 2）" }
  else { Bad ("preflight 阻断（exit " + $LASTEXITCODE + "）") "看 preflight 输出里标 [FAIL] 的那条" }
  Write-Host $pf
}

# ---------- 9) 文档一致性（引用存在 + 无裸 CR）----------
# 为什么要有这条：SKILL/HANDOVER 里写的 `scripts\xxx.js` 是**给下一个 agent 照着跑的**，
# 引用指向不存在的文件、或路径被 `\r` 这类转义吃掉断成两行，接手的人会去跑一个跑不了的东西
# （实测踩过：实战记录里 `scripts\run_listing.ps1` 被写成 CR 断裂的两行）。
# 注意：`references\RECON.md` 故意不查 —— 它是追加式日记，留着历史「试过又删掉」的脚本名是正常的。
Head "== 9) 文档一致性 =="
$docs = @("SKILL.md", "HANDOVER.md", "references\playbook.md", "references\ops-notes.md", "config.json")
$missingRef = @(); $bareCr = @()
foreach ($d in $docs) {
  $dp = Join-Path $skillRoot $d
  if (-not (Test-Path $dp)) { continue }
  $dtxt = [System.IO.File]::ReadAllText($dp, [System.Text.Encoding]::UTF8)
  # ① 文档提到的 scripts\… / tests\… 文件必须真实存在
  foreach ($m in [regex]::Matches($dtxt, '(?i)(scripts|tests)[\\/]([A-Za-z0-9_.\-]+\.(?:js|ps1|py))')) {
    $rel = $m.Groups[1].Value + "\" + $m.Groups[2].Value
    if (-not (Test-Path (Join-Path $skillRoot $rel))) { $missingRef += ("$d → $rel") }
  }
  # ② 不能有「裸 CR」（`\r` 被当转义写进文档 → 路径断成两行）
  $bare = @([regex]::Matches($dtxt, '\r(?!\n)')).Count
  if ($bare -gt 0) { $bareCr += ("$d (" + $bare + " 处)") }
}
if ($missingRef.Count -eq 0) { Ok "文档里的 scripts\ / tests\ 引用都指向真实文件" }
else { Bad ("文档引用了不存在的文件：" + ($missingRef -join "; ")) "要么补文件，要么把文档里的路径改对" }
if ($bareCr.Count -eq 0) { Ok "文档里没有裸 CR（路径不会被转义吃断）" }
else { Bad ("文档里有裸 CR：" + ($bareCr -join "; ")) "把那个回车换回字面反斜杠 + r（两个字符），别用 \r 这种转义串写路径" }

# ---------- 结论 ----------
Write-Host ""
if ($script:fail.Count -eq 0) {
  Write-Host ("★ 自检全绿：" + $script:pass + " 项通过（含 warn）") -ForegroundColor Green
  exit 0
} else {
  Write-Host ("★ 自检未过：" + $script:fail.Count + " 项失败 / " + $script:pass + " 项通过") -ForegroundColor Red
  foreach ($f in $script:fail) { Write-Host ("   - " + $f) -ForegroundColor Red }
  exit 1
}
