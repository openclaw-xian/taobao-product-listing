#!/usr/bin/env node
/**
 * 侦察：「批量填充规格主图」面板**右侧规格值列表**的真实结构（两层规格下）。
 * 背景：`tb_fill_spec_images.js` 的 `listValues()` 用 `li.sku-item` 文本 `startsWith(颜色 + '-')` 过滤，
 *   那是 MZB 那套「颜色-尺寸挤在一列」的单层写法。两层规格（颜色分类 × 地毯尺寸）下右侧大概率是
 *   **独立的颜色值**（不带 `-尺寸`）→ 一个都选不中 → 点图时作用到"默认已选的全部值"上
 *   → 9 个规格图槽被同一张图覆盖（实测：唯一 src 只有 2 个）。
 *
 * 用法：node tests/probe_spec_panel_right.js [--port 9120]
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().filter((p) => /publish\.htm/.test(p.url())).pop();
    if (!page) { say('没有发布页'); process.exitCode = 1; return; }

    // 打开填充面板：点抽屉里第一个**空图位**
    const open = await page.evaluate(() => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const d = Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis)[0];
      if (!d) return { ok: false, why: 'no_drawer' };
      const slot = Array.from(d.querySelectorAll('.sell-color-option-image-upload')).filter(vis).find((e) => !e.querySelector('img'));
      if (!slot) return { ok: false, why: 'no_empty_slot' };
      slot.scrollIntoView({ block: 'center' });
      const r = slot.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    say('打开填充面板:', open);
    if (!open.ok) { process.exitCode = 1; return; }
    await page.mouse.click(open.x, open.y);
    await sleep(6000);

    const dump = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const cls = (e) => String((e && e.getAttribute && e.getAttribute('class')) || '');
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const dlgs = Array.from(document.querySelectorAll('.next-dialog')).filter(vis);
      const d = dlgs[dlgs.length - 1];
      if (!d) return { 无弹层: true, 所有对话框数: dlgs.length };
      const items = Array.from(d.querySelectorAll('li.sku-item')).filter(vis).map((e) => {
        const box = e.querySelector('.sku-image-container');
        return { 文本: clean(e.innerText).slice(0, 46), 已选: /selected/i.test(cls(box || e)) || /selected/i.test(cls(e)) };
      });
      return {
        弹层文本前200: clean(d.innerText).slice(0, 200),
        右侧项数: items.length,
        右侧项: items.slice(0, 14),
        所有li数: d.querySelectorAll('li').length,
        所有li样本: Array.from(d.querySelectorAll('li')).filter(vis).slice(0, 8).map((e) => clean(e.innerText).slice(0, 30)),
      };
    });
    console.log(JSON.stringify(dump, null, 1));
    const frs = page.frames().filter((f) => /sucai-selector-ng/.test(f.url()));
    say('面板 iframe 数:', frs.length);
  } finally { await browser.close().catch(() => {}); }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
