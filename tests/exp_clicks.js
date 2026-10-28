#!/usr/bin/env node
/** 小实验：面板里连续点同一张图的右上角小框 N 次 → 点确定 → 读回填进几个（定节奏）。 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const N = parseInt(process.argv[process.argv.indexOf('--n') + 1] || '6', 10);
const NAME = process.env.TB_FIG || '猫抓布规格图-米白';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
const slots = (page) => page.evaluate(() => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const d = Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis)[0];
  const s = d ? Array.from(d.querySelectorAll('.sell-color-option-image-upload')).filter(vis) : [];
  return { 图位: s.length, 已有图: s.filter((e) => e.querySelector('img')).length };
});
const panelOpen = (page) => page.evaluate(() => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return Array.from(document.querySelectorAll('.next-dialog')).filter(vis).length > 0;
});

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { say('找不到发布页'); return; }
    say('起始:', await slots(page));
    if (!(await panelOpen(page))) {
      const c = await page.evaluate(() => {
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const d = Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis)[0];
        if (!d) return null;
        const s = Array.from(d.querySelectorAll('.sell-color-option-image-upload')).filter(vis).find((e) => !e.querySelector('img'));
        if (!s) return null;
        s.scrollIntoView({ block: 'center' });
        const r = s.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (c) { await page.mouse.click(c.x, c.y); await sleep(6000); }
    }
    say('面板已开:', await panelOpen(page));
    const g = await page.evaluate(() => {
      const f = Array.from(document.querySelectorAll('iframe')).filter((x) => /handleId=|sucai-selector-ng/.test(x.src || '')).pop();
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { left: r.left, top: r.top };
    });
    const fr = page.frames().filter((f) => /handleId=|sucai-selector-ng/.test(f.url())).pop();
    if (!g || !fr) { say('没有素材 iframe'); return; }
    // 先把素材列表滚到顶（否则目标图可能在视口外 → inView 过滤掉、找不到）
    await fr.evaluate(async () => {
      const sl = (ms) => new Promise((r) => setTimeout(r, ms));
      const list = document.querySelector('[class*="PicturesShow_main"]') || document.scrollingElement;
      if (list) { list.scrollTop = 0; await sl(500); }
    });
    const pos = await fr.evaluate((n) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const inView = (r) => r.top > 6 && r.bottom < innerHeight - 6 && r.left > 0 && r.right < innerWidth;
      const imgs = Array.from(document.querySelectorAll('img')).filter(vis).filter((e) => { const r = e.getBoundingClientRect(); return r.width >= 50 && r.height >= 50; });
      for (const img of imgs) {
        let p = img;
        for (let k = 0; k < 6 && p; k++) {
          p = p.parentElement; if (!p) break;
          const t = clean(p.innerText);
          if (!t.includes(n)) continue;
          // ⚠️ 不能用"恰好一个文件名"：规格图名被 CSS 截断（`猫抓布规格图-米白…` 无扩展名）→ 用"不超过一个"
          const names = Array.from(new Set((t.match(/[\w\u4e00-\u9fa5.-]+\.(jpg|jpeg|png)/gi) || []).map((x) => x.toLowerCase())));
          if (names.length > 1) continue;
          const r = img.getBoundingClientRect();
          if (!inView(r)) continue;
          return { ok: true, x: Math.round(r.right - 9), y: Math.round(r.top + 9), 名: names[0], rect: { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) } };
        }
      }
      return { ok: false, 视口高: innerHeight };
    }, NAME);
    say('目标图小框:', pos);
    if (!pos.ok) return;
    const abs = { x: Math.round(g.left + pos.x), y: Math.round(g.top + pos.y) };
    for (let i = 0; i < N; i++) {
      await page.mouse.move(abs.x, abs.y); await sleep(180);
      await page.mouse.click(abs.x, abs.y);
      await sleep(1000);
      say(`   点第 ${i + 1} 次完成`);
    }
    // 点确定
    const okb = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
      if (!dlg) return null;
      const b = Array.from(dlg.querySelectorAll('button')).filter(vis).find((x) => /^确定/.test(clean(x.innerText)));
      if (!b || b.disabled) return { ok: false };
      const r = b.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    if (okb && okb.ok) { await page.mouse.click(okb.x, okb.y); await sleep(4000); say('   已点确定'); }
    say('结果（点了 ' + N + ' 次）:', await slots(page));
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
