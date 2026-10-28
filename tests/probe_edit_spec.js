#!/usr/bin/env node
/** 探针：点 SKU 表下方的「编辑规格」→ 看里面有没有给颜色挂图的入口（用户提示"应该差不多"）。 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const LOG = path.join(__dirname, '_edit_spec.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== probe_edit_spec ${new Date().toISOString()} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

const press = async (page, text, exact = true) => {
  const c = await page.evaluate(({ t, ex }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const pool = Array.from(document.querySelectorAll('button,a,span,div,li')).filter(vis);
    const hit = pool.filter((e) => (ex ? clean(e.innerText) === t : clean(e.innerText).includes(t)));
    if (!hit.length) return null;
    const el = hit.filter((e) => !hit.some((o) => o !== e && e.contains(o)))[0];
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase() };
  }, { t: text, ex: exact });
  if (!c) return { ok: false, why: 'no_match', text };
  await page.mouse.move(c.x, c.y);
  await sleep(250);
  await page.mouse.click(c.x, c.y);
  return { ok: true, ...c };
};

const dump = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const panes = Array.from(document.querySelectorAll('.next-dialog,.next-drawer,[class*=drawer],[class*=Drawer]')).filter(vis);
  const paneEl = panes.slice().sort((a, b) => clean(a.innerText).length - clean(b.innerText).length).find((e) => clean(e.innerText).length > 10) || null;
  return {
    面板数: panes.length,
    面板: paneEl ? clean(paneEl.innerText).slice(0, 420) : null,
    面板class: paneEl ? String(paneEl.className).slice(0, 44) : null,
    面板按钮: paneEl ? Array.from(paneEl.querySelectorAll('button')).filter(vis).map((b) => clean(b.innerText)).filter(Boolean).slice(0, 12) : [],
    判据: {
      虚线图框数: paneEl ? Array.from(paneEl.querySelectorAll('.main-content.dashed,[class*=dashed]')).length : 0,
      勾选框: paneEl ? Array.from(paneEl.querySelectorAll('.next-checkbox-wrapper,[class*=checkbox]')).filter(vis).map((e) => clean(e.innerText).slice(0, 16)).filter(Boolean).slice(0, 10) : [],
      规格值样本: paneEl ? Array.from(paneEl.querySelectorAll('input')).map((i) => String(i.value || '')).filter(Boolean).slice(0, 8) : [],
    },
    页面尾部: clean(document.body.innerText).slice(-200),
  };
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('找不到发布页'); return; }
    // ① 先关掉「批量填充SKU搜索主图」弹窗
    const cancel = await press(page, '取消');
    log('① 点「取消」关弹窗:', cancel);
    await sleep(2500);
    log('   弹窗是否还在:', await page.evaluate(() => Array.from(document.querySelectorAll('.next-dialog')).filter((e) => e.getBoundingClientRect().width > 0).length));
    // ② 点「编辑规格」（若抽屉已开就跳过，别再点一次关掉它）
    const before = await page.evaluate(dump);
    log('点前抽屉:', { 面板数: before.面板数, 面板: before.面板 ? before.面板.slice(0, 80) : null });
    if (before.面板数 === 0) {
      const edit = await press(page, '编辑规格');
      log('② 点「编辑规格」:', edit);
      await sleep(5000);
    } else {
      log('② 抽屉已开 → 跳过点击');
    }
    log('③ 抽屉内容:', await page.evaluate(dump));
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_edit_spec.png') }).catch(() => {});
    log('截图: output/recon_edit_spec.png');
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
