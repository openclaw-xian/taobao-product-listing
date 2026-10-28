# Resolve Taobao (千牛) skill paths: config.json > env > auto-detect.
# Dot-source or call; sets $TbEnv hashtable.
#
# 与 douyin-product-listing / pdd-product-listing 的 resolve_env.ps1 同构，只换前缀与默认值。
# ⚠️ 本文件必须存成 **UTF-8 带 BOM**（PowerShell 5.1 会把无 BOM 的 UTF-8 当 GBK 读，中文串全烂）。
#    用编辑器/Edit 工具改完记得跑 scripts/selftest.ps1 的第 1 项（它专门查这个）。

function Get-TbSkillRoot {
  Split-Path -Parent $PSScriptRoot
}

function Resolve-TbConfig {
  $root = if ($script:TbSkillRoot) { $script:TbSkillRoot } else { Get-TbSkillRoot }
  $script:TbSkillRoot = $root
  $cfgPath = Join-Path $root "config.json"
  # 允许 TB_CONFIG 指向别的 config（测试多店铺编排时用，不动真配置）
  if ($env:TB_CONFIG -and (Test-Path $env:TB_CONFIG)) { $cfgPath = $env:TB_CONFIG }
  $cfg = [ordered]@{
    chrome = ""; chrome_profile = ""; node = ""; npm = ""; python = ""
    playwright_core = ""; workdir = ""; default_port = 9120; reuse_profile = $true
  }
  if (Test-Path $cfgPath) {
    try {
      # ⚠️ 必须显式 -Encoding UTF8：PS 5.1 的 Get-Content 默认按 ANSI/GBK 读，中文注释会乱码 → JSON 抛异常
      $raw = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($k in @('chrome','chrome_profile','node','npm','python','playwright_core','workdir')) {
        if ($raw.PSObject.Properties.Name -contains $k -and $raw.$k) { $cfg[$k] = [string]$raw.$k }
      }
      if ($raw.PSObject.Properties.Name -contains 'default_port' -and $raw.default_port) {
        $cfg.default_port = [int]$raw.default_port
      }
      if ($raw.PSObject.Properties.Name -contains 'reuse_profile') {
        $cfg.reuse_profile = [bool]$raw.reuse_profile
      }
      # 店铺登记表（多店铺的唯一权威）：shops.<店名> = { port, note }
      if ($raw.PSObject.Properties.Name -contains 'shops' -and $raw.shops) { $cfg.shops = $raw.shops }
    } catch {
      Write-Warning "config.json 解析失败，已回退到自动探测：$($_.Exception.Message)"
    }
  }
  return $cfg
}

<#
  按店名解析端口（多店铺：**不写死店铺**，以 config.shops 为准）。
    - 显式 -Name / $env:TB_SHOP 指定店名 → 用它；
    - 没指定但只登记了一家店 → 用那家（单店场景零配置）；
    - 登记了多家又没指定 → 不猜（shop = ""，端口回落到 default_port，调用方应报错或要求指定）。
#>
function Resolve-TbShop {
  param([string]$Name = "")
  $cfg = Resolve-TbConfig
  $shops = $cfg.shops
  $want = if ($Name) { $Name } elseif ($env:TB_SHOP) { $env:TB_SHOP } else { "" }
  if (-not $shops) {
    return @{ name = ""; port = [int]$cfg.default_port; shop = $null; names = @() }
  }
  # ⚠️ 空对象（config 里写 `"shops": {}`）的 `.PSObject.Properties.Name` 会返回**一个 $null 元素**
  #   （`@($null)` 的长度是 1！）→ 会被误当成「有一家店名叫空的店」→ 端口 0。必须过滤掉。
  $names = @($shops.PSObject.Properties.Name | Where-Object { $_ })
  if ($want -and ($names -contains $want)) {
    return @{ name = $want; port = [int]$shops.$want.port; shop = $shops.$want; names = $names }
  }
  if (-not $want -and $names.Count -eq 1) {
    $only = $names[0]
    return @{ name = $only; port = [int]$shops.$only.port; shop = $shops.$only; names = $names }
  }
  return @{ name = ""; port = [int]$cfg.default_port; shop = $null; names = $names }
}

function Resolve-TbEnv {
  $cfg = Resolve-TbConfig
  $envMap = @{}

  $envMap.node = if ($cfg.node -and (Test-Path $cfg.node)) { $cfg.node }
    elseif ($env:TB_NODE -and (Test-Path $env:TB_NODE)) { $env:TB_NODE }
    else {
      $c = Get-Command node -ErrorAction SilentlyContinue
      if ($c) { $c.Source } else { "" }
    }

  $envMap.python = if ($cfg.python -and (Test-Path $cfg.python)) { $cfg.python }
    elseif ($env:TB_PYTHON -and (Test-Path $env:TB_PYTHON)) { $env:TB_PYTHON }
    elseif ($env:MIMO_PYTHON -and (Test-Path $env:MIMO_PYTHON)) { $env:MIMO_PYTHON }
    else {
      $c = Get-Command python -ErrorAction SilentlyContinue
      if ($c) { $c.Source } else { "" }
    }

  $envMap.chrome = if ($cfg.chrome -and (Test-Path $cfg.chrome)) { $cfg.chrome }
    elseif ($env:TB_CHROME -and (Test-Path $env:TB_CHROME)) { $env:TB_CHROME }
    else {
      $candidates = @(
        "C:\Program Files\Google\Chrome\Application\chrome.exe",
        "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
      )
      $hit = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
      if ($hit) { $hit } else { "" }
    }

  # playwright-core：config > 环境变量 > **技能自带** > 裸模块名（机器级 / NODE_PATH）
  $skillRootForPw = Split-Path -Parent $PSScriptRoot
  $localPw = Join-Path $skillRootForPw "tools\npm\node_modules\playwright-core"
  $envMap.playwright_core = if ($cfg.playwright_core -and (Test-Path $cfg.playwright_core)) { $cfg.playwright_core }
    elseif ($env:TB_PLAYWRIGHT -and (Test-Path $env:TB_PLAYWRIGHT)) { $env:TB_PLAYWRIGHT }
    elseif (Test-Path $localPw) { $localPw }
    else { "playwright-core" }
  if ($envMap.playwright_core -and $envMap.playwright_core -ne 'playwright-core') {
    $env:TB_PLAYWRIGHT = $envMap.playwright_core
  }

  $envMap.npm = if ($cfg.npm -and (Test-Path $cfg.npm)) { $cfg.npm }
    elseif ($env:TB_NPM -and (Test-Path $env:TB_NPM)) { $env:TB_NPM }
    else { "" }

  $envMap.workdir = if ($cfg.workdir -and $cfg.workdir.Trim()) { $cfg.workdir }
    elseif ($env:TB_WORKDIR -and $env:TB_WORKDIR.Trim()) { $env:TB_WORKDIR }
    else { Join-Path (Get-Location) "output\taobao" }

  $envMap.default_port = $cfg.default_port
  # 店铺：解析结果一并放进来（run_until_green / preflight 用它做「按店」的事）
  $shop = Resolve-TbShop
  $envMap.shop = $shop.name
  $envMap.shop_port = $shop.port
  $envMap.shops = $cfg.shops
  if ($shop.name) { $envMap.default_port = $shop.port }   # 登记了店 → 端口跟店走

  $envMap.chrome_profile = if ($cfg.chrome_profile -and $cfg.chrome_profile.Trim()) { $cfg.chrome_profile } else { "" }
  $envMap.reuse_profile = $cfg.reuse_profile
  $envMap.skill_root = $script:TbSkillRoot
  $envMap.flow_js = Join-Path $script:TbSkillRoot "scripts\tb_flow.js"
  $envMap.run_listing = Join-Path $script:TbSkillRoot "scripts\run_listing.js"
  $envMap.open_browser = Join-Path $script:TbSkillRoot "scripts\open_browser.ps1"

  $env:TB_FLOW_JS = $envMap.flow_js
  $script:TbEnv = $envMap
  return $envMap
}

function Show-TbEnv {
  $e = if ($script:TbEnv) { $script:TbEnv } else { Resolve-TbEnv }
  $e.GetEnumerator() | Sort-Object Name | ForEach-Object {
    "{0,-16} {1}" -f $_.Key, $_.Value
  }
}

# Auto-resolve on dot-source
Resolve-TbEnv | Out-Null

# ---- 兜底：MIMO 托管 python 缺失时（本机 2026-10-10 实测：MIMO_PYTHON 为空/失效）----
#   用系统 Python 3.11 + 把 3.12 的用户级 site-packages 加进 PYTHONPATH（openpyxl 装在那儿）
if (-not $env:PYTHONPATH) {
  $sitePk = Join-Path $env:APPDATA 'Python\Python312\site-packages'
  if (Test-Path $sitePk) { $env:PYTHONPATH = $sitePk }
}
