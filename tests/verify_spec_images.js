#!/usr/bin/env node
/**
 * 核对：**编辑规格抽屉里 9 个图位到底挂的是哪张图**（防颜色串位）。
 * 背景：`tb_fill_spec_images.js` 的读回只有「图位总数/已有图/空图位」三个计数 —— 计数全绿也可能
 *   把 9 张图挂错颜色（规格图头号废品原因）。这里额外做两件事：
 *   ① 9 个图位的 img src 必须**互不相同**（相同 = 有重复挂图）；
 *   ② 把每个图位**相邻的规格值文本**和它的 img src 一起打出来，人工/程序都能核对配对。
 *
 * 用法：node tests/verify_spec_images.js [--port 9120]
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
    const r = await p.evaluate(() => {
      const cls = (e) => String((e && e.getAttribute && e.getAttribute('class')) || '');
      const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const d = Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis)[0];
      if (!d) return { 抽屉不在: true };
      const slots = Array.from(d.querySelectorAll('.sell-color-option-image-upload')).filter(vis);
      const rows = slots.map((s, i) => {
        const img = s.querySelector('img');
        const rect = s.getBoundingClientRect();
        // 图位**左边**那一列通常是规格值文本；取其祖先行里的文字
        let row = s.parentElement;
        for (let k = 0; k < 4 && row; k++) { if (clean(row.innerText).length > 1) break; row = row.parentElement; }
        // 规格值 = 抽屉里同一 y 附近的文本
        const all = Array.from(d.querySelectorAll('*')).filter(vis)
          .filter((e) => e.children.length === 0 && clean(e.innerText))
          .map((e) => { const rr = e.getBoundingClientRect(); return { t: clean(e.innerText), y: Math.round(rr.top + rr.height / 2), x: Math.round(rr.right) }; })
          .filter((x) => Math.abs(x.y - Math.round(rect.top + rect.height / 2)) < 14 && x.x < rect.left)
          .sort((a, b) => b.x - a.x);
        return {
          序: i + 1,
          图位: { x: Math.round(rect.left), y: Math.round(rect.top) },
          有图: !!img,
          src: img ? String(img.src).slice(-60) : null,
          左侧文本: all.slice(0, 2).map((x) => x.t),
        };
      });
      const srcs = rows.map((x) => x.src).filter(Boolean);
      return { 图位数: slots.length, 有图: srcs.length, 唯一src数: new Set(srcs).size, 行: rows };
    });
    console.log(JSON.stringify(r, null, 1));
    if (r.行 && new Set(r.行.map((x) => x.src).filter(Boolean)).size !== r.行.filter((x) => x.src).length) {
      console.log('\n⚠ 有重复的规格图（同一个 src 挂到了多个图位）');
    }
  } finally { await browser.close().catch(() => {}); }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
