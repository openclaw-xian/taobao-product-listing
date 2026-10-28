#!/usr/bin/env node
/**
 * 在「编辑规格」抽屉里**勾上「添加图片」**（给颜色分类开规格图），必要时点「确认创建」。
 *
 * 背景：单层规格下给"颜色"挂图的正解 —— playbook §7.5 写的就是这步（只是它写的是分层展示）。
 *   `scripts/tb_fill_sku_images.js` 的"批量填充SKU搜索主图"是另一条路；这条是**规格图**（颜色行挂图）。
 *
 * 用法：node tests/spec_add_image.js [--confirm]     # 默认只勾选；加 --confirm 才点「确认创建」
 * 日志：tests/_spec_add.log
 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const CONFIRM = process.argv.includes('--confirm');
const LOG = path.join(__dirname, '_spec_add.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== spec_add_image ${new Date().toISOString()} confirm=${CONFIRM} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

const clickText = async (page, text) => {
  const c = await page.evaluate((t) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const pool = Array.from(document.querySelectorAll('button,a,span,div,label,li')).filter(vis);
    const hit = pool.filter((e) => clean(e.innerText) === t);
    if (!hit.length) return null;
    const el = hit.filter((e) => !hit.some((o) => o !== e && e.contains(o)))[0];
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase() };
  }, text);
  if (!c) return { ok: false, why: 'no_match', text };
  await page.mouse.move(c.x, c.y);
  await sleep(250);
  await page.mouse.click(c.x, c.y);
  return { ok: true, ...c };
};

const state = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const panes = Array.from(document.querySelectorAll('.next-dialog,.next-drawer,[class*=drawer]')).filter(vis);
  const paneEl = panes.slice().sort((a, b) => clean(a.innerText).length - clean(b.innerText).length).find((e) => /添加图片|颜色分类/.test(clean(e.innerText))) || null;
  const 添加图片框 = paneEl ? Array.from(paneEl.querySelectorAll('.next-checkbox-wrapper,[class*=checkbox]')).find((e) => /添加图片/.test(clean(e.innerText))) : null;
  return {
    抽屉在: !!paneEl,
    抽屉文本: paneEl ? clean(paneEl.innerText).slice(0, 200) : null,
    添加图片已勾: 添加图片框 ? /checked/i.test(String(添加图片框.className)) : null,
    有警告弹窗: Array.from(document.querySelectorAll('.next-dialog')).filter(vis).map((e) => clean(e.innerText).slice(0, 90)).filter((t) => /清空|警告|确认|切换/.test(t)),
    SKU表行数: Array.from(document.querySelectorAll('tbody tr')).filter(vis).length,
    规格区: (clean(document.body.innerText).match(/SKU模式[^\n]{0,50}/) || [])[0] || null,
    图格数: document.querySelectorAll('.sell-sku-cell-image').length,
  };
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('找不到发布页'); return; }
    let st = await page.evaluate(state);
    log('起始:', { 抽屉在: st.抽屉在, 添加图片已勾: st.添加图片已勾, SKU表行数: st.SKU表行数, 规格区: st.规格区 });
    if (!st.抽屉在) { log('① 打开抽屉:', await clickText(page, '编辑规格')); await sleep(5000); }

    if (st.添加图片已勾 !== true) {
      log('② 勾「添加图片」:', await clickText(page, '添加图片'));
      await sleep(2500);
      st = await page.evaluate(state);
      log('   勾后:', { 添加图片已勾: st.添加图片已勾, 有警告弹窗: st.有警告弹窗 });
    } else {
      log('② 「添加图片」已是勾选状态');
    }

    if (CONFIRM) {
      log('③ 点「确认创建」:', await clickText(page, '确认创建'));
      await sleep(7000);
      log('   创建后:', await page.evaluate(state));
      await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_spec_confirm.png') }).catch(() => {});
    } else {
      log('③ （未加 --confirm，没点「确认创建」）');
      await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_spec_addimg.png') }).catch(() => {});
    }
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
