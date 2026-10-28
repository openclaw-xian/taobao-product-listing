#!/usr/bin/env node
/** 探针：「批量填充规格主图」面板里，右侧 SKU 项长什么样、点一下 class 怎么变（找"选中"的真相）。 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const LOG = path.join(__dirname, '_fill_panel.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== probe_fill_panel ${new Date().toISOString()} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

const itemInfo = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
  if (!dlg) return { 面板: false };
  const items = Array.from(dlg.querySelectorAll('li.sku-item'));
  const it = items[0];
  const r = it ? it.getBoundingClientRect() : null;
  return {
    面板: true,
    项数: items.length,
    首项class: it ? String(it.className) : null,
    首项HTML: it ? it.outerHTML.slice(0, 620) : null,
    首项里勾选元素: it ? Array.from(it.querySelectorAll('input,[class*=check],[class*=select],[class*=icon]')).map((e) => e.tagName.toLowerCase() + '.' + String(e.className).slice(0, 34)).slice(0, 8) : [],
    面板按钮全部: Array.from(dlg.querySelectorAll('button')).filter(vis).map((b) => clean(b.innerText)).filter(Boolean).slice(0, 14),
    面板里全选字样: (clean(dlg.innerText).match(/全选|反选|清空|批量选|按颜色/g) || []),
    坐标: r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) } : null,
    已选标记数: Array.from(dlg.querySelectorAll('li.sku-item')).filter((e) => /selected|checked|active/i.test(String(e.className))).length,
  };
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('找不到发布页'); return; }
    let st = await page.evaluate(itemInfo);
    if (!st.面板) {
      // 打开抽屉 + 点第一个空图位
      await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const pool = Array.from(document.querySelectorAll('button,a,span,div')).filter(vis).filter((e) => clean(e.innerText) === '编辑规格');
        const el = pool.filter((e) => !pool.some((o) => o !== e && e.contains(o)))[0];
        if (el) el.scrollIntoView({ block: 'center' });
      });
      await sleep(1000);
      const c = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        let d = Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis)[0];
        if (!d) {
          const pool = Array.from(document.querySelectorAll('button,a,span,div')).filter(vis).filter((e) => clean(e.innerText) === '编辑规格');
          const el = pool.filter((e) => !pool.some((o) => o !== e && e.contains(o)))[0];
          if (!el) return null;
          el.click(); return { opened: true };
        }
        const slot = Array.from(d.querySelectorAll('.sell-color-option-image-upload')).filter(vis).find((e) => !e.querySelector('img'));
        if (!slot) return { noSlot: true };
        slot.scrollIntoView({ block: 'center' });
        const r = slot.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      log('开启面板步骤:', c);
      await sleep(4000);
      if (c && c.x) { await page.mouse.click(c.x, c.y); await sleep(5000); }
      st = await page.evaluate(itemInfo);
    }
    log('面板项结构:', st);
    // 点第一项一次，看 class 怎么变
    if (st.坐标) {
      await page.mouse.move(st.坐标.x, st.坐标.y);
      await sleep(200);
      await page.mouse.click(st.坐标.x, st.坐标.y);
      await sleep(1500);
      const after = await page.evaluate(itemInfo);
      log('点一次后:', { 首项class: after.首项class, 已选标记数: after.已选标记数 });
    }
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
