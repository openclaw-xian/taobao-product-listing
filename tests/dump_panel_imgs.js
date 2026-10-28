#!/usr/bin/env node
/** 极简探针：dump「批量填充规格主图」左侧可见图片的**文件名 + 坐标**（确定该点哪一张）。 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { say('找不到发布页'); return; }
    let fr = page.frames().filter((f) => /handleId=|sucai-selector-ng/.test(f.url())).pop();
    if (!fr) {
      const c = await page.evaluate(() => {
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const d = Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis)[0];
        if (!d) return null;
        const slot = Array.from(d.querySelectorAll('.sell-color-option-image-upload')).filter(vis).find((e) => !e.querySelector('img'));
        if (!slot) return null;
        slot.scrollIntoView({ block: 'center' });
        const r = slot.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (c) { await page.mouse.click(c.x, c.y); await sleep(6000); }
      fr = page.frames().filter((f) => /handleId=|sucai-selector-ng/.test(f.url())).pop();
      if (!fr) { say('面板开不了'); return; }
    }
    const info = await fr.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const list = document.querySelector('[class*="PicturesShow_main"]') || document.scrollingElement;
      const out = [];
      Array.from(document.querySelectorAll('img')).filter(vis).forEach((img) => {
        const r = img.getBoundingClientRect();
        if (r.width < 50 || r.height < 50) return;
        // 最近的"含 .jpg 文本"的祖先（尽量小）
        let hit = null, p = img;
        for (let k = 0; k < 6 && p; k++) {
          p = p.parentElement; if (!p) break;
          const t = clean(p.innerText);
          if (/\.jpg|\.jpeg|\.png/i.test(t)) { hit = { 层: k, 文本: t.slice(0, 46), 名数: (t.match(/[\w\u4e00-\u9fa5.-]+\.(jpg|jpeg|png)/gi) || []).length }; break; }
        }
        out.push({ 顶部: Math.round(r.top), 右: Math.round(r.right), 尺寸: Math.round(r.width), title: img.title || null, alt: img.alt || null, src尾: String(img.src).slice(-26), 祖先: hit });
      });
      return { 视口: { w: innerWidth, h: innerHeight }, 列表可滚: list ? { sh: list.scrollHeight, ch: list.clientHeight, st: list.scrollTop } : null, 图片数: out.length, 图片: out.slice(0, 12) };
    });
    say(JSON.stringify(info, null, 1));
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
