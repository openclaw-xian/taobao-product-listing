#!/usr/bin/env node
/**
 * 侦察：**两层规格**（颜色分类 × 地毯尺寸）下的 SKU 表真实结构。
 * 背景：tb_import_sku.js / tb_checklist.js 的扫表逻辑按 MZB-001 那套「颜色-尺寸挤在一列」写的
 *   （判据：单元格文本含 `-` 且不含商品名），两层规格下颜色和尺寸是**两个单元格、都不含 `-`**
 *   → 读到 0 行 / 9 行。总库存 6034 却正确，说明行是在的。
 * 要弄清：thead 表头有哪些列 / tbody 每行几个 td / 值在文本还是 input / 虚拟滚动容器是谁 / 一共多少行。
 *
 * 用法：node tests/probe_sku_table.js [--port 9120]
 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const p = browser.contexts()[0].pages().filter((x) => /publish\.htm/.test(x.url())).pop();
    if (!p) { console.log('没有 publish.htm 页'); process.exit(1); }
    const r = await p.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const tables = Array.from(document.querySelectorAll('table'));
      const out = tables.map((t, idx) => {
        const thead = t.querySelector('thead');
        const ths = thead ? Array.from(thead.querySelectorAll('th')).map((e) => clean(e.innerText)) : [];
        const trs = Array.from(t.querySelectorAll('tbody tr'));
        const sample = trs.slice(0, 3).map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => {
          const i = td.querySelector('input');
          return { 文本: clean(td.innerText).slice(0, 40), input值: i ? String(i.value || '') : null, cls: clean(td.className).slice(0, 30) };
        }));
        return { idx, 可见: vis(t), 行数: trs.length, 表头: ths, 前3行: sample };
      });
      // 虚拟滚动容器候选
      const scrollers = Array.from(document.querySelectorAll('div')).filter(vis)
        .filter((e) => e.scrollHeight - e.clientHeight > 60)
        .map((e) => ({ cls: clean(e.className).slice(0, 60), scrollHeight: e.scrollHeight, clientHeight: e.clientHeight, 行数: e.querySelectorAll('tbody tr').length }))
        .slice(0, 8);
      return { 表数: tables.length, 表: out, 可滚动容器: scrollers, 页面含: clean(document.body.innerText).match(/共\s*\d+\s*条|已选择\s*\d+\/\d+\s*项/g) };
    });
    console.log(JSON.stringify(r, null, 1));
  } finally { await browser.close().catch(() => {}); }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
