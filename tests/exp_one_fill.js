#!/usr/bin/env node
/** 单值实验：点「米白-宽30cm长3米」这一项 → 点左侧米白图 → 看图位是否 +1（验证"逐项填充"可行否）。 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

const state = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const d = Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis)[0];
  const slots = d ? Array.from(d.querySelectorAll('.sell-color-option-image-upload')).filter(vis) : [];
  return { 图位: slots.length, 已有图: slots.filter((e) => e.querySelector('img')).length, 空: slots.filter((e) => !e.querySelector('img')).length };
};
const panelSel = () => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
  return dlg ? dlg.querySelectorAll('.sku-image-container.selected').length : -1;
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { say('找不到发布页'); return; }
    say('起始:', await page.evaluate(state));
    // 确保面板开着
    let has = await page.evaluate(() => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return Array.from(document.querySelectorAll('.next-dialog')).filter(vis).length > 0;
    });
    if (!has) {
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
      if (c) { await page.mouse.click(c.x, c.y); await sleep(5000); }
      has = true;
    }
    say('面板已开, 已选数:', await page.evaluate(panelSel));

    // 实验：点一项 → 点图
    const target = '米白-宽30cm长3米';
    const it = await page.evaluate((t) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
      if (!dlg) return null;
      const el = Array.from(dlg.querySelectorAll('li.sku-item')).find((e) => clean(e.innerText) === t);
      if (!el) return null;
      const box = el.querySelector('.sku-image-container') || el;
      box.scrollIntoView({ block: 'center' });
      const r = box.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 已选: /selected/i.test(String(box.className)) };
    }, target);
    say('目标项:', target, it);

    // ① 单击项内图区
    await page.mouse.move(it.x, it.y); await sleep(150); await page.mouse.click(it.x, it.y); await sleep(800);
    say('① 单击项内图区后 已选数:', await page.evaluate(panelSel), '| 该项已选?', await page.evaluate((t) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const dlg = document.querySelector('.next-dialog');
      const el = dlg && Array.from(dlg.querySelectorAll('li.sku-item')).find((e) => clean(e.innerText) === t);
      const box = el && el.querySelector('.sku-image-container');
      return box ? /selected/i.test(String(box.className)) : null;
    }, target));

    // ② Ctrl+点击该项
    await page.keyboard.down('Control');
    await page.mouse.click(it.x, it.y);
    await page.keyboard.up('Control');
    await sleep(800);
    say('② Ctrl+点击后 已选数:', await page.evaluate(panelSel));

    // ③ 点左侧米白图 → 看图位
    const g = await page.evaluate(() => {
      const f = Array.from(document.querySelectorAll('iframe')).filter((x) => /handleId=|sucai-selector-ng/.test(x.src || '')).pop();
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { left: r.left, top: r.top };
    });
    const fr = page.frames().filter((f) => /handleId=|sucai-selector-ng/.test(f.url())).pop();
    if (g && fr) {
      const p = await fr.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const imgs = Array.from(document.querySelectorAll('img')).filter(vis).filter((e) => { const r = e.getBoundingClientRect(); return r.width >= 50 && r.height >= 50; });
        for (const img of imgs) {
          let q = img;
          for (let k = 0; k < 6 && q; k++) { q = q.parentElement; if (!q) break; if (clean(q.innerText).includes('猫抓布规格图-米白')) { const r = img.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; } }
        }
        return null;
      });
      if (p) { await page.mouse.click(Math.round(g.left + p.x), Math.round(g.top + p.y)); await sleep(2500); }
      else say('   左侧没找到米白图');
    }
    say('③ 点图后:', await page.evaluate(state));
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
