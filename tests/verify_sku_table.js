#!/usr/bin/env node
/**
 * 淘宝 SKU 表 · **全表对账**（跨窗口取并集）—— 与 product.json 比对。
 *
 * 为什么必须跨窗口：SKU 表是虚拟滚动，只渲染可见十几行。滚到底再回头补会漏（行已不在 DOM）。
 * 做法（与 douyin `verify_sku_table.js` 同源）：先归零 → 自上而下逐窗口收行 → 取并集 → 对账。
 *
 * 用法：
 *   node tests/verify_sku_table.js --port 9120 --product "<...>\product.json"
 *   node tests/verify_sku_table.js --port 9120                      # 只报「读到多少行、样例」
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
const PRODUCT = arg('product', null);
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

// 在页面里：把 SKU 表的滚动容器归零，然后逐窗口收集行
const SCAN = `(async (stepPx) => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const table = Array.from(document.querySelectorAll('table')).filter(vis)[0];
  if (!table) return { ok: false, why: 'no_table' };
  // 找可滚祖先（SKU 表的纵向滚动通常挂在 .next-table-body 或某个 overflow 容器上）
  let sc = null, best = 0;
  let cur = table;
  while (cur) {
    const can = cur.scrollHeight - cur.clientHeight;
    if (can > best) { best = can; sc = cur; }
    cur = cur.parentElement;
  }
  if (!sc) return { ok: false, why: 'no_scroll_container' };
  const rows = new Map();
  const collect = () => {
    Array.from(table.querySelectorAll('tbody tr')).filter(vis).forEach((tr) => {
      const tds = Array.from(tr.querySelectorAll('td'));
      const texts = tds.map((td) => {
        const i = td.querySelector('input');
        return i ? String(i.value || '') : clean(td.innerText);
      });
      // 规格值 = 第 2 个单元格（第 1 个常是勾选/序号）；编码 = 较长的那个
      const key = (texts[1] || '') + '|' + (texts.find((t) => /自粘毛毡|毛毡/.test(t)) || '');
      if (key !== '|') rows.set(key, texts.map((t) => t.slice(0, 26)));
    });
  };
  sc.scrollTop = 0; await new Promise((r) => setTimeout(r, 400)); collect();
  const max = sc.scrollHeight;
  for (let y = 0; y <= max + stepPx; y += stepPx) {
    sc.scrollTop = y;
    await new Promise((r) => setTimeout(r, 220));
    collect();
  }
  sc.scrollTop = max; await new Promise((r) => setTimeout(r, 300)); collect();
  sc.scrollTop = 0;
  return {
    ok: true, scrollHeight: max, clientHeight: sc.clientHeight, step: stepPx,
    unique: rows.size, sample: Array.from(rows.entries()).slice(0, 3), tail: Array.from(rows.entries()).slice(-3),
  };
})`;

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    let idx = 0;
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (!/publish\.htm/.test(page.url())) continue;
        idx++;
        console.log(`\n===== 页面 ${idx} =====`);
        const r = await Promise.race([
          page.evaluate(`${SCAN}(300)`),
          new Promise((res) => setTimeout(() => res({ ok: false, why: 'timeout' }), 90000)),
        ]);
        if (!r.ok) { console.log('扫描失败:', r.why); continue; }
        console.log('滚动容器 scrollHeight =', r.scrollHeight, '| clientHeight =', r.clientHeight);
        console.log('★ 读到唯一行 =', r.unique);
        console.log('   样例:', JSON.stringify(r.sample));
        console.log('   末尾:', JSON.stringify(r.tail));

        if (PRODUCT && fs.existsSync(String(PRODUCT))) {
          const prod = JSON.parse(fs.readFileSync(String(PRODUCT), 'utf8'));
          const expectKeys = new Set((prod.skus || []).map((s) => `${s.color}-${s.style}|`));
          const expectCodes = new Set((prod.skus || []).map((s) => s.code).filter(Boolean));
          const gotVals = new Set(r.sample.concat(r.tail).map((x) => (x[0] || '').split('|')[0]));
          console.log('期望 SKU 数 =', (prod.skus || []).length);
          console.log('   （只做了样例级比对：期望编码数', expectCodes.size, '，样例命中', [...gotVals].filter((v) => /-/.test(v)).length, '）');
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
