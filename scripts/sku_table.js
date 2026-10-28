#!/usr/bin/env node
/**
 * SKU 表的**统一读取**（虚拟滚动 → 跨窗口取并集）。
 *
 * 为什么单独成模块：`tb_import_sku.js` 与 `tb_checklist.js` 原来各有一份扫表逻辑，两份都只认
 * **「颜色-尺寸挤在一列」**的老格式（判据是「某个单元格文本里含 `-`」）。换成**两层规格**
 * （颜色分类 × 地毯尺寸各自一列）后：一份读到 0 行、另一份读到 9 行（把 9 个颜色当成了 9 行），
 * 而页面「总库存 6034」其实已经是 99 行之和 —— 读法不一致会造出**「明明成功了却报失败」**。
 *
 * 现场结构（2026-10-13 实测，地毯 catId 50000582，两层规格，行 18 个 td）：
 *   `sell-sku-cell-im`(图位) / 两个 `is-sale-prop`(**颜色、尺寸**，是文本不是 input) /
 *   `sell-sku-cell-mo*`(价格 input) / `sell-sku-cell-po*`(数量 input) / `sell-sku-cell-se*`(SKU分类) /
 *   若干空 `sk` 格 / 两个 `sell-sku-cell-co*`(隐藏回显 input，值与颜色/尺寸相同) / 上传素材 /
 *   两个 `sell-sku-cell-in*` input（**第一个 = 商家编码**，第二个 = 商品条形码）/ 去填写 / sw / 查看删除
 *   虚拟滚动容器 = **`.ver-scroll-wrap`**（99 行时 scrollHeight≈6481，DOM 只渲染 17 行）
 *
 * 键口径：**`颜色 + '-' + 尺寸`** —— 与 `tb_import_sku.js` 的 EXPECT_SET、`product.json` 的
 * `colors`/`styles` 对齐。单层规格（老格式）下没有尺寸列，键就是那一列的值本身。
 */
const SCAN_SRC = async (step) => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const sl = (ms) => new Promise((r) => setTimeout(r, ms));
  const table = Array.from(document.querySelectorAll('table')).find((t) => t.querySelector('tbody tr'));
  if (!table) return { ok: false, why: 'no_table' };
  // 虚拟滚动容器：优先 `.ver-scroll-wrap`（实测就是它），否则退回到「可滚最高的祖先」
  let sc = table.closest('.ver-scroll-wrap');
  if (!sc || sc.scrollHeight - sc.clientHeight <= 0) {
    let best = 0; let cur = table;
    while (cur) { const can = cur.scrollHeight - cur.clientHeight; if (can > best) { best = can; sc = cur; } cur = cur.parentElement; }
  }
  if (!sc) return { ok: false, why: 'no_scroll_container' };

  const rows = new Map();
  let lastColor = null;
  const collect = () => {
    table.querySelectorAll('tbody tr').forEach((tr) => {
      const tds = Array.from(tr.querySelectorAll('td'));
      const props = tds.filter((td) => /is-sale-prop/.test(td.className))
        .map((td) => clean(td.innerText)).filter(Boolean);
      if (!props.length) return;
      let color = null; let size = null;
      if (props.length >= 2) { color = props[0]; size = props[1]; }
      else {
        // 只有一列有文本：判断这列是尺寸还是颜色（尺寸形如 `30x100cm`）。
        // 颜色列在「同色多行」里可能被合并/隐藏 → 用上一行的颜色补（前向填充）。
        if (/^\d+(\.\d+)?\s*[x×*]\s*\d+/.test(props[0])) { size = props[0]; color = lastColor; }
        else color = props[0];
      }
      if (color) lastColor = color;
      if (!color && !size) return;
      const spec = size ? color + '-' + size : (color || size);
      const val = (re) => {
        const td = tds.find((t) => new RegExp(re).test(t.className));
        const i = td && td.querySelector('input');
        return i ? String(i.value || '').trim() : null;
      };
      const ins = tds.filter((td) => /sell-sku-cell-in/.test(td.className))
        .map((td) => { const i = td.querySelector('input'); return i ? String(i.value || '').trim() : ''; });
      rows.set(spec, {
        spec, color, style: size,
        price: val('sell-sku-cell-mo'), stock: val('sell-sku-cell-po'),
        code: ins[0] || null, barcode: ins[1] || null,
      });
    });
  };
  // ★ 扫**多轮**直到连续两轮结果一致（虚拟滚动渲染有延迟，一轮会漏行）：
  //   实测同一张 99 行的表，一轮能读到 93、甚至 69 —— 少读会被误判成"行数不够"，
  //   进而触发**重复导入**（很危险）。所以：小步长 + 正反双向 + 多轮取稳定值。
  const trace = [];
  const onePass = async () => {
    sc.scrollTop = 0; await sl(350); collect();
    for (let y = 0; y <= sc.scrollHeight + step; y += step) { sc.scrollTop = y; await sl(120); collect(); }
    sc.scrollTop = sc.scrollHeight; await sl(300); collect();
    for (let y = sc.scrollHeight; y >= 0; y -= step) { sc.scrollTop = y; await sl(120); collect(); }
    sc.scrollTop = 0; await sl(200); collect();
  };
  let prev = -1;
  for (let pass = 0; pass < 4; pass++) {
    await onePass();
    trace.push(rows.size);
    if (rows.size === prev) break;      // 连续两轮一致 → 认为读全了
    prev = rows.size;
  }
  return {
    ok: true, unique: rows.size, all: Array.from(rows.values()),
    滚动容器: clean(sc.className).slice(0, 40), 滚动高: sc.scrollHeight, 可见高: sc.clientHeight, 增长轨迹: trace,
  };
};

async function scanSkuTable(page, step = 150) {
  return page.evaluate(SCAN_SRC, step);
}

module.exports = { scanSkuTable };
