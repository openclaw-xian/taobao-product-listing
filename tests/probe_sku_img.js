#!/usr/bin/env node
/** 探针：点 SKU 表第一列的空图格（`sell-sku-cell-image`）→ 看是不是「批量填充SKU搜索主图」（门禁 10）。 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const LOG = path.join(__dirname, '_sku_img.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== probe_sku_img_panel ${new Date().toISOString()} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

const dump = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const dlgs = Array.from(document.querySelectorAll('.next-dialog,[class*=drawer],[class*=Drawer],[class*=modal]')).filter(vis);
  return {
    弹窗数: dlgs.length,
    弹窗: dlgs.map((d) => clean(d.innerText).slice(0, 260)),
    弹窗里的按钮: (dlgs[0] ? Array.from(dlgs[0].querySelectorAll('button')) : []).filter(vis).map((b) => clean(b.innerText)).filter(Boolean).slice(0, 10),
    弹窗里的输入框: (dlgs[0] ? Array.from(dlgs[0].querySelectorAll('input')) : []).filter(vis).map((i) => i.getAttribute('placeholder') || '(无 ph)').slice(0, 8),
    SKU项数: document.querySelectorAll('li.sku-item,.sku-item').length,
    放大镜: document.querySelectorAll('i[aria-label="搜索"],.next-search-icon').length,
    计数: (clean(document.body.innerText).match(/\d+\s*\/\s*\d+/g) || []).slice(0, 6),
    iframe列表: Array.from(document.querySelectorAll('iframe')).map((f) => ({ src: String(f.src).slice(-44), w: Math.round(f.getBoundingClientRect().width) })).filter((x) => x.w > 0),
    页面尾部新文本: clean(document.body.innerText).slice(-260),
  };
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('找不到发布页'); return; }
    // 点**图格里的虚线方框**（`.main-content.dashed`）—— 点 td 中心会落在空白处、没反应（实测）
    const c = await page.evaluate(() => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const cells = Array.from(document.querySelectorAll('.sell-sku-cell-image')).filter(vis);
      if (!cells.length) return null;
      const td = cells[0];
      td.scrollIntoView({ block: 'center' });
      const box = td.querySelector('.main-content') || td.querySelector('.sell-component-image-v2') || td;
      const r = box.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), 目标: String(box.className).slice(0, 40), 有图: !!td.querySelector('img') };
    });
    log('第一个图格的可点方框:', c);
    if (!c) { log('没有图格'); return; }
    await page.mouse.move(c.x, c.y);
    await sleep(250);
    await page.mouse.click(c.x, c.y);
    await sleep(5000);
    log('单击后:', await page.evaluate(dump));
    // 单击没反应 → 试双击
    if ((await page.evaluate(() => document.querySelectorAll('.next-dialog').length)) === 0) {
      await page.mouse.dblclick(c.x, c.y);
      await sleep(5000);
      log('双击后:', await page.evaluate(dump));
    }
    log('图格 HTML:', await page.evaluate(() => {
      const el = document.querySelector('.sell-sku-cell-image');
      return el ? el.outerHTML.slice(0, 420) : null;
    }));
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_sku_img_panel.png') }).catch(() => {});
    log('截图: output/recon_sku_img_panel.png');
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
