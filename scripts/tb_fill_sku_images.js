#!/usr/bin/env node
/**
 * **批量填充 SKU 搜索主图**（= 单层规格下给"颜色"挂图的唯一入口；门禁 10）。
 *
 * 链路（2026-10-10 实测）：
 *   ① 点 SKU 表第一列图格里那个 **36px 虚线方框**（`.main-content.dashed`；点 td 中心无效）
 *      → 打开「批量填充SKU搜索主图」：右侧 72 个 `li.sku-item`、左侧素材选择 iframe、底部确定/取消
 *   ② 左侧「本地上传」把 6 张颜色图传进图片空间（已在空间则跳过）
 *   ③ 逐个颜色：右侧选中该颜色的 12 个 SKU（`li.sku-item` 文本以「<颜色>-」开头）→
 *      左侧点「猫抓布规格图-<颜色>.jpg」→ 批量填充（计数 N/72 增长）
 *   ④ 点「确定」
 *
 * 用法：
 *   node scripts/tb_fill_sku_images.js --dir output/MZB-001/img/spec --color 米白    # 单色试
 *   node scripts/tb_fill_sku_images.js --dir output/MZB-001/img/spec                  # 全部 6 色
 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, 'pwresolver.js'));
const { guardCheck } = require(path.join(__dirname, 'guard.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const DIR = path.resolve(String(arg('dir', 'output/MZB-001/img/spec')));
const ONLY = arg('color', process.env.TB_COLOR || null);   // 中文走环境变量（PS→node 的 CLI 中文会乱码）
const DO_UPLOAD = !arg('no-upload', false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

const COLORS = ['米白', '卡其', '黑色', '浅灰', '深蓝', '深棕'];
const picked = ONLY ? [String(ONLY)] : COLORS;
const filesOf = (c) => fs.readdirSync(DIR).filter((f) => f.includes(c) && /\.(jpe?g|png)$/i.test(f));
const specFiles = fs.readdirSync(DIR).filter((f) => /猫抓布规格图-.*\.(jpe?g|png)$/i.test(f)).sort();
say('目录:', DIR, '| 颜色图:', specFiles.join(', '));

const dialogState = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
  if (!dlg) return { 有弹窗: false };
  const t = clean(dlg.innerText);
  return {
    有弹窗: true,
    标题: (t.match(/批量填充SKU搜索主图/) || [])[0] || t.slice(0, 30),
    计数: (t.match(/(\d+)\s*\/\s*(\d+)/) || []).slice(1).join('/') || null,
    SKU项数: dlg.querySelectorAll('li.sku-item').length,
    已选SKU: Array.from(dlg.querySelectorAll('li.sku-item')).filter((e) => /selected|checked|active/i.test(String(e.className))).length,
    按钮: Array.from(dlg.querySelectorAll('button')).filter(vis).map((b) => clean(b.innerText)).filter(Boolean).slice(0, 6),
  };
};

// 点开面板：第一个空图格的虚线方框
async function openPanel(page) {
  const c = await page.evaluate(() => {
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    if (Array.from(document.querySelectorAll('.next-dialog')).filter(vis).length) return { already: true };
    const cells = Array.from(document.querySelectorAll('.sell-sku-cell-image')).filter(vis);
    if (!cells.length) return null;
    const td = cells.find((x) => !x.querySelector('img')) || cells[0];
    td.scrollIntoView({ block: 'center' });
    const box = td.querySelector('.main-content') || td.querySelector('.sell-component-image-v2') || td;
    const r = box.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  if (!c) return { ok: false, why: 'no_cell' };
  if (c.already) return { ok: true, already: true };
  await page.mouse.move(c.x, c.y);
  await sleep(250);
  await page.mouse.click(c.x, c.y);
  await sleep(5000);
  const st = await page.evaluate(dialogState);
  return { ok: !!st.有弹窗, 点: c, 弹窗: st };
}

// 素材 iframe（弹窗里的那个 900 宽 iframe）
const materialFrame = (page) => page.frames().filter((f) => /sucai-selector-ng|handleId=/.test(f.url())).pop();

async function uploadSpecs(page) {
  let fr = materialFrame(page);
  if (!fr) return { ok: false, why: 'no_material_frame' };
  // 已在空间？（按文件名找一张）
  const has = await fr.evaluate((n) => (document.body.innerText || '').includes(n), path.basename(specFiles[0], '.jpg'));
  if (has) return { ok: true, skipped: '空间里已有' };
  if (!DO_UPLOAD) return { ok: false, why: 'no-upload 且空间里没有' };
  const p1 = page.waitForEvent('filechooser', { timeout: 12000 }).catch(() => null);
  await fr.locator('button:has-text("本地上传")').first().click({ force: true, timeout: 8000 }).catch(() => {});
  const ch = await p1;
  const paths = specFiles.map((f) => path.join(DIR, f));
  if (ch) await ch.setFiles(paths);
  else {
    await sleep(2000);
    const n = await fr.locator('input[type=file]').count().catch(() => 0);
    if (!n) return { ok: false, why: '上传入口不可用' };
    await fr.locator('input[type=file]').first().setInputFiles(paths);
  }
  await sleep(10000);
  // 关「上传结果」
  const done = await fr.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /^完成$/.test(clean(x.innerText)));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }).catch(() => null);
  if (done) {
    const g = await page.evaluate(() => { const f = Array.from(document.querySelectorAll('iframe')).filter((x) => /handleId=|sucai-selector-ng/.test(x.src || '')).pop(); if (!f) return null; const r = f.getBoundingClientRect(); return { left: r.left, top: r.top }; });
    if (g) { await page.mouse.click(Math.round(g.left + done.x), Math.round(g.top + done.y)); await sleep(3000); }
  }
  return { ok: true, 上传: specFiles.length };
}

// 左侧点某张颜色图（iframe 内 → 真实鼠标坐标）
async function clickSpecImage(page, fr, fname) {
  const g = await page.evaluate(() => {
    const f = Array.from(document.querySelectorAll('iframe')).filter((x) => /handleId=|sucai-selector-ng/.test(x.src || '')).pop();
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  const pos = await fr.evaluate((n) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const imgs = Array.from(document.querySelectorAll('img')).filter(vis).filter((e) => { const r = e.getBoundingClientRect(); return r.width >= 50 && r.height >= 50; });
    for (const img of imgs) {
      let p = img;
      for (let k = 0; k < 6 && p; k++) {
        p = p.parentElement;
        if (!p) break;
        if (clean(p.innerText).includes(n)) {
          const r = img.getBoundingClientRect();
          return { ok: true, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
        }
      }
    }
    return { ok: false };
  }, fname);
  if (!pos.ok || !g) return { ok: false, why: 'no_img' };
  await page.mouse.move(Math.round(g.left + pos.cx), Math.round(g.top + pos.cy));
  await sleep(250);
  await page.mouse.click(Math.round(g.left + pos.cx), Math.round(g.top + pos.cy));
  await sleep(2000);
  return { ok: true };
}

// 右侧选中某颜色的 SKU：**返回坐标 → 真实鼠标逐个点**（实测 `e.click()` 合成点击不生效）
async function selectSkus(page, color) {
  const pos = await page.evaluate((c) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
    if (!dlg) return { ok: false, why: 'no_dialog' };
    const items = Array.from(dlg.querySelectorAll('li.sku-item')).filter(vis);
    const mine = items.filter((e) => clean(e.innerText).startsWith(c + '-'));
    return {
      ok: true,
      本颜色: mine.length,
      坐标: mine.map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }),
      在视口内: mine.filter((e) => { const r = e.getBoundingClientRect(); return r.top > 0 && r.bottom < window.innerHeight; }).length,
    };
  }, color);
  if (!pos.ok) return pos;
  for (const p of pos.坐标) {
    await page.mouse.move(p.x, p.y);
    await sleep(120);
    await page.mouse.click(p.x, p.y);
    await sleep(220);
  }
  const st = await page.evaluate(dialogState);
  return { ok: true, 本颜色: pos.本颜色, 点击数: pos.坐标.length, 已选SKU: st.已选SKU, 计数: st.计数 };
}

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { say('★ 找不到发布页'); process.exitCode = 1; return; }
    say('工作页:', page.url().slice(0, 90));

    const op = await openPanel(page);
    say('① 打开「批量填充SKU搜索主图」:', op);
    if (!op.ok) { process.exitCode = 1; return; }
    await sleep(2000);
    say('   弹窗状态:', await page.evaluate(dialogState));

    if (DO_UPLOAD) {
      const up = await uploadSpecs(page);
      say('② 上传颜色图:', up);
      await sleep(2000);
      say('   弹窗状态:', await page.evaluate(dialogState));
    }

    for (const color of picked) {
      const f = filesOf(color)[0];
      if (!f) { say(`   ✗ 没有「${color}」的图`); continue; }
      const sel = await selectSkus(page, color);
      say(`③ [${color}] 选中 SKU:`, sel);
      await sleep(1500);
      const clk = await clickSpecImage(page, materialFrame(page), path.basename(f, '.jpg'));
      await sleep(2500);
      const st = await page.evaluate(dialogState);
      say(`   点图 ${f}:`, clk, '| 计数:', st.计数, '| 已选 SKU:', st.已选SKU);
    }

    const beforeOk = await page.evaluate(dialogState);
    say('④ 填充后:', beforeOk);
    if (ONLY) { say('（--color 单色试跑，未点确定；去掉 --color 跑全量）'); return; }
    const okBtn = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
      if (!dlg) return null;
      const b = Array.from(dlg.querySelectorAll('button')).filter(vis).find((x) => /^确定/.test(clean(x.innerText)));
      if (!b || b.disabled) return { ok: false };
      const r = b.getBoundingClientRect();
      return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, 文本: clean(b.innerText) };
    });
    say('⑤ 确定按钮:', okBtn);
    if (okBtn && okBtn.ok) { await page.mouse.click(Math.round(okBtn.x), Math.round(okBtn.y)); await sleep(6000); }
    const filled = await page.evaluate(() => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return {
        有图格: Array.from(document.querySelectorAll('.sell-sku-cell-image')).filter((e) => vis(e) && e.querySelector('img')).length,
        总格: Array.from(document.querySelectorAll('.sell-sku-cell-image')).filter(vis).length,
      };
    });
    say('⑥ 表里已有图的格子:', filled);
    console.log('\n' + JSON.stringify({ ok: true, filled }, null, 1));
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
