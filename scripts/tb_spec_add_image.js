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
const { guardCheck } = require(path.join(__dirname, '..', 'scripts', 'guard.js'));
const PORT = process.env.TB_PORT || '9120';
const CONFIRM = process.argv.includes('--confirm');
// 规格图的"键"= product.json 的 colors（`<商品号>规格图-<颜色>.jpg`）→ 用它反推该勾哪个维度
const PRODUCT_PATH = (() => {
  const i = process.argv.indexOf('--product');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : 'output/MZB-001/product.json';
})();
let COLORS = [];
try { COLORS = (JSON.parse(require('fs').readFileSync(require('path').resolve(PRODUCT_PATH), 'utf8')).colors || []).map(String); } catch (e) { COLORS = []; }
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
  // ★ 勾选框必须勾到**「颜色分类」那一行**：这个类目有 4 个维度（图案/材质/面层工艺/颜色分类），
  //   取第一个「添加图片」会勾到「图案」（用户 2026-10-10 截图指出）
  const 添加图片框 = (() => {
    if (!paneEl) return null;
    const rows = Array.from(paneEl.querySelectorAll('div')).filter(vis)
      .filter((e) => /^颜色分类/.test(clean(e.innerText)) && clean(e.innerText).length < 40);
    rows.sort((a, b) => a.innerText.length - b.innerText.length);
    for (const row of rows) {
      let p = row;
      for (let k = 0; k < 4 && p; k++) {
        const cb = Array.from(p.querySelectorAll('.next-checkbox-wrapper,[class*=checkbox]')).filter(vis).find((e) => /添加图片/.test(clean(e.innerText)));
        if (cb) return cb;
        p = p.parentElement;
      }
    }
    return null;
  })();
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
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('找不到发布页'); return; }
    let st = await page.evaluate(state);
    log('起始:', { 抽屉在: st.抽屉在, 添加图片已勾: st.添加图片已勾, SKU表行数: st.SKU表行数, 规格区: st.规格区 });
    if (!st.抽屉在) { log('① 打开抽屉:', await clickText(page, '编辑规格')); await sleep(5000); }

    if (st.添加图片已勾 !== true) {
      // ★ 动态判断该勾**哪个维度**（不再写死「颜色分类」—— 用户指出换类目就失效）：
      //   规格图的键 = product.json 的 colors → 遍历抽屉里所有「名称 (N)」维度行，
      //   取"其值里包含颜色名最多"的那一行；匹配不到再回退「颜色分类」。
      const cbPos = await page.evaluate((colors) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const drawer = document.querySelector('.sku-decouple-drawer-container') || document;
        const heads = Array.from(drawer.querySelectorAll('div,span')).filter(vis)
          .filter((e) => /^[^()（）]{1,14}\s*[（(]\d+[)）]\s*$/.test(clean(e.innerText)));
        let best = null, bestScore = 0;
        for (const h of heads) {
          let scope = h.parentElement;
          for (let k = 0; k < 3 && scope; k++) { if (scope.querySelectorAll('input').length > 1) break; scope = scope.parentElement; }
          const txts = Array.from((scope || h).querySelectorAll('input')).map((i) => String(i.value || ''));
          if (!txts.length) continue;
          const score = colors.filter((c) => txts.some((tx) => tx.includes(c))).length;
          if (score > bestScore) { bestScore = score; best = { h, 名称: clean(h.innerText).slice(0, 20), 分数: score, 值数: txts.length }; }
        }
        let rowEl = best ? best.h : null;
        if (!rowEl) {
          const rows = Array.from(drawer.querySelectorAll('div')).filter(vis).filter((e) => /^颜色分类/.test(clean(e.innerText)) && clean(e.innerText).length < 40);
          rows.sort((a, b) => a.innerText.length - b.innerText.length);
          rowEl = rows[0] || null;
        }
        if (!rowEl) return { ok: false, why: 'no_row' };
        let p = rowEl;
        for (let k = 0; k < 4 && p; k++) {
          const cb = Array.from(p.querySelectorAll('.next-checkbox-wrapper,[class*=checkbox]')).filter(vis).find((e) => /添加图片/.test(clean(e.innerText)));
          if (cb) {
            const r = cb.getBoundingClientRect();
            return { ok: true, 维度: best ? best.名称 : '颜色分类(回退)', 命中颜色数: best ? best.分数 : null, 候选维度: heads.length, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
          p = p.parentElement;
        }
        return { ok: false, why: 'no_checkbox', 维度: best ? best.名称 : null };
      }, COLORS);
      if (cbPos && cbPos.ok) { await page.mouse.move(cbPos.x, cbPos.y); await sleep(250); await page.mouse.click(cbPos.x, cbPos.y); }
      log('② 勾「添加图片」→ 维度:', cbPos);
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
