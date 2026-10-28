#!/usr/bin/env node
/**
 * 侦察（阶段 4c）：**接受 AI 识别出来的维度 → 读回规格区与 SKU 表**。
 *
 * ⚠️ 这一步会**往草稿里写一个规格维度**（淘宝表单自动存草稿）。只在「测试草稿」上做。
 * 用法：node tests/recon_ai_accept.js [--port 9120]
 */
const path = require('path');
const http = require('http');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));

const i = process.argv.indexOf('--port');
const PORT = String(i === -1 ? (process.env.TB_PORT || '9120') : process.argv[i + 1]);
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

async function clickText(page, text) {
  return page.evaluate((t) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const all = Array.from(document.querySelectorAll('button,a,span,div')).filter((e) => vis(e) && clean(e.innerText) === t);
    if (!all.length) return { ok: false, why: 'no_match' };
    const inner = all.filter((e) => !all.some((o) => o !== e && e.contains(o)));
    const el = inner[0];
    for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
    return { ok: true, tag: el.tagName.toLowerCase() };
  }, text);
}

const FORM = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
  // 规格区：找带「规格名」的输入框 / 规格值 chip
  const specInputs = Array.from(document.querySelectorAll('input[placeholder*="规格"], input[placeholder*="请输入规格"]'))
    .filter(vis).map((e) => ({ ph: e.getAttribute('placeholder'), val: String(e.value).slice(0, 20) }));
  const tables = Array.from(document.querySelectorAll('table')).filter(vis).map((t) => ({
    head: Array.from(t.querySelectorAll('th')).map((th) => clean(th.innerText).slice(0, 12)).filter(Boolean).slice(0, 12),
    rows: t.querySelectorAll('tbody tr').length,
    first: (t.querySelector('tbody tr') ? clean(t.querySelector('tbody tr').innerText).slice(0, 80) : null),
  }));
  const skuInputs = Array.from(document.querySelectorAll('input')).filter(vis)
    .filter((e) => /价格|库存|编码|请输入/.test(e.getAttribute('placeholder') || '')).slice(0, 12)
    .map((e) => ({ ph: e.getAttribute('placeholder'), val: String(e.value).slice(0, 16) }));
  return {
    dialogOpen: !!dlg, dialogText: dlg ? clean(dlg.innerText).slice(0, 220) : null,
    specInputs, tables, skuInputs,
    bodyHit: (clean(document.body.innerText).match(/(销售规格|规格名|颜色分类|款式|尺寸)[^\\n]{0,50}/g) || []).slice(0, 8),
  };
})()`;

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (!/publish\.htm/.test(page.url())) continue;
        console.log('页面:', page.url().slice(0, 90));
        console.log('① 点「在当前规格后添加」:', JSON.stringify(await clickText(page, '在当前规格后添加')));
        for (const w of [4000, 6000, 8000]) {
          await sleep(w);
          const s = await page.evaluate(FORM);
          console.log(`\n== 之后 ${w}ms ==\n` + JSON.stringify(s, null, 1));
          if (s.tables && s.tables.length && s.tables[0].rows > 0) break;
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
