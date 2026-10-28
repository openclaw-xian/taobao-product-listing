#!/usr/bin/env node
/**
 * 在表单页把「品牌」改成目标值 —— 品牌框是 `next-select-auto-complete` 型（在输入框里打字才出候选）。
 * 用法：node tests/fix_brand2.js    （目标品牌用 TB_BRAND，默认「无品牌」）
 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const WANT = process.env.TB_BRAND || '\u65e0\u54c1\u724c';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = b.contexts()[0].pages().filter((p) => /publish\.htm/.test(p.url())).pop();
    if (!page) { say('没有发布页'); return; }

    const findBrand = () => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return Array.from(document.querySelectorAll('input')).filter(vis).filter((i) => (i.getAttribute('placeholder') || '') === '请输入').find((i) => {
        let p = i;
        for (let k = 0; k < 5 && p; k++) { p = p.parentElement; if (!p) break; if (/next-select-auto-complete/.test(String(p.className))) return true; }
        return false;
      }) || null;
    };

    const c0 = await page.evaluate(() => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const list = Array.from(document.querySelectorAll('input')).filter(vis).filter((i) => (i.getAttribute('placeholder') || '') === '请输入');
      return list.map((i) => {
        let p = i, ac = false;
        for (let k = 0; k < 5 && p; k++) { p = p.parentElement; if (!p) break; if (/next-select-auto-complete/.test(String(p.className))) { ac = true; break; } }
        const r = i.getBoundingClientRect();
        return { 现值: String(i.value || '').slice(0, 20), name: i.getAttribute('name'), autoComplete: ac, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
    });
    say('① 页面上的「请输入」输入框:', c0);
    const brand = c0.find((x) => x.autoComplete);
    if (!brand) { say('✗ 没找到品牌框（auto-complete）'); process.exitCode = 1; return; }
    if (brand.现值 === WANT) { say('✓ 品牌已经是目标值:', WANT); return; }

    await page.mouse.move(brand.x, brand.y);
    await sleep(200);
    await page.mouse.click(brand.x, brand.y);
    await sleep(1200);
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.type(WANT);
    await sleep(2500);

    const pick = await page.evaluate((w) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const items = Array.from(document.querySelectorAll('.options-item,[class*=option-item],li')).filter(vis);
      const hit = items.find((e) => clean(e.innerText) === w) || items.find((e) => clean(e.innerText).includes(w));
      if (!hit) return { ok: false, why: 'no_option', 候选: items.map((e) => clean(e.innerText)).slice(0, 14) };
      for (const ev of ['mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      return { ok: true, 选中: clean(hit.innerText).slice(0, 16) };
    }, WANT);
    say('② 选候选:', pick);
    await sleep(1200);

    const blank = await page.evaluate(() => {
      for (const p of [{ x: 1250, y: 60 }, { x: 300, y: 62 }]) {
        const el = document.elementFromPoint(p.x, p.y);
        if (el && !el.closest('input,textarea,select,button,a')) return p;
      }
      return { x: 1250, y: 60 };
    });
    await page.mouse.click(blank.x, blank.y);
    await sleep(1000);

    const back = await page.evaluate(() => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const out = [];
      for (const i of Array.from(document.querySelectorAll('input')).filter(vis)) {
        let p = i, ac = false;
        for (let k = 0; k < 5 && p; k++) { p = p.parentElement; if (!p) break; if (/next-select-auto-complete/.test(String(p.className))) { ac = true; break; } }
        if (ac) out.push({ 品牌值: String(i.value || '') });
      }
      return out;
    });
    say('③ 读回品牌:', back, back[0] && back[0].品牌值 === WANT ? '✓ 对了' : '✗ 还没对');
  } finally { await b.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
