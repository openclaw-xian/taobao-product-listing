#!/usr/bin/env node
/** 填「计价单位」= 数字输入 + 单位下拉（复合控件 / taoSirProp）。默认 1 卷，可用 TB_NUM / TB_UNIT 覆盖。 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const { guardCheck } = require(path.join(__dirname, '..', 'scripts', 'guard.js'));
const PORT = process.env.TB_PORT || '9120';
const NUM = process.env.TB_NUM || '1';
const UNIT = process.env.TB_UNIT || '卷';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = b.contexts()[0].pages().filter((p) => /publish\.htm/.test(p.url()) && !/fromAIImage/.test(p.url())).pop();
    if (!page) { say('没有发布页'); return; }

    // ① 数字框
    const s1 = await page.evaluate(async (num) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const sl = (ms) => new Promise((r) => setTimeout(r, ms));
      const cands = Array.from(document.querySelectorAll('div')).filter(vis)
        .filter((e) => /^\*?\s*计价单位/.test(clean(e.innerText)) && clean(e.innerText).length < 40);
      cands.sort((a, b) => a.innerText.length - b.innerText.length);
      let box = cands[0];
      if (!box) return { ok: false, why: 'no_box' };
      box.scrollIntoView({ block: 'center' });
      let inp = Array.from(box.querySelectorAll('input')).filter(vis)[0];
      if (!inp) { let p = box.parentElement; for (let k = 0; k < 3 && p && !inp; k++) { inp = Array.from(p.querySelectorAll('input')).filter(vis)[0]; if (!inp) p = p.parentElement; } }
      if (!inp) return { ok: false, why: 'no_num_input', 容器: clean(box.innerText).slice(0, 30) };
      inp.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, String(num));
      for (const ev of ['input', 'change', 'blur']) inp.dispatchEvent(new Event(ev, { bubbles: true }));
      await sl(700);
      return { ok: true, 数字读回: inp.value };
    }, NUM);
    say('① 数字:', s1);

    // ② 单位下拉（「请选单位」）
    const s2 = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const hits = Array.from(document.querySelectorAll('div,span,input')).filter(vis)
        .filter((e) => /请选单位/.test(clean(e.innerText) + (e.getAttribute && e.getAttribute('placeholder') || '')));
      const el = hits[hits.length - 1];
      if (!el) return { ok: false, why: 'no_unit_select', 全页有请选单位: false };
      const target = el.querySelector('input') || el;
      target.scrollIntoView({ block: 'center' });
      const r = target.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: target.tagName.toLowerCase() };
    });
    say('② 单位下拉:', s2);
    if (s2.ok) {
      await page.mouse.move(s2.x, s2.y);
      await sleep(250);
      await page.mouse.click(s2.x, s2.y);
      await sleep(2000);
      const s3 = await page.evaluate(async (unit) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const all = Array.from(document.querySelectorAll('li,[class*=option-item],[class*=menu-item],div')).filter(vis);
        const hit = all.filter((e) => clean(e.innerText) === unit && clean(e.innerText).length <= 3)[0];
        if (!hit) return { ok: false, why: 'no_option', 候选: Array.from(document.querySelectorAll('li,[class*=option-item]')).filter(vis).map((e) => clean(e.innerText)).slice(0, 14) };
        for (const ev of ['mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        await new Promise((r) => setTimeout(r, 900));
        return { ok: true, 选中: clean(hit.innerText) };
      }, UNIT);
      say('③ 选单位:', s3);
      await sleep(800);
      // 点空白触发 blur
      const blank = await page.evaluate(() => {
        for (const c of [{ x: 1250, y: 60 }, { x: 300, y: 62 }, { x: 1250, y: 950 }]) {
          const el = document.elementFromPoint(c.x, c.y);
          if (el && !el.closest('input,textarea,select,button,a')) return c;
        }
        return { x: 1250, y: 60 };
      });
      await page.mouse.click(blank.x, blank.y);
      await sleep(900);
    }

    const back = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const cands = Array.from(document.querySelectorAll('div')).filter((e) => /计价单位/.test(clean(e.innerText)) && clean(e.innerText).length < 40);
      return cands.length ? clean(cands[0].innerText).slice(0, 40) : null;
    });
    say('读回:', back);
  } finally { await b.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
