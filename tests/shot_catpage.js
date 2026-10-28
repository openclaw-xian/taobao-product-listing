#!/usr/bin/env node
/** 拍类目页截图 + dump 右侧属性区（看「确认，下一步」为什么还是灰的）。 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const b = await chromium.connectOverCDP('http://127.0.0.1:9120');
  try {
    const p = b.contexts()[0].pages().find((x) => /sell\/ai\/category\.htm/.test(x.url()));
    if (!p) { console.log('没有类目页'); return; }
    await p.bringToFront().catch(() => {});
    await sleep(1500);
    const info = await p.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const inputs = Array.from(document.querySelectorAll('input')).filter(vis)
        .map((i) => ({ ph: i.getAttribute('placeholder') || '', val: String(i.value || '').slice(0, 20), y: Math.round(i.getBoundingClientRect().top) }));
      const labels = Array.from(document.querySelectorAll('div,span')).filter(vis)
        .map((e) => clean(e.innerText)).filter((t) => t && t.length < 26 && /\*|必填|货号|品牌|材质|规格|尺寸|颜色|图案/.test(t)).slice(0, 24);
      const btn = Array.from(document.querySelectorAll('button')).filter(vis).map((x) => ({ t: clean(x.innerText).slice(0, 14), dis: !!x.disabled })).filter((x) => /下一步|确认/.test(x.t));
      return { 可见输入框: inputs.slice(0, 12), 标签类文本: Array.from(new Set(labels)), 下一步按钮: btn, 底部: clean(document.body.innerText).slice(-260) };
    });
    console.log(JSON.stringify(info, null, 1));
    await p.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_catpage_pe.png') });
    console.log('截图: output/recon_catpage_pe.png');
  } finally { await b.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
