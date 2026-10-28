#!/usr/bin/env node
/** 按下拉类属性逐个填（点开 → 选选项 → 点空白触发）。属性名/值按素材包（PE-001）。 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

const PAIRS = [
  ['库存类型', '现货'],
  ['功能', '美化装饰'],
  ['适用空间', '宿舍'],
  ['风格', '简约现代'],
  ['图案', '仿木纹'],
  ['材质', '其他'],
  ['面层工艺', '浮雕'],
];

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = b.contexts()[0].pages().filter((p) => /publish\.htm/.test(p.url()) && !/fromAIImage/.test(p.url())).pop();
    if (!page) { say('没有发布页'); return; }

    for (const [name, val] of PAIRS) {
      // ① 找容器 + 点开它的下拉
      const c1 = await page.evaluate((n) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const cands = Array.from(document.querySelectorAll('div')).filter(vis)
          .filter((e) => new RegExp('^\\\\*?\\\\s*' + n + '(\\\\s|$)').test(clean(e.innerText)) && clean(e.innerText).length < 30);
        cands.sort((a, b) => a.innerText.length - b.innerText.length);
        let box = cands[0];
        if (!box) return { ok: false, why: 'no_box' };
        box.scrollIntoView({ block: 'center' });
        let inp = Array.from(box.querySelectorAll('input')).filter(vis)[0];
        if (!inp) { let p = box.parentElement; for (let k = 0; k < 3 && p && !inp; k++) { inp = Array.from(p.querySelectorAll('input')).filter(vis)[0]; if (!inp) p = p.parentElement; } }
        if (!inp) return { ok: false, why: 'no_input', 容器: clean(box.innerText).slice(0, 24) };
        if (inp.value && clean(inp.value) === String(n)) { /* 已填 */ }
        const r = inp.getBoundingClientRect();
        return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 现: inp.value };
      }, name);
      if (!c1.ok) { say(`✗ ${name}:`, c1); continue; }
      await page.mouse.move(c1.x, c1.y);
      await sleep(200);
      await page.mouse.click(c1.x, c1.y);
      await sleep(1800);
      // ② 选选项
      const c2 = await page.evaluate((v) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const pool = Array.from(document.querySelectorAll('li,[class*=option-item],[class*=menu-item],[class*=select-item]')).filter(vis);
        const hit = pool.find((e) => clean(e.innerText) === v) || pool.find((e) => clean(e.innerText).includes(v));
        if (!hit) return { ok: false, why: 'no_option', 候选: pool.map((e) => clean(e.innerText)).slice(0, 16) };
        for (const ev of ['mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        return { ok: true, 选中: clean(hit.innerText).slice(0, 16) };
      }, val);
      await sleep(700);
      // ③ 点空白触发
      const blank = await page.evaluate(() => {
        for (const c of [{ x: 1250, y: 60 }, { x: 300, y: 62 }]) {
          const el = document.elementFromPoint(c.x, c.y);
          if (el && !el.closest('input,textarea,select,button,a')) return c;
        }
        return { x: 1250, y: 60 };
      });
      await page.mouse.click(blank.x, blank.y);
      await sleep(600);
      say(`${c2.ok ? '✓' : '✗'} ${name} = ${val}`, c2.ok ? c2.选中 : JSON.stringify(c2));
    }
  } finally { await b.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
