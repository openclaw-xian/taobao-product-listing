#!/usr/bin/env python
# -*- coding: utf-8 -*-
r"""
素材包骨架生成器（纯写文件，不连浏览器）

输入：类目 catId / 类目路径 / 商品标识 / 属性清单 / 官方 SKU 模板表头
输出：一份能被 tb_build.py 读通的素材包
      商品信息.xlsx（淘宝 sheet：R1 类目 / R2 属性列 / R3 规格列 / R4 元数据 / R5 示例行）
      淘宝\<商品标识>\{1比1主图,3比4主图,宝贝详情,规格图片,SKU搜索主图,商品视频,白底图}

为什么属性/规格来自外部：属性名和必填只能从发布页 DOM 读（见 scripts/pack_meta.js），
规格列只能从该类目官方 SKU 模板读（见 scripts/tb_download_template.js）。本脚本只负责拼装。
"""
import argparse
import json
import os
import sys

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

# SKU 级固定列（素材包口径，tb_build.py 按这些 key 取值）
SKU_FIXED = [
    ("规格图片文件名", {"key": "skuSpecImage", "required": False, "parentKey": "sku", "kind": "skuSpec",
                  "skuRole": "specImage", "assetPath": ["规格图片"],
                  "note": "填「规格图片」目录里的完整文件名，不要填路径"}),
    ("★ 价格", {"key": "skuPrice", "required": True, "parentKey": "sku", "kind": "skuSpec"}),
    ("★ 数量", {"key": "skuStock", "required": True, "parentKey": "sku", "kind": "skuSpec"}),
    ("商家编码", {"key": "skuOuterId", "required": False, "parentKey": "sku", "kind": "skuSpec"}),
    ("商品条形码", {"key": "skuBarcode", "required": False, "parentKey": "sku", "kind": "skuSpec"}),
    ("SKU搜索主图文件名", {"key": "skuPicture", "required": False, "parentKey": "sku", "kind": "skuSpec",
                    "skuRole": "fillColumn", "assetPath": ["SKU搜索主图"],
                    "note": "填「SKU搜索主图」目录里的完整文件名，可留空"}),
]
# 官方模板里这几列是通用列，不当作规格维度
GENERIC_SKU_COLS = {"价格", "数量", "商家编码", "商品条形码"}

GOODS_FIXED = [
    ("★ 商品标识", {"key": "__productId", "required": True,
              "note": "便于识别且不重复，如「商品A-01」。每商品只填一次，SKU 行留空"}),
    ("★ 宝贝标题", {"key": "title", "required": True, "note": "最多 30 个汉字"}),
    ("导购标题", {"key": "shopping_title", "required": False, "note": "选填"}),
]
GOODS_TAIL = [
    ("★ 一口价", {"key": "price", "required": True, "note": "必须与某个有库存 SKU 的价格一致"}),
    ("总库存", {"key": "quantity", "required": False, "note": "多 SKU 时由各 SKU 库存自动汇总，可不填"}),
    ("★ 1:1主图", {"key": "mainImage", "required": True, "note": "图放「1比1主图」目录，至多 5 张"}),
    ("3:4主图", {"key": "mainImage34", "required": False, "note": "本技能按口径不传 3:4"}),
    ("商品视频", {"key": "video", "required": False}),
    ("白底图", {"key": "whiteImage", "required": False}),
    ("★ 宝贝详情", {"key": "detailImage", "required": True, "note": "图放「宝贝详情」目录，建议 01/02/03 编号"}),
]

HDR_FILL = PatternFill("solid", fgColor="DDEBF7")
META_FONT = Font(size=8, color="808080")


def col_letter(i):
    return get_column_letter(i)


def build(args):
    attrs = []
    if args.attrs_file and os.path.exists(args.attrs_file):
        attrs = json.load(open(args.attrs_file, encoding="utf-8"))
    # 属性区可能混入「销售规格」这类区标题，而生成器自己也会补一列「销售规格」；
    # 同名两列会让 col_map（先出现优先）取错列 → 这里先剔掉。
    SKIP_ATTR = {"销售规格", "一口价", "总库存", "商家编码", "商品条形码",
                 "商品标识", "宝贝标题", "导购标题", "类目属性"}
    attrs = [a for a in attrs if str(a.get("名") or "").strip() not in SKIP_ATTR]
    spec_cols = []
    if args.spec_file and os.path.exists(args.spec_file):
        spec_cols = json.load(open(args.spec_file, encoding="utf-8"))
    if args.tpl and os.path.exists(args.tpl):
        # 官方模板给的后缀是 .xls，实际是 xlsx（魔数 PK）→ 复制改名即可读。
        # ★ 不能用 read_only：read_only 模式下 max_column 会报成 1，漏掉大部分列。
        import shutil
        q = os.path.join(os.path.abspath(args.out), "_tpl_as_xlsx.xlsx")
        os.makedirs(os.path.dirname(q), exist_ok=True)
        shutil.copy2(args.tpl, q)
        wbt = openpyxl.load_workbook(q, data_only=True)
        sheet = next((s for s in wbt.sheetnames if "AI批量上传" in s and "hide" not in s), wbt.sheetnames[0])
        wst = wbt[sheet]
        spec_cols = [str(wst.cell(1, c).value or "").strip() for c in range(1, wst.max_column + 1)]
        spec_cols = [c for c in spec_cols if c]
        print("规格列（来自官方模板 %s）：%s" % (os.path.basename(args.tpl), spec_cols))
    if not spec_cols:
        print("★ 没有规格列（--spec-file 为空 且 没给 --tpl）→ 至少要给「颜色分类」")
        return 2

    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)

    wb = openpyxl.Workbook()

    # ---------- sheet: 淘宝 ----------
    ws = wb.active
    ws.title = "淘宝"
    ws.cell(1, 1).value = "淘宝 | platform=taobao | %s | cateId=%s" % (args.cat, args.catid)

    col = 1
    meta = []          # (列名, R4 JSON, 级别)
    # R2：商品级
    for name, m in GOODS_FIXED:
        meta.append((name, m, "goods"))
    for a in attrs:
        name = str(a.get("名") or "")
        star = ("★ " if a.get("必填") else "")
        if a.get("kind") == "taoSirProp":
            # 「数值 + 单位」组合属性（实测墙纸类目「计价单位」）：素材包里是**两列**
            #   `计价单位`（数值）+ `计价单位(单位)`（单位），只给一列填什么都不对。
            meta.append((star + name, {"key": name, "required": bool(a.get("必填"))}, "goods"))
            meta.append((name + "(单位)", {"key": name + "(单位)", "required": False}, "goods"))
        else:
            meta.append((star + name, {"key": name, "required": bool(a.get("必填"))}, "goods"))
    meta.append(("销售规格", {"key": "skuSpecName", "required": False,
                       "note": "选填；填了该行规格名直接用此值"}, "goods"))
    for name, m in GOODS_TAIL:
        meta.append((name, m, "goods"))
    # R3：SKU 级。★ 官方模板里的「价格/数量/商家编码/商品条形码」不放进 R3 ——
    #    tb_build.py 的 col_map 是「先出现的列优先」，若两列同名只有前面那列有效，
    #    值却填在后面的「★ 价格」里 → 价格读成空（实测踩到：价格档 0 个）。
    for c in spec_cols:
        if c in GENERIC_SKU_COLS:
            continue
        meta.append((c, {"key": c, "required": False, "parentKey": "sku", "kind": "skuSpec"}, "sku"))
    for name, m in SKU_FIXED:
        meta.append((name, m, "sku"))

    # 写 R2 / R3 / R4
    for i, (name, m, level) in enumerate(meta, start=1):
        r = 2 if level == "goods" else 3
        c = ws.cell(r, i)
        c.value = name
        c.fill = HDR_FILL
        c.alignment = Alignment(horizontal="center", vertical="center")
        c.font = Font(bold=True, size=10)
        ws.cell(4, i).value = json.dumps(m, ensure_ascii=False)
        ws.cell(4, i).font = META_FONT
        ws.column_dimensions[col_letter(i)].width = max(12, min(34, len(name) * 2 + 4))

    # R5：示例行
    def put(name_key, val):
        for i, (name, m, level) in enumerate(meta, start=1):
            base = name.replace("★", "").replace("☆", "").strip()
            if base == name_key or m.get("key") == name_key:
                ws.cell(5, i).value = val
                return True
        return False

    put("商品标识", args.pid)
    put("宝贝标题", "示例标题请替换成你的商品标题不超过30个汉字")
    # ★ 必填属性**留空**，不要统一填「其他」——实测墙纸类目「计价单位」没有「其他」这个可选值，
    #   tb_fill_basic 会判 option_not_found 直接失败（必填属性填错值比空着更难查）。
    #   用户必须自己按该类目的可选值填（见 sheet「填写说明」）。
    # 规格示例：只有「颜色分类」给个值，其它规格维度留空 ——
    #   否则像「图案」这种列会被填成「米白」，SKU 组合值变成「米白-米白-」两层重复（实测踩到）。
    for idx, c in enumerate(spec_cols):
        if c in GENERIC_SKU_COLS:
            continue
        put(c, "米白" if "颜色" in c else "")
    put("一口价", args.listprice)
    put("skuSpecImage", "规格图-米白.jpg")
    put("skuPrice", args.listprice)
    put("skuStock", 100)
    put("skuOuterId", "%s-示例1" % args.pid)

    ws.freeze_panes = "A5"

    # ---------- sheet: 素材包设置 ----------
    st = wb.create_sheet("素材包设置")
    st["A1"] = "素材包设置"; st["A1"].font = Font(bold=True, size=12)
    st["A3"] = "移动素材包后，请更新下面的根目录；技能以 淘宝\\<商品标识>\\ 下的图片为准。"
    st["A5"] = "设置项"; st["B5"] = "完整路径（移动后请更新）"
    st["A6"] = "素材包根目录"; st["B6"] = out
    st["A8"] = "素材准备清单"; st["A8"].font = Font(bold=True)
    st["A9"] = "共 7 个素材目录；技能实际会传的是 1:1主图（≤5 张）和 宝贝详情（每批 ≤20 张）"
    heads = ["平台", "素材目录", "要求", "说明"]
    for i, h in enumerate(heads, start=1):
        st.cell(10, i).value = h; st.cell(10, i).font = Font(bold=True)
    rows = [
        ["淘宝", "1比1主图", "★ 必传", "技能会传，至多 5 张（平台限制）"],
        ["淘宝", "宝贝详情", "★ 必传", "技能会传，每批 ≤20 张"],
        ["淘宝", "规格图片", "选传", "每个颜色一张，文件名写进「规格图片文件名」列"],
        ["淘宝", "SKU搜索主图", "选传", "文件名写进「SKU搜索主图文件名」列"],
        ["淘宝", "3比4主图", "选传", "本技能按口径不传"],
        ["淘宝", "商品视频", "选传", "本技能不传"],
        ["淘宝", "白底图", "选传", "本技能不传"],
    ]
    for r, row in enumerate(rows, start=11):
        for c, v in enumerate(row, start=1):
            st.cell(r, c).value = v
    st.column_dimensions["B"].width = 18
    st.column_dimensions["D"].width = 48

    # ---------- sheet: 填写说明 ----------
    # ★ 这一页是给"人"看的：必须能照着填。所以做成分区表格（位置 / 列名 / 必填 / 怎么填 / 示例），
    #   而不是一堆关于行号的说明 —— 实测同事拿到骨架最先问的就是"我到底要填哪几个格"。
    ex = wb.create_sheet("填写说明")
    ex["A1"] = "怎么填这份素材包（%s / cateId=%s）" % (args.cat, args.catid)
    ex["A1"].font = Font(bold=True, size=13)
    for i, w in zip(range(1, 5), (22, 8, 68, 26)):
        ex.column_dimensions[get_column_letter(i)].width = w

    def head(r, t):
        c = ex.cell(r, 1); c.value = t; c.font = Font(bold=True, size=11)

    def row(r, vals, bold=False):
        for i, v in enumerate(vals, start=1):
            c = ex.cell(r, i); c.value = v
            if bold: c.font = Font(bold=True)
            c.alignment = Alignment(vertical="top", wrap_text=True)

    NUMSIR = {"taoSirProp"}   # 「数值 + 单位」组合属性：两列都要填

    head(3, "一、商品级字段：只填在【第 5 行】（R5）一次，下面各行留空")
    row(4, ["列名", "必填", "怎么填", "示例"], bold=True)
    r = 5
    # 属性示例值：能确定的给真值（品牌/采购地这类有固定常见写法），其余留空让人自己按下拉选
    ATTR_EG = {"品牌": "无品牌", "是否定制": "否", "采购地": "中国内地（大陆）",
               "货号": "示例A01", "风格": "简约现代", "功能": "美化装饰"}
    all_names = [nn.replace("★", "").replace("☆", "").strip() for nn, _m, _lv in meta]
    for name, m, lv in meta:
        if lv != "goods":
            continue
        base = name.replace("★", "").replace("☆", "").strip()
        star = name.startswith("★")
        if base in ("商品标识",):
            how = "必须与 淘宝\\<目录名> 完全一致；技能以目录名为准"
            egs = args.pid
        elif base in ("宝贝标题",):
            how = "≤30 个汉字（60 字符）"
            egs = "示例标题请替换成你的商品标题"
        elif base == "导购标题":
            how = "可以留空"
            egs = ""
        elif base.endswith("(单位)"):
            how = "填左边那一列的**单位**（下拉里选）"
            egs = "（单位，如 卷 / cm / kg）"
        elif base in ("一口价",):
            how = "必须**正好等于**某个有库存 SKU 的「★ 价格」；留空则自动取最低价"
            egs = str(args.listprice)
        elif base == "总库存":
            how = "多 SKU 时自动汇总，**留空**"
            egs = ""
        elif base.startswith("1:1主图"):
            how = "把图放「1比1主图」目录，技能自动传（≤5 张）"
            egs = "（不用填文件名）"
        elif base.startswith("宝贝详情"):
            how = "把图放「宝贝详情」目录，技能自动传"
            egs = "（不用填文件名）"
        elif base in ("3:4主图", "商品视频", "白底图"):
            how = "本技能按口径不传，**留空**"
            egs = ""
        elif base == "销售规格":
            how = "可以留空（留空则自动拼接成 颜色-尺寸）"
            egs = ""
        elif base in ("商品条形码",):
            how = "选填，一般留空"
            egs = ""
        elif base + "(单位)" in all_names:
            # 「数值 + 单位」组合：这一列填数字，单位填在右边那列（实测墙纸「计价单位」= 1 + 卷）
            how = "填**数值**（数字）；单位填在右边「%s(单位)」那一列" % base
            egs = "1"
        else:
            # 类目属性
            how = "值必须正好是**该类目发布页下拉里的一个选项**（跑一次草稿就知道对不对）"
            egs = ATTR_EG.get(base, "")
        row(r, [name, "必填" if star else "选填", how, egs])
        r += 1

    r += 1
    head(r, "二、SKU 级字段：第 5 行起，**每个「颜色 × 尺寸」组合各一行**"); r += 1
    row(r, ["列名", "必填", "怎么填", "示例"], bold=True); r += 1
    for name, m, lv in meta:
        if lv != "sku":
            continue
        base = name.replace("★", "").replace("☆", "").strip()
        star = name.startswith("★") or base in ("颜色分类",)
        if "颜色" in base:
            how = "每行一个颜色值；长营销文案也能用（但这时要靠「规格图片文件名」做映射）"
            egs = "米白"
        elif base in ("价格",):
            how = "数字，可带两位小数；所有 SKU 的价格构成「价格集合」"
            egs = str(args.listprice)
        elif base in ("数量",):
            how = "整数库存"
            egs = "100"
        elif "规格图片" in base:
            how = "填「规格图片」目录里的**完整文件名**（不要路径）；同一颜色多行填同一个文件名"
            egs = "规格图-米白.jpg"
        elif "搜索主图" in base:
            how = "填「SKU搜索主图」目录里的完整文件名；没有就留空"
            egs = ""
        elif base in ("商家编码",):
            how = "选填，建议用 <商品标识>-<颜色>-<尺寸> 保证唯一"
            egs = "%s-米白-1米" % args.pid
        elif base in ("商品条形码",):
            how = "选填，一般留空"
            egs = ""
        else:
            how = "该类目的规格维度（来自官方 SKU 模板）。只按颜色一个维度卖就**留空**；确实按这个维度分 SKU 才每行填对应值"
            egs = ""
        row(r, [name, "必填" if star else "选填", how, egs])
        r += 1

    r += 1
    head(r, "三、多 SKU 怎么加行"); r += 1
    for t in [
        "1. 商品级字段（第一部分那些）**只在第 5 行填一次**；第 6 行起只填 SKU 级列，其余留空。",
        "2. 一行 = 一个「颜色 × 尺寸」组合。比如 6 色 × 9 尺寸 = 54 行。",
        "3. 同一个颜色的多行，共用同一张规格图 → 「规格图片文件名」填同一个文件名。",
        "4. 行号不用管别的：R1~R4 是表头，**别插行、别删行**，直接从 R5 往下加数据。",
    ]:
        ex.cell(r, 1).value = t
        ex.cell(r, 1).alignment = Alignment(wrap_text=True)
        ex.merge_cells(start_row=r, start_column=1, end_row=r, end_column=5)
        r += 1

    r += 1
    head(r, "四、图放哪（目录名不要改）"); r += 1
    for t in [
        "1比1主图\\   ★必传；比例 1:1，建议 1440x1440 以上；**技能只传前 5 张**（平台上限）",
        "宝贝详情\\   ★必传；建议 01、02、03 编号命名；技能每批最多传 20 张",
        "规格图片\\   选传；每个颜色一张，文件名要跟「规格图片文件名」列一字不差",
        "SKU搜索主图\\ 选传；文件名要跟「SKU搜索主图文件名」列一字不差",
        "3比4主图\\商品视频\\白底图\\   选传，本技能按口径不传，可以空着",
    ]:
        ex.cell(r, 1).value = t
        ex.cell(r, 1).alignment = Alignment(wrap_text=True)
        ex.merge_cells(start_row=r, start_column=1, end_row=r, end_column=5)
        r += 1

    r += 1
    head(r, "五、填完先自检（不碰店铺、不开页面）"); r += 1
    for t in [
        "run_listing.ps1 -Pack \"<本素材包目录>\" -CatId %s -Cat \"%s\" -DryRun" % (args.catid, args.cat),
        "它会告诉你：商品号 / SKU 行数 / 价格档 / 一口价取了多少 / 图片张数 / 规格图映射缺几个 / 走多少步。",
        "这一步绿了再去掉 -DryRun 正式跑；正式跑完技能列核对清单，最后**你自己点提交**。",
        "★ 属性值填错（不在该类目可选值里）在自检阶段不一定报，正式跑到第 2 步才会报「不在可选值里」。",
    ]:
        ex.cell(r, 1).value = t
        ex.cell(r, 1).alignment = Alignment(wrap_text=True)
        ex.merge_cells(start_row=r, start_column=1, end_row=r, end_column=5)
        r += 1

    r += 1
    head(r, "六、最少要填什么（急着跑就先看这节）"); r += 1
    # 只列**真正的类目属性**（★ 列里还有一口价/1:1主图/宝贝详情，它们不是属性，取值规则完全不同）
    attr_names = {str(a.get("名") or "").strip() for a in attrs}
    star_attrs = [n.replace("★", "").replace("☆", "").strip() for n, _m, lv in meta
                  if lv == "goods" and n.startswith("★")
                  and n.replace("★", "").replace("☆", "").strip() in attr_names]
    for t in [
        "1. 【★ 商品标识】= 淘宝\\ 下的目录名（%s）——两边不一致技能会以目录名为准并告警" % args.pid,
        "2. 【★ 宝贝标题】≤30 个汉字",
        "3. 【★ 属性】%d 个：%s —— 值必须正好是该类目下拉里的选项" % (len(star_attrs), "、".join(star_attrs) or "（本类目无必填属性）"),
        "4. 【每个 SKU 一行】：颜色分类 + ★ 价格 + ★ 数量（一行一个「颜色 × 尺寸」组合）",
        "5. 【有规格图就填】：规格图片文件名（同一颜色多行填同一个文件名）",
        "6. 【图】：1比1主图（≤5 张）+ 宝贝详情 —— 放对应目录，不用写文件名",
        "7. 其余空着就行（3:4主图/商品视频/白底图/总库存/导购标题 都不用填）",
    ]:
        ex.cell(r, 1).value = t
        ex.cell(r, 1).alignment = Alignment(wrap_text=True)
        ex.merge_cells(start_row=r, start_column=1, end_row=r, end_column=4)
        r += 1

    r += 1
    head(r, "七、行结构（技能怎么读的，别改）"); r += 1
    for t in [
        "R1  首格 = 类目路径 + cateId（技能从这里读类目来源）",
        "R2  商品级列名（属性列就是发布页上的属性名，★ = 必填）",
        "R3  SKU 级列名（规格维度 + 价格/数量/编码/规格图）",
        "R4  每列一个 JSON 元数据（技能靠它判定 属性 / 必填 / SKU 维度 / 规格图列）",
        "R5 起 商品数据",
        "属性列和 R4 是**按类目**的：换类目要重新生成，不要手改。",
    ]:
        ex.cell(r, 1).value = t
        ex.cell(r, 1).alignment = Alignment(wrap_text=True)
        ex.merge_cells(start_row=r, start_column=1, end_row=r, end_column=5)
        r += 1

    xlsx = os.path.join(out, "商品信息.xlsx")
    wb.save(xlsx)

    # ---------- 素材目录 ----------
    pid_dir = os.path.join(out, "淘宝", args.pid)
    for d, note in [("1比1主图", "★必传：1:1，建议 1440x1440 以上，技能只传前 5 张"),
                    ("宝贝详情", "★必传：建议 01、02、03 编号；一批最多 20 张"),
                    ("规格图片", "每个颜色一张；文件名要与「规格图片文件名」列一致"),
                    ("SKU搜索主图", "选传"),
                    ("3比4主图", "本技能按口径不传"),
                    ("商品视频", "本技能不传"),
                    ("白底图", "本技能不传")]:
        p = os.path.join(pid_dir, d)
        os.makedirs(p, exist_ok=True)
        with open(os.path.join(p, "把图放这里.txt"), "w", encoding="utf-8") as f:
            f.write(note + "\n")

    print("生成完成：", xlsx)
    print("  商品级列 %d 个 / SKU 级列 %d 个 / 属性 %d 个（必填 %d）" % (
        sum(1 for _, _, lv in meta if lv == "goods"),
        sum(1 for _, _, lv in meta if lv == "sku"),
        len(attrs), sum(1 for a in attrs if a.get("必填"))))
    print("  R2:", [n for n, _, lv in meta if lv == "goods"])
    print("  R3:", [n for n, _, lv in meta if lv == "sku"])
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catid", required=True)
    ap.add_argument("--cat", required=True, help="类目路径，如 居家布艺 > 地毯")
    ap.add_argument("--pid", default="示例商品A-01")
    ap.add_argument("--out", required=True)
    ap.add_argument("--attrs-file", help="JSON：[{pid, 名, 必填}]")
    ap.add_argument("--spec-file", help="JSON：规格列名数组（来自官方 SKU 模板表头）")
    ap.add_argument("--tpl", help="官方 SKU 模板路径（可直接读表头，比 --spec-file 省一步）")
    ap.add_argument("--listprice", type=float, default=18.8)
    sys.exit(build(ap.parse_args()))


if __name__ == "__main__":
    main()
