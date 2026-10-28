#!/usr/bin/env node
/** 最小实验：详情面板里「点哪里才算选中」—— 每次点击后读回底部「确定 (N)」的文本。 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

const findPanel = (page) => page.frames().filter((f) => /sucai-selector-ng/.test(f.url())).pop();
const geom = (page) => page.evaluate(() => {
  const f = Array.from(document.querySelectorAll('iframe')).filter((x) => /sucai-selector-ng/.test(x.src || '')).pop();
  if (!f) return null;
  const r = f.getBoundingClientRect();
  return { left: r.left, top: r.top };
});
const footer = (fr) => fr.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /^确定/.test(clean(x.innerText)));
  return b ? { 文本: clean(b.innerText), disabled: !!b.disabled } : { 文本: null, disabled: null };
});
// 卡片几何：**从大 img 往上找**（文件名文本与 img 是兄弟节点，不能从文本往下找 img）
const cardGeom = (fr, name) => fr.evaluate((n) => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const imgs = Array.from(document.querySelectorAll('img')).filter(vis).filter((e) => { const r = e.getBoundingClientRect(); return r.width >= 60 && r.height >= 60; });
  for (const img of imgs) {
    let p = img;
    for (let k = 0; k < 5 && p; k++) {
      p = p.parentElement;
      if (!p) break;
      const text = clean(p.innerText);
      if (text.includes(n)) {
        const r = img.getBoundingClientRect();
        return {
          卡片: text.slice(0, 26),
          中心: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
          右下: { x: r.right - 10, y: r.bottom - 10 },
          右上: { x: r.right - 10, y: r.top + 10 },
          卡片框: (() => { const c = p.getBoundingClientRect(); return { w: Math.round(c.width), h: Math.round(c.height) }; })(),
        };
      }
    }
  }
  return null;
}, name);

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    let fr = findPanel(page);
    if (!fr) { say('★ 面板没开'); return; }
    say('起始底部:', await footer(fr));

    // 用 detail_04（应尚未选中）做实验
    const g = await geom(page);
    const name = 'detail_01.jpg';
    say('目标卡片:', name, await cardGeom(fr, name));
    const cg = await cardGeom(fr, name);
    if (!cg || !g) {
      say('★ 拿不到卡片坐标');
      say('图片空间 iframe:', page.frames().filter((f) => /sucai-selector-ng/.test(f.url())).map((f) => (f.name() || '(无名)') + ' | ' + f.url().slice(-46)));
      say('该 iframe 里可见的文件名样本:', await fr.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        return Array.from(document.querySelectorAll('div')).filter(vis).map((e) => clean(e.innerText)).filter((t) => /\.(jpg|jpeg|png)$/i.test(t) && t.length < 26).slice(0, 16);
      }));
      return;
    }

    const clickAt = async (tag, p) => {
      await page.mouse.move(Math.round(g.left + p.x), Math.round(g.top + p.y));
      await sleep(300);
      await page.mouse.click(Math.round(g.left + p.x), Math.round(g.top + p.y));
      await sleep(1800);
      say(tag, '→ 底部:', await footer(fr));
    };

    await clickAt('① 点图片中心', cg.中心);
    await clickAt('② 点卡片右下角', cg.右下);
    await clickAt('③ 点卡片右上角', cg.右上);
    // ④ 双击图片中心
    await page.mouse.dblclick(Math.round(g.left + cg.中心.x), Math.round(g.top + cg.中心.y));
    await sleep(2000);
    say('④ 双击图片中心 → 底部:', await footer(fr));
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
