#!/usr/bin/env node
/**
 * 「以图发品」侦察：上传图片 → 等 AI 识别 → 读回它自动生成了什么（标题/属性/类目）。
 *
 * 用法：node tests/recon_yitu.js --files "a.jpg,b.jpg" [--port 9120] [--wait 25000]
 * 只上传 + 读回；**不点确认/下一步之前不点任何提交类按钮**（发布页没有提交，提交在表单里）。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const FILES = String(arg('files', '')).split(',').map((s) => s.trim()).filter(Boolean);
const WAIT = Number(arg('wait', 25000));
if (!FILES.length) { console.error('需要 --files'); process.exit(2); }
for (const f of FILES) if (!fs.existsSync(f)) { console.error('文件不存在:', f); process.exit(2); }
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

const STATE = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const inputs = Array.from(document.querySelectorAll('input')).filter(vis).map((e) => ({
    ph: e.getAttribute('placeholder'), val: String(e.value || '').slice(0, 40), name: e.getAttribute('name') || null,
  })).filter((x) => x.ph || x.val);
  const imgs = document.querySelectorAll('img').length;
  const btns = Array.from(document.querySelectorAll('button')).filter(vis).map((e) => clean(e.innerText).slice(0, 14)).filter(Boolean);
  const t = clean(document.body.innerText);
  return {
    url: location.href.slice(0, 120), title: document.title, imgs, btns: Array.from(new Set(btns)).slice(0, 20),
    inputs: inputs.slice(0, 20),
    识别相关: (t.match(/(识别|生成|智能)[^\\n]{0,60}/g) || []).slice(0, 8),
    标题候选: (t.match(/标题[^\\n]{0,60}/g) || []).slice(0, 4),
  };
})()`;

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    let i = 0;
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (!/category\.htm/.test(page.url())) continue;
        i++; if (i > 1) continue;
        console.log('页面:', page.url().slice(0, 80));
        const inputs = await page.$$('input[type=file]');
        console.log('file input 数:', inputs.length);
        if (!inputs.length) { console.log('没有 file input → 停'); continue; }
        await inputs[0].setInputFiles(FILES);
        console.log('已上传', FILES.length, '张:', FILES.map((f) => path.basename(f)).join(', '));
        for (const w of [8000, 12000, 15000]) {
          await sleep(Math.min(w, WAIT));
          console.log(`\n== 上传后 +${w}ms ==\n` + JSON.stringify(await page.evaluate(STATE), null, 1));
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
