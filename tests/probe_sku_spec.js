#!/usr/bin/env node
/** 探针：SKU 表里的「规格图」列 / 颜色规格图入口（玩 playbook §7.5「批量填充规格主图」）。 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const LOG = path.join(__dirname, '_spec_probe.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== probe_sku_spec ${new Date().toISOString()} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('找不到发布页'); return; }
    const info = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const table = Array.from(document.querySelectorAll('table')).filter(vis)[0];
      if (!table) return { ok: false, why: 'no_table' };
      const ths = Array.from(table.querySelectorAll('thead th')).map((e) => clean(e.innerText));
      const firstRow = Array.from(table.querySelectorAll('tbody tr')).filter(vis)[0];
      const tds = firstRow ? Array.from(firstRow.querySelectorAll('td')).map((td, i) => {
        const img = td.querySelector('img');
        const inp = td.querySelector('input');
        const btn = td.querySelector('button');
        return {
          i,
          文本: clean(td.innerText).slice(0, 22),
          有img: !!img,
          imgSrc: img ? String(img.src).slice(-24) : null,
          有input: !!inp,
          input值: inp ? String(inp.value || '').slice(0, 20) : null,
          有button: !!btn,
          cls: String(td.className).slice(0, 40),
        };
      }) : [];
      return {
        ok: true,
        表头: ths,
        表头数: ths.length,
        首行: tds,
        图格候选数: document.querySelectorAll('[class*=sell-sku-cell-image],[class*=sku-cell-image]').length,
        图格类名样本: Array.from(document.querySelectorAll('[class*="sku-cell-image"]')).slice(0, 3).map((e) => String(e.className).slice(0, 60)),
        规格区文本: (clean(document.body.innerText).match(/SKU模式[^\n]{0,110}/) || [])[0] || null,
      };
    });
    log('SKU 表结构:', info);
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_sku_table.png') }).catch(() => {});
    log('截图: output/recon_sku_table.png');
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
