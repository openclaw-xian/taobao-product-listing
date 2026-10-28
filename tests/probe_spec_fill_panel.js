#!/usr/bin/env node
/**
 * 侦察：「批量填充规格主图」面板的**左右两侧结构**。
 * 背景：`tb_fill_spec_images.js` 跑完读回是「9 图位 / 9 有图 / 0 空位」，但 `verify_spec_images.js`
 *   发现 **8 个图位挂的是同一张图**（唯一 src 只有 2 个）= 颜色串位。
 *   怀疑点：脚本右侧选值的判据是 `li.sku-item` 文本 `startsWith(col + '-')`（MZB 那套「颜色-尺寸」
 *   单层写法）；两层规格下面板右侧大概率是**独立的颜色值**（不带 `-尺寸`）→ 一个都选不中
 *   → 点图时作用在「默认选中的全部值」上 → 全被同一张覆盖。
 *
 * 用法：node tests/probe_spec_fill_panel.js [--port 9120]
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

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().filter((x) => /publish\.htm/.test(x.url())).pop();
    const dump = () => page.evaluate(() => {
      const cls = (e) => String((e && e.getAttribute && e.getAttribute('class')) || '');
      const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const dlgs = Array.from(document.querySelectorAll('.next-dialog')).filter(vis);
      const d = dlgs[dlgs.length - 1];
      if (!d) return { 无弹层: true };
      const items = Array.from(d.querySelectorAll('li.sku-item,[class*=sku-item]')).filter(vis)
        .map((e) => ({ t: clean(e.innerText).slice(0, 40), cls: cls(e).slice(0, 46), 选中: /selected|checked|active/i.test(cls(e)) || !!e.querySelector('input:checked') }));
      // 左侧图片卡片（在 iframe 里，这里只能看弹层自身的输入/文本）
      const inputs = Array.from(d.querySelectorAll('input')).filter(vis).map((i) => ({ ph: i.getAttribute('placeholder'), v: i.value }));
      const btns = Array.from(d.querySelectorAll('button')).filter(vis).map((b) => clean(b.innerText).slice(0, 14));
      return { 弹层文本: clean(d.innerText).slice(0, 260), 右侧项数: items.length, 右侧项: items.slice(0, 14), inputs, btns };
    });

    const before = await dump();
    console.log('面板现状:', JSON.stringify(before, null, 1));

    // 打开填充面板：点抽屉里第一个图位
    const slot = await page.evaluate(() => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const d = Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis)[0];
      const s = d ? Array.from(d.querySelectorAll('.sell-color-option-image-upload')).filter(vis)[0] : null;
      if (!s) return null;
      s.scrollIntoView({ block: 'center' });
      const r = s.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    if (slot) { await page.mouse.click(slot.x, slot.y); await sleep(5000); }
    console.log('\n点第一个图位后:', JSON.stringify(await dump(), null, 1));

    // 面板里 iframe 的情况
    const frs = page.frames().filter((f) => /sucai-selector-ng/.test(f.url()));
    console.log('\n面板 iframe 数:', frs.length);
    for (const fr of frs) {
      const r = await fr.evaluate(() => {
        const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const names = Array.from(new Set(Array.from(document.querySelectorAll('div,li')).filter(vis)
          .map((e) => (clean(e.innerText).match(/[\w\u4e00-\u9fa5.()（）-]+\.(jpe?g|png|webp)/gi) || []).join('|'))
          .filter((t) => t && !t.includes('|')))).slice(0, 20);
        const btns = Array.from(document.querySelectorAll('button')).filter(vis).map((b) => ({ t: clean(b.innerText).slice(0, 16), disabled: !!b.disabled }));
        return { 文件名们: names, 按钮: btns.slice(-6) };
      });
      console.log('  iframe:', JSON.stringify(r, null, 1));
    }
  } finally { await browser.close().catch(() => {}); }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
