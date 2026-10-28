#!/usr/bin/env node
/** 探针：勾了「添加图片」后，编辑规格抽屉里**规格值旁的图位**长什么样（为写填图脚本定位用）。 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const LOG = path.join(__dirname, '_spec_slot.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== probe_spec_slot ${new Date().toISOString()} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('找不到发布页'); return; }
    // 打开抽屉
    const opened = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      if (Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis).length) return { already: true };
      const pool = Array.from(document.querySelectorAll('button,a,span,div')).filter(vis).filter((e) => clean(e.innerText) === '编辑规格');
      const el = pool.filter((e) => !pool.some((o) => o !== e && e.contains(o)))[0];
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    if (opened && !opened.already) { await page.mouse.click(opened.x, opened.y); await sleep(5000); }
    log('抽屉打开:', opened);

    const info = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const d = Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis)[0];
      if (!d) return { ok: false, why: 'no_drawer' };
      // 找含规格值文本的行
      const rows = Array.from(d.querySelectorAll('div,li')).filter(vis).filter((e) => clean(e.innerText).includes('米白-宽30cm长1米'));
      rows.sort((a, b) => a.innerText.length - b.innerText.length);
      const row = rows[0] || null;
      const slotCands = Array.from(d.querySelectorAll('[class*=dashed],[class*=image],[class*=picture],[class*=upload],[class*=img]')).filter(vis)
        .map((e) => ({ cls: String(e.className).slice(0, 52), text: clean(e.innerText).slice(0, 14), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height), 有img: !!e.querySelector('img') })).slice(0, 14);
      return {
        ok: true,
        抽屉尺寸: (() => { const r = d.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
        规格值行HTML: row ? row.outerHTML.slice(0, 700) : null,
        图位候选: slotCands,
        添加图片勾选: (() => {
          const cb = Array.from(d.querySelectorAll('.next-checkbox-wrapper,[class*=checkbox]')).find((e) => /添加图片/.test(clean(e.innerText)));
          return cb ? { cls: String(cb.className).slice(0, 60), checked: /checked/i.test(String(cb.className)) } : null;
        })(),
      };
    });
    log('抽屉结构:', info);
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_spec_slot.png') }).catch(() => {});
    log('截图: output/recon_spec_slot.png');
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
