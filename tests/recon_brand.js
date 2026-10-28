#!/usr/bin/env node
/**
 * 侦察（阶段 2）：类目页 → **提交叶子 → 填品牌 → 看下拉选项**。
 * 只读 + 填品牌（我们本来就要填的值），**不点「确认，下一步」**（下一步单独一步做）。
 *
 * 用法：node tests/recon_brand.js [--port 9120] [--brand 祺讯]
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
const BRAND = String(arg('brand', '祺讯'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READ = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const btn = Array.from(document.querySelectorAll('button')).filter((e) => vis(e) && clean(e.innerText) === '确认，下一步')[0];
  const sel = Array.from(document.querySelectorAll('li.category-item.selected')).map((e) => clean(e.innerText).slice(0, 20));
  const brandInputs = Array.from(document.querySelectorAll('input')).filter(vis).filter((e) => e.getAttribute('placeholder') === '请输入')
    .map((e) => ({ val: e.value, cls: (typeof e.className === 'string' ? e.className : '').slice(0, 40) }));
  const opts = Array.from(document.querySelectorAll('[class*=option],[class*=Option],[role=option],li'))
    .filter((e) => vis(e) && clean(e.innerText).length > 0 && clean(e.innerText).length < 30)
    .map((e) => ({ t: clean(e.innerText), cls: (typeof e.className === 'string' ? e.className : '').slice(0, 50) }));
  const err = (clean(document.body.innerText).match(/请发布前修改[^\\n]{0,60}/) || [])[0] || null;
  return { confirmDisabled: btn ? btn.disabled : null, selected: sel, brandInputs, err,
           inputsAll: Array.from(document.querySelectorAll('input')).filter(vis).length,
           opts: opts.slice(0, 25) };
})()`;

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (!/category\.htm/.test(page.url())) continue;
        const dump = (tag, o) => console.log(`\n== ${tag} ==\n` + JSON.stringify(o, null, 1));

        dump('起点', await page.evaluate(READ));

        // ① 提交叶子：mousedown+mouseup+click（el.click() 无效）
        const leaf = await page.evaluate(() => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
          const lis = Array.from(document.querySelectorAll('li.category-item')).filter((e) => vis(e) && clean(e.innerText) === '猫抓板');
          if (!lis.length) return { ok: false, why: 'no_leaf' };
          for (const ev of ['mousedown', 'mouseup', 'click']) lis[0].dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
          return { ok: true, cls: lis[0].className };
        });
        console.log('\n① 提交叶子:', JSON.stringify(leaf));
        await sleep(2500);
        dump('① 后', await page.evaluate(READ));

        // ② 填品牌（原生 setter + input 事件）
        const typed = await page.evaluate((b) => {
          const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const el = Array.from(document.querySelectorAll('input')).filter(vis).filter((e) => e.getAttribute('placeholder') === '请输入')[0];
          if (!el) return { ok: false, why: 'no_brand_input' };
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, b);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, val: el.value };
        }, BRAND);
        console.log('\n② 填品牌:', JSON.stringify(typed));
        await sleep(3000);
        dump('② 后（看有没有下拉选项）', await page.evaluate(READ));
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
