#!/usr/bin/env node
/**
 * 列出某个属性的**完整可选值**（打开下拉 → 收集 .options-item；必要时用搜索框逐个探）。
 *
 * 用途：素材包里的属性值 ≠ 页面合法选项时，用它看「页面到底有哪些值」，
 * 再把差异原样报给用户（门禁 12：源值不在可选项里 → 原样列给用户，不要静默换近义值）。
 *
 * 用法：
 *   node tests/probe_options.js --pid 20021                 # 列出该属性下拉的默认候选
 *   node tests/probe_options.js --pid 20021 --try 剑麻,布    # 逐个丢进搜索框试（看哪些能搜到）
 * 日志：tests/_options.log
 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const PID = String(arg('pid', '20021'));
// 中文走环境变量（PS → node 的 CLI 中文会乱码）
const TRY = String(arg('try', process.env.TB_TRY || '')).split(',').map((s) => s.trim()).filter(Boolean);
const LOG = path.join(__dirname, '_options.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== probe_options pid=${PID} try=${TRY.join('|')} ${new Date().toISOString()} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('找不到可用发布页'); process.exitCode = 1; return; }
    log('页面:', page.url().slice(0, 90));

    const r = await page.evaluate(async ({ pid, tries }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const sl = (ms) => new Promise((r) => setTimeout(r, ms));
      const box = document.querySelector('#sell-field-p-' + pid);
      if (!box) return { ok: false, why: 'no_box' };
      const inp = Array.from(box.querySelectorAll('input')).filter(vis)[0];
      if (!inp) return { ok: false, why: 'no_input' };
      const out = { ok: true, 当前值: inp.value || (Array.from(box.querySelectorAll('[class*=next-tag]')).map((e) => clean(e.innerText)).filter(Boolean).join('/') || null) };

      const open = async () => {
        if (inp.getAttribute('aria-expanded') === 'true') return;
        inp.focus();
        for (const ev of ['mousedown', 'mouseup', 'click']) inp.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        await sl(2200);
      };
      const scopeOf = () => document.querySelector('.sell-o-select-options') || (document.querySelector('.options-content') || {}).closest?.('div') || document;
      const items = (sc) => Array.from((sc || scopeOf()).querySelectorAll('.options-item')).filter(vis).map((e) => clean(e.innerText)).filter(Boolean);
      const searchOf = (sc) => Array.from((sc || scopeOf()).querySelectorAll('input')).filter(vis).find((i) => i !== inp && !box.contains(i));
      const popText = (sc) => clean((sc || scopeOf()).innerText || '').slice(0, 200);

      await open();
      let sc = scopeOf();
      out.弹层存在 = !!document.querySelector('.sell-o-select-options');
      out.默认候选 = items(sc);
      out.默认弹层文本 = popText(sc);
      out.有搜索框 = !!searchOf(sc);

      const searches = {};
      for (const t of tries) {
        const s = searchOf(scopeOf());
        if (!s) { searches[t] = '（没有搜索框）'; continue; }
        s.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(s, t);
        s.dispatchEvent(new Event('input', { bubbles: true }));
        await sl(2200);
        const sc2 = scopeOf();
        searches[t] = { 命中: items(sc2), 弹层文本: popText(sc2) };
      }
      out.搜索试探 = searches;
      return out;
    }, { pid: PID, tries: TRY });

    log(JSON.stringify(r, null, 1));
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
