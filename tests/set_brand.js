#!/usr/bin/env node
/**
 * 在发布页把「品牌」从下拉里**真选**（默认 无品牌）。
 *
 * 为什么必须真选：实测往输入框写 `祺讯` 能进表单（URL 里 keyProps 有 text），
 * 但**自动保存的草稿里品牌会变成「无品牌/无注册商标」** —— 写 input.value 不算选了品牌。
 * 必须：点开下拉（合成 mousedown+mouseup+click）→ 在 `.options-content` 里滚着找 `.options-item` → 点中。
 *
 * 用法：node tests/set_brand.js [--port 9120] [--brand 无品牌]
 */
const path = require('path');
const http = require('http');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const BRAND = String(arg('brand', '无品牌'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

const OPEN_AND_PICK = `(async (want) => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const box = document.querySelector('#sell-field-p-20000');
  if (!box) return { ok: false, why: 'no_brand_field' };
  const inp = box.querySelector('input[placeholder="请输入"]');
  if (!inp) return { ok: false, why: 'no_input' };
  // ① 打开下拉（幂等：已是 true 就不再点，避免关掉）
  if (inp.getAttribute('aria-expanded') !== 'true') {
    inp.focus();
    for (const ev of ['mousedown', 'mouseup', 'click']) inp.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
    await new Promise((r) => setTimeout(r, 1500));
  }
  let cont = document.querySelector('.options-content');
  if (!cont) return { ok: false, why: 'no_options_content', expanded: inp.getAttribute('aria-expanded') };
  // ② 滚着找目标选项
  const find = () => Array.from(document.querySelectorAll('.options-item')).filter(vis).find((e) => clean(e.innerText) === want);
  let hit = find();
  for (let pass = 0; pass < 3 && !hit; pass++) {
    cont.scrollTop = 0; await new Promise((r) => setTimeout(r, 200)); hit = find();
    for (let y = 0; y <= cont.scrollHeight && !hit; y += 80) {
      cont.scrollTop = y; await new Promise((r) => setTimeout(r, 120)); hit = find();
    }
    if (!hit) { cont.scrollTop = cont.scrollHeight; await new Promise((r) => setTimeout(r, 250)); hit = find(); }
  }
  if (!hit) {
    const near = Array.from(document.querySelectorAll('.options-item')).filter(vis).map((e) => clean(e.innerText)).filter((t) => t.includes('品牌')).slice(0, 6);
    return { ok: false, why: 'option_not_found', want, 含品牌字样的候选: near };
  }
  // ③ 点中它（合成鼠标事件序列）
  for (const ev of ['mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
  await new Promise((r) => setTimeout(r, 1200));
  // ④ 读回
  const after = box.querySelector('input[placeholder="请输入"]');
  const chips = Array.from(box.querySelectorAll('[class*=selection-item],[class*=SelectionItem]')).map((e) => clean(e.innerText));
  return { ok: true, 点了: want, 输入框值: after ? after.value : null, chips, expanded: after ? after.getAttribute('aria-expanded') : null };
})`;

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    let i = 0;
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (!/publish\.htm/.test(page.url())) continue;
        i++; if (i > 1) continue;      // 只动第 1 个页面（72 行那个草稿）
        console.log('页面:', page.url().slice(0, 80));
        const r = await Promise.race([
          page.evaluate(`${OPEN_AND_PICK}(${JSON.stringify(BRAND)})`),
          new Promise((res) => setTimeout(() => res({ ok: false, why: 'timeout' }), 90000)),
        ]);
        console.log('结果:', JSON.stringify(r, null, 1));
        await sleep(1500);
        const check = await page.evaluate((want) => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const box = document.querySelector('#sell-field-p-20000');
          const inp = box && box.querySelector('input[placeholder="请输入"]');
          const chips = box ? Array.from(box.querySelectorAll('[class*=selection-item],[class*=SelectionItem]')).map((e) => clean(e.innerText)) : [];
          const txt = box ? clean(box.innerText).slice(0, 120) : null;
          return { 输入框值: inp ? inp.value : null, chips, 字段文本: txt, 命中期望: (inp && inp.value === want) || chips.includes(want) };
        }, BRAND);
        console.log('读回校验:', JSON.stringify(check, null, 1));
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
