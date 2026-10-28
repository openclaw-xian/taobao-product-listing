#!/usr/bin/env node
/**
 * 验证：详情面板里**不按回车**、只对搜索框派发 input 事件，会不会自己过滤出目标图？（怀疑回车触发了 iframe 重载）
 * 背景：`tb_upload_detail.js` 每张图都「输入文件名 + 回车」，实测第一个之后每张都抛 `Frame was detached`，
 *   怀疑回车让素材选择器 SPA 做了一次路由/重载。
 *
 * 用法：node tests/exp_detail_search_noenter.js [--name 详情图_02.jpg]
 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const NAME = String(arg('name', '详情图_02.jpg'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

const framesOf = (page) => page.frames().filter((f) => /sucai-selector-ng/.test(f.url()));

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().filter((x) => /publish\.htm/.test(x.url())).pop();
    say('iframe 数:', framesOf(page).length);
    for (const fr of framesOf(page)) {
      const alive = await fr.evaluate(() => 1).then(() => true).catch((e) => String(e.message).slice(0, 40));
      say('  frame', fr.name() || '(无名)', '存活:', alive);
    }
    const fr = framesOf(page).slice(-1)[0];
    if (!fr) { say('没有面板 frame'); process.exitCode = 1; return; }

    // 只派发 input，不按回车
    const set = await fr.evaluate((n) => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const i = Array.from(document.querySelectorAll('input')).filter(vis)
        .find((x) => /搜索图片名称|请输入文件名称|搜索/.test(x.getAttribute('placeholder') || ''));
      if (!i) return { ok: false };
      i.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(i, n);
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, 值: i.value };
    }, NAME).catch((e) => ({ ok: false, why: String(e.message).slice(0, 50) }));
    say('只派发 input:', set);

    for (const w of [2500, 3000, 4000]) {
      await sleep(w);
      const fr2 = framesOf(page).slice(-1)[0];
      const r = await fr2.evaluate((n) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const names = Array.from(new Set(Array.from(document.querySelectorAll('div,li')).filter(vis)
          .map((e) => (clean(e.innerText).match(/[\w\u4e00-\u9fa5.-]+\.(jpe?g|png|gif|webp)/gi) || []).join('|'))
          .filter((t) => t && !t.includes('|'))));
        const hit = names.filter((x) => x.includes(n));
        return { 可见文件名数: names.length, 命中: hit.slice(0, 6) };
      }, NAME).catch((e) => ({ err: String(e.message).slice(0, 60) }));
      say(`等 ${w}ms 后:`, r);
    }
  } finally { await browser.close().catch(() => {}); }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
