# 淘宝千牛上架技能 · 交接说明书

> 给**新 agent / 新机器**读的。目标：读完这份 + 跑一条自检命令，就能接手这个技能。
> 门禁与索引在 `SKILL.md`；逐步操作细节在 `references/playbook.md`；现场 DOM 记录在 `references/RECON.md`。

## 0. 一句话

把素材包（`商品信息.xlsx` 的「淘宝」sheet + `淘宝\<商品号>` 素材目录）填进淘宝/千牛发布页，
**只填空与自检，绝不点「提交宝贝信息」** —— 由用户人工核对后提交。

**完成标准**：发布页填到「提交前」且自检通过（一口价合法 / 必填属性无红 / SKU 表逐行齐 / 图片按口径到位），然后停下。

**当前状态（2026-10-14）**：**端到端已跑通，并固化成一条编排命令** ——
`scripts\run_listing.ps1` 一次走完 16 步（入口 → 标题/属性 → SKU 导入 → 主图 → 详情 → 规格图 →
核对清单 → 保存草稿），图片步前后自动清面板，逐步打印并汇总失败项。
已实测整链全绿：MZB-001（猫抓板，72 SKU）、MZB-003、PE-001（PE 木纹）、DT-雨棚消音垫-1057991085138（地毯）。
**单步要重做就单跑那一个脚本**（下表），不必整链重跑。

已完成：`config.json` / `resolve_env.ps1` / `preflight.ps1` / `selftest.ps1` / `open_browser.ps1` /
`pwresolver.js` + 自带 playwright-core / **`guard.js`**（每个脚本连接前的必经守卫）/
**`tb_build.py`**（素材包 Excel → `product.json` + SKU 导入表）/ `tb_prep_assets.js`（图片进工作目录）/
`tb_enter_form.js`（入口段：搜索发品 → 级联选类目 → 选品牌 → 进 `publish.htm`）/
`tb_fill_basic.js` / `tb_import_sku.js` / `tb_upload_main.js` / `tb_upload_detail.js` /
`tb_fill_spec_images.js` + `tb_spec_add_image.js` / `tb_checklist.js` / `tb_save_draft.js` /
`run_listing.ps1`（编排）/ `SKILL.md`（门禁 **1–20**）/ `references\playbook.md` / `references\RECON.md`。

**没做的（用户已定，不是待办）**：`tests\fixture_out` 回归夹具（`selftest.ps1` 第 7b 项会 warn）；
批量 SKU 搜索主图（`tb_fill_sku_images.js` 已就位，但没接进编排，且多数商品素材是 0 张）；
自动提交（门禁 2 明确禁止，永远由用户点）。

## 1. 环境前提（缺一个就跑不起来）

| 依赖 | 说明 |
|---|---|
| Node.js | CDP 连接与页面操作 |
| `playwright-core` | **技能自带**（`tools\npm\node_modules\playwright-core`，约 13MB）→ **换机器不用配**。解析顺序 `TB_PLAYWRIGHT` → 自带 → 机器级；查当前用哪份：`node scripts\which_pw.js` |
| Python 3 + `openpyxl` + `Pillow` | 跑 `tb_build.py`（素材包 Excel → `product.json` + SKU 导入表）、图片适配 |
| Chrome + **已登录的千牛** | 一店 = 一个千牛账号 = 一个独立 Chrome 实例（独立 `--user-data-dir`）+ 独立调试端口。本技能**不代登录** |

**开工前先跑一条命令**：

```powershell
$skillRoot = "C:\Users\<你>\.config\mimocode\skills\taobao-product-listing"
& "$skillRoot\scripts\selftest.ps1" -Quick   # 机械检查（BOM/语法/门禁编号/必备文件/config/依赖）
& "$skillRoot\scripts\selftest.ps1"          # 再去掉 -Quick：连 CDP 端口看**千牛登录态**
```

起浏览器（**不代登录**）：

```powershell
& "$skillRoot\scripts\open_browser.ps1"        # 默认 9120 + config.chrome_profile
# → 在弹出的窗口里自己登录千牛，然后回来告诉我
```

**两个 PowerShell 陷阱**：① 本技能 `.ps1` 必须 **UTF-8 带 BOM**（用编辑器/Edit 工具改会剥掉 → 跑 selftest 第 1 项）；
② `resolve_env.ps1` 点源后变量在 **`$TbEnv`**（`Show-TbEnv` 只打印）。

## 2. 目录与文件

技能根：`C:\Users\<你>\.config\mimocode\skills\taobao-product-listing\`

| 文件 | 作用 |
|---|---|
| `SKILL.md` | **门禁 1–20 + 确认清单 + 流程 + 排错 + 边界**（主文档） |
| `references/playbook.md` | **逐步操作细节**（那次成功上架的现场笔记，含提交前核对清单 §11） |
| `references/RECON.md` | **现场 DOM 侦察记录**（追加式日记；含被后文推翻的中途结论 —— 读法见 §9） |
| `references/ops-notes.md` | 备份 / 复查习惯（照抖店那套） |
| **编排与自检** | |
| `scripts/run_listing.ps1` | **端到端一条命令**（16 步编排；`-ProductId/-CatId/-Cat/-Shop/-MainLimit/-DetailBatch`） |
| `scripts/preflight.ps1` | 开工前自检：运行时 / 依赖 / playwright-core / **按店**的端口 + **千牛登录态** /（可选）`-ProductDir` |
| `scripts/guard.js` | **每个脚本连接浏览器前的必经守卫**（端口 / 卖家页 / 登录态；`TB_SKIP_GUARD=1` 只给 `tests\` 用） |
| `scripts/selftest.ps1` | 一条命令自检（改完脚本先跑它；`-Quick` 跳过端口部分） |
| `scripts/open_browser.ps1` | 起带调试端口的 Chrome 并打开千牛工作台（**不代登录**） |
| `scripts/resolve_env.ps1` / `pwresolver.js` / `which_pw.js` | 路径解析（点源后变量在 `$TbEnv`）/ playwright-core 唯一解析入口 / 打印当前用哪一份 |
| `config.json` | 店铺登记（`shops`）+ 运行时路径（留空=自动探测） |
| `tools\npm\node_modules\playwright-core` | **自带的 playwright-core**（约 13MB）—— **别删** |
| **数据管道** | |
| `scripts/tb_build.py` | 素材包 Excel → `output\<商品号>\product.json` + SKU 导入表（`--from-template` 吃官方模板） |
| `scripts/tb_prep_assets.js` | 素材图拷进 `output\<商品号>\img\{1x1,detail,spec}`，规格图按颜色重命名（防跨商品撞名） |
| `scripts/tb_download_template.js` | 下**当前类目**的官方 SKU 模板（`--catid` 必传）→ `output\_downloads\` |
| **表单各步（编排会按顺序调；可单独重跑）** | |
| `scripts/tb_enter_form.js` | 入口段：搜索发品 → 级联按素材包路径选类目 → 本页选品牌 → 进 `publish.htm`（幂等；`--list` 只列手上草稿页） |
| `scripts/tb_fill_basic.js` | 标题 / 导购标题 / 货号 / 类目属性（按**页面上读到的属性名**匹配 `p-id`，换类目自适应） |
| `scripts/tb_import_sku.js` | 销售信息：批量导入官方模板 → SKU 表 → 一口价 + 总库存核对；含与 `product.json` 的逐行对账（幂等） |
| `scripts/tb_upload_main.js` | 1:1 主图：点空槽 → 本地上传 → 关「上传结果」→ 按文件名点图回填（`--skip/--limit`） |
| `scripts/tb_upload_detail.js` | 宝贝详情图：添加→图片 → 分批上传 → 按「确定(N)」核对 → 确定（`--skip/--limit/--batch`） |
| `scripts/tb_spec_add_image.js` | 编辑规格抽屉里勾/确认「添加图片」（`--confirm` 才点「确认创建」） |
| `scripts/tb_fill_spec_images.js` | 颜色行挂规格图：「批量填充规格主图」→ 点图右上角小框 → 确定 → 确认创建 |
| `scripts/tb_fill_sku_images.js` | 批量填充 SKU 搜索主图（面板可开、图可传；**未接入编排**，多数商品素材 0 张） |
| `scripts/close_material_panel.js` / `close_dialogs.js` | 清残留素材面板 / 清残留模态弹窗（图片步之间必跑；见门禁 4/5） |
| `scripts/close_extra_tabs.js` | 收尾清理标签页：只留一张测试用发布页（**不动**千牛工作台 / 生意参谋） |
| `scripts/sku_table.js` | SKU 表**统一读取**（虚拟滚动 → 跨窗口取并集），被 `tb_import_sku.js` / `tb_checklist.js` 共用 |
| `scripts/tb_checklist.js` | **提交前核对清单**（门禁 16）：一键读回全部关键项并对照 `product.json`；只读，不点业务按钮 |
| `scripts/tb_save_draft.js` | 收尾**点「保存草稿」并读回**（保存成功前别刷新；草稿箱满会在这看到提示） |
| `scripts/probe_dom.js` / `open_page.js` | 现场侦察用（读 DOM / 开页），诊断时才用 |
| `scripts/tb_fill_selects.js` / `tb_fill_measure.js` | **类目专用备用件**：前者曾用于下拉类属性（实测多数属性无独立下拉，由 SKU 表决定）；后者是墙纸类目的「计价单位」复合控件（`run_listing` 的 3b 步已移除，脚本留着） |
| `tests\` | 侦察 / 实验脚本 + 试跑日志；其中 `tests\verify_spec_images.js` 被编排第 7b 步调用 |

## 3. 标准作业流程

```powershell
$skillRoot = "C:\Users\<你>\.config\mimocode\skills\taobao-product-listing"
. "$skillRoot\scripts\resolve_env.ps1"; Show-TbEnv        # 变量在 $TbEnv
& "$skillRoot\scripts\preflight.ps1" -ProductDir "<素材包>\淘宝\<商品号>"   # 缺什么一次报清

# 1) 接 CDP（自带的 playwright-core，无需 NODE_PATH）
$env:NODE_PATH = "$skillRoot\tools\npm\node_modules"
& $TbEnv.node -e "console.log(require('$skillRoot/scripts/pwresolver.js').resolvePlaywrightCore().spec)"

# 2) 数据管道：素材包 → product.json + SKU 导入表
#    中文参数走环境变量传（PS → node 的 CLI 中文容易乱码）
& $TbEnv.python "$skillRoot\scripts\tb_build.py" --xlsx "<素材包>\发品excel\<商品号>.xlsx" `
  --product-id <商品号> --out "$skillRoot\output\<商品号>"
#    换过类目要带官方模板：再加 --from-template "$skillRoot\output\_downloads\SKU模板_<catId>_*.xls"
& $TbEnv.node "$skillRoot\scripts\tb_prep_assets.js" --pack "<素材包>" `
  --product "$skillRoot\output\<商品号>\product.json"

# 3) 端到端一条命令（≈25 分钟；图片张数按素材目录自适应，详情每批 ≤20 张）
& "$skillRoot\scripts\run_listing.ps1" -ProductId <商品号> -CatId <catId> `
  -Cat "<完整类目路径，如 宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板>" -Shop <店名>
#    单步要重做就单跑那一个脚本（见 §2 表）；逐步细节见 SKILL.md「流程」表与 references\playbook.md
#    ★ 跑完停下：本技能**绝不点「提交宝贝信息」**，由用户人工核对后提交
```

**验收**：报错 0、必填属性无红、SKU 表逐行有价格/库存/编码/搜索主图、一口价合法；
然后**报给用户**：这些读回值 + 还没填的选填项 + 保存草稿结果（读到「最后保存于」才算成功）+
「草稿只活在当前页面里，别刷新」（草稿箱满时保存会被拦，见门禁 18）。

## 4. 数据流与产物

```
素材库 <素材包>\发品excel\<商品号>.xlsx（「淘宝」sheet）
        + <素材包>\淘宝\<商品号>\{1比1主图,3比4主图,宝贝详情,规格图片,SKU搜索主图}
        ↓ scripts\tb_build.py（读 Excel → 补齐/排序/算一口价）+ scripts\tb_prep_assets.js（图进工作目录、规格图按颜色重命名）
   <skillRoot>\output\<商品号>\product.json + sku_import_官方模板.xlsx + img\{1x1,detail,spec[,skusearch]}
        ↓ scripts\run_listing.ps1（16 步编排；每步连浏览器前都过 guard.js）
   淘宝发布页（填到提交前，**不提交**）→ 点「保存草稿」留住，交用户人工核对并提交
```

## 5. 平台硬约束（不遵守必然失败）

1. **一口价必须等于某个「有库存 SKU」的价格**（平台原文见 playbook §6）——填别的值直接报错。
2. **上传图没有 `input[type=file]`**，全走「图片空间」iframe + 本地上传。
3. **属性必须真点下拉/勾选**，`input.value` 可能是残留假象。
4. **规格顺序按用户口径**（实测尺寸要 `30→40→50→60`），不按源表顺序。
5. **规格图命名必须够独特**（`<商品>规格图-<颜色>.jpg`），否则和 SKU 搜索主图撞名搜错图。
6. **别对规格抽屉按 Escape**（会连抽屉一起关）。
7. **入口只走「搜索发品」**：**不要用「以图发品」** —— 实测它会把上传的主图**自动铺进「宝贝详情图」**，
   与我们「主图 / 详情图各自独立、张数按素材目录取」的口径冲突（用户 2026-10-10 拍板弃用，SKILL 门禁 19）。
8. **类目页「确认，下一步」灰着 = 品牌还没选**（叶子选中不够，门禁 20）；
   类目页品牌下拉是**检索型**：选项是 **`div.options-item`（不是 `li`）**，**用它自带的搜索框输入品牌名过滤**再点。
9. **每个脚本连接浏览器前都过 `scripts\guard.js`** —— 端口不通 / 没开千牛 / 登录态过期都会被拦下并给人话诊断，
   不靠"记得先跑 preflight"。`TB_SKIP_GUARD=1` 只给 `tests\` 下的探索脚本用；别用它绕过真实环境检查。

## 6. 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `TB_SHOP` | 只登记一家时自动用它 | 店名（多店铺）→ 端口按它解析 |
| `TB_PORT` | `config.default_port`（9120） | Chrome CDP 端口 |
| `TB_CONFIG` | `config.json` | 指向另一份配置（测试多店铺用） |
| `TB_PLAYWRIGHT` / `PW_CORE` | 技能自带副本 | 指定 playwright-core |
| `TB_NODE` / `TB_PYTHON` / `MIMO_PYTHON` / `TB_CHROME` / `TB_NPM` / `TB_WORKDIR` | 自动探测 | 运行时路径兜底 |

**退出码**：`selftest.ps1` 0/1（1 = 有失败项，逐条带修法）；`preflight.ps1` 0/1/2（1 = 阻断，2 = 只有警告）；
`open_browser.ps1` 0 = 起来了且端口可达 / 1 = 找不到 chrome / 2 = 起来了但端口探不到（profile 被占用）。

## 7. 店铺配置（多店铺）

**不要写死店铺。** 每次执行先确认：① **有哪些店？** ② **这次发到哪几家？**

`config.json` 的 `shops` 是唯一权威；一店 = 一个千牛账号 = 一个独立 Chrome 实例 + 独立端口：

```json
"shops": { "店名": { "port": 9120, "note": "…" } }
```

`preflight.ps1` 不传 `-Shop` 就把登记的店**逐家查**（端口 + 千牛登录态）。
⚠️ **每店的确认清单不能复用** —— 属性可选项与品牌是店级的。

## 8. 排错速查

| 现象 | 处理 |
|---|---|
| `preflight` 说「停在卖家登录页」 | 在该 Chrome 里登录千牛（`open_browser.ps1` 起的就是登录页） |
| `preflight` 说「没有淘宝/千牛页面」 | 在那个 Chrome 打开 `https://qn.taobao.com/home.htm/QnworkbenchHome/` |
| 端口探不到但你刚起过 Chrome | 多半是 **profile 被别的 Chrome 实例占用**（新进程把参数转给旧实例就退出了）→ 换 profile（`open_browser.ps1 -ForceNewProfile`）或换端口 |
| 页面找不到 `input[type=file]` | 正常，走图片空间 iframe（门禁 5） |
| 属性填了读回是空 | 真点下拉选项，别信 `input.value`（门禁 12） |
| 类目选完「确认，下一步」还是灰的 | 品牌没选 —— 顺序：类目 → 品牌 → 下一步（门禁 20） |
| 类目页品牌一个选项都扫不到 | 用了 `li`，实际是 `div.options-item`；且要**用下拉自带搜索框过滤**（门禁 20） |
| 一口价报错 | 填的值不在有库存 SKU 价格集合里（门禁 6） |
| 规格抽屉莫名关了 | 你按了 Escape（门禁 4） |

## 9. 工作习惯（这个用户要的）

- **说「成功」必须附读回值**（他要实证：填进什么、读回什么）。
- **不确定的值先问**：一口价、品牌、规格顺序、3:4 主图有没有、发到哪些店 —— 见 SKILL.md 确认清单。
- **绝不点提交**（除非他当前对话里明确说「提交」）。
- **一切以现场 DOM 为准**：笔记是参考，页面变了就更新 `references/RECON.md`。
- **`references/RECON.md` 是追加式日记**，里面同时有中途结论（"断点未打通 / 校验没生效 / 待摸"）和后来推翻它的结论
  → 读它**从文末往回读**，或以 `SKILL.md` 的门禁为准（门禁是清理过的结论）。
- 改脚本前先跑 `selftest.ps1`，后跑 `selftest.ps1`（`ops-notes` 那套备份/复查习惯见抖店技能）。
