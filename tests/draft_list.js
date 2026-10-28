#!/usr/bin/env node
/** 读「我的商品 → 草稿」列表（供用户决定删哪些）。只读。 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const pages = browser.contexts()[0].pages();
    let p = pages.find((x) => /SellManage\/draft|draft/i.test(x.url()));
    if (!p) { say('没找到草稿列表页（我的商品）'); return; }
    say('草稿页:', p.url().slice(0, 100));
    await p.bringToFront().catch(() => {});
    await p.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(9000);
    const info = await p.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const rows = Array.from(document.querySelectorAll('tr,[class*="row"],[class*="item"],[class*="card"]')).filter(vis)
        .map((e) => clean(e.innerText)).filter((t) => t.length > 10 && t.length < 160 && /猫抓板|墙纸|地毯|MZB|草稿|元/.test(t));
      const uniq = Array.from(new Set(rows));
      return {
        总文本片段: uniq.slice(0, 24),
        条数估计: uniq.length,
        空提示: (clean(document.body.innerText).match(/暂无[^\n]{0,20}/) || [])[0] || null,
      };
    });
    say('列表:', info);
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
