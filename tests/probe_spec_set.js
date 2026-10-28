#!/usr/bin/env node
/** 探针：规格区「设置」抽屉 —— 看单层规格（SKU模式）能不能给颜色分类挂图（playbook §7.5）。 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const LOG = path.join(__dirname, '_spec_set.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== probe_spec_set ${new Date().toISOString()} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

const dump = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // 抽屉/弹窗
  const panes = Array.from(document.querySelectorAll('.next-drawer,.next-dialog,[class*=drawer],[class*=Drawer],[class*=panel]')).filter(vis);
  const pane = panes.map((e) => ({ txt: clean(e.innerText), cls: String(e.className).slice(0, 50) }))
    .filter((x) => x.txt.length > 12).sort((a, b) => a.txt.length - b.txt.length)[0] || null;
  const props = Array.from(document.querySelectorAll('[id^="sell-field-p-"]')).map((b) => b.id);
  return {
    抽屉: pane ? pane.txt.slice(0, 300) : null,
    抽屉class: pane ? pane.cls : null,
    抽屉里的勾选框: Array.from(document.querySelectorAll('.next-checkbox-wrapper,[class*=checkbox]')).filter(vis).map((e) => clean(e.innerText).slice(0, 20)).filter(Boolean).slice(0, 12),
    抽屉里的按钮: Array.from(document.querySelectorAll('button')).filter(vis).map((b) => clean(b.innerText)).filter(Boolean).slice(0, 10),
    图格数: document.querySelectorAll('[class*=sku-cell-image]').length,
    规格区: (clean(document.body.innerText).match(/SKU模式[^\n]{0,90}/) || [])[0] || null,
  };
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('找不到发布页'); return; }
    log('点前:', await page.evaluate(dump));

    // 点规格区的「设置」（真实鼠标）
    const btn = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const cands = Array.from(document.querySelectorAll('button,a,span,div')).filter(vis).filter((e) => clean(e.innerText) === '设置');
      const el = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)))[0];
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase() };
    });
    log('「设置」按钮:', btn);
    if (btn) {
      await page.mouse.move(btn.x, btn.y);
      await sleep(250);
      await page.mouse.click(btn.x, btn.y);
      await sleep(4000);
      log('点后:', await page.evaluate(dump));
      await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_spec_set.png') }).catch(() => {});
      log('截图: output/recon_spec_set.png');
    }
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
