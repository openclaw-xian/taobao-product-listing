#!/usr/bin/env node
/**
 * 侦察（阶段 3）：**下载「批量导入」的官方模板**，并报告 Downloads 里新增的文件。
 *
 * 目的：AI识别导入 到底期望哪些列 —— 先拿官方模板，别按截图猜。
 * 用法：node tests/recon_batch.js [--port 9120] [--dl-dir C:\Users\<你>\Downloads]
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
const DL = String(arg('dl-dir', path.join(process.env.USERPROFILE || 'C:\\Users\\<你>', 'Downloads')));
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

function snapshot(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }));
}

(async () => {
  const before = snapshot(DL);
  console.log('下载目录:', DL, '| 现有文件', before.length, '个');

  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (!/publish\.htm/.test(page.url())) continue;

        // ① 打开「批量导入」弹窗
        const open = await page.evaluate(() => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const b = Array.from(document.querySelectorAll('button')).filter((e) => vis(e) && clean(e.innerText) === '批量导入')[0];
          if (!b) return { ok: false };
          for (const ev of ['mousedown', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
          return { ok: true };
        });
        console.log('① 打开批量导入:', JSON.stringify(open));
        await sleep(3000);

        // ② 弹窗里找「下载模板」（可能是 a 或 span 或 button）
        const dl = await page.evaluate(() => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const all = Array.from(document.querySelectorAll('a,span,button,div')).filter((e) => vis(e) && clean(e.innerText) === '下载模板');
          if (!all.length) return { ok: false, why: 'no_match' };
          // 取最内层
          const inner = all.filter((e) => !all.some((o) => o !== e && e.contains(o)));
          const el = inner[0];
          const r = el.getBoundingClientRect();
          for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
          return { ok: true, tag: el.tagName.toLowerCase(), cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60), href: el.getAttribute('href') || null, box: [Math.round(r.x), Math.round(r.y)] };
        });
        console.log('② 点「下载模板」:', JSON.stringify(dl));
        await sleep(6000);

        const after = snapshot(DL);
        const beforeNames = new Set(before.map((x) => x.f));
        const added = after.filter((x) => !beforeNames.has(x.f));
        console.log('③ Downloads 新增:', JSON.stringify(added.map((x) => x.f)));
        if (!added.length) {
          const newest = after.sort((a, b) => b.t - a.t).slice(0, 3);
          console.log('   （没有新文件；最近 3 个文件：', JSON.stringify(newest.map((x) => x.f)), '）');
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
