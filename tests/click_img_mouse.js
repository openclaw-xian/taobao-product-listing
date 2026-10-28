#!/usr/bin/env node
/**
 * 用**真实鼠标坐标点击**图片空间里的图片（绕过 Playwright 元素点击的可见性/命中检查）。
 *
 * 做法：取 iframe 在主文档中的视口位置 + 目标缩略图在 iframe 内的位置 → 合成绝对坐标 →
 * `page.mouse.click(absX, absY)`（等价于真人用鼠标点那一点）。先单击；若面板没关再双击。
 *
 * 用法：node tests/click_img_mouse.js
 * 日志/截图：tests/_click_img.log、output/recon_click_img.png
 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));

const PORT = process.env.TB_PORT || '9120';
const LOG = path.join(__dirname, '_click_img.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== click_img_mouse ${new Date().toISOString()} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

// 空槽数：主文档里「上传图片」最内层元素（填上一张就该少一个）
const slots = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const raw = Array.from(document.querySelectorAll('div,span,li,p')).filter(vis).filter((e) => clean(e.innerText) === '上传图片');
  return { 空槽: raw.filter((e) => !raw.some((o) => o !== e && e.contains(o))).length };
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('找不到发布页'); process.exitCode = 1; return; }
    log('工作页:', page.url().slice(0, 90));

    let fr = page.frames().find((f) => /sucai-selector-ng/.test(f.url()));
    if (!fr) {
      log('面板没开 → 用真实鼠标点第一个空槽');
      const c = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const raw = Array.from(document.querySelectorAll('div,span,li,p')).filter(vis).filter((e) => clean(e.innerText) === '上传图片');
        const inner = raw.filter((e) => !raw.some((o) => o !== e && e.contains(o)));
        const el = inner[0];
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (!c) { log('找不到空槽'); process.exitCode = 1; return; }
      await page.mouse.click(c.x, c.y);
      await sleep(4500);
      fr = page.frames().find((f) => /sucai-selector-ng/.test(f.url()));
    }
    if (!fr) { log('★ 面板没出现'); process.exitCode = 1; return; }
    log('面板:', fr.name());
    log('点前槽状态:', await page.evaluate(slots));

    // 目标：iframe 内**大尺寸**的缩略图（120×120）第一张
    const geom = await page.evaluate(() => {
      const f = Array.from(document.querySelectorAll('iframe')).find((x) => /sucai-selector-ng/.test(x.src || ''));
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { left: r.left, top: r.top, w: Math.round(r.width), h: Math.round(r.height) };
    });
    const inner = await fr.evaluate(() => {
      const big = Array.from(document.querySelectorAll('img')).filter((e) => { const r = e.getBoundingClientRect(); return r.width >= 100 && r.height >= 100; });
      if (!big.length) return null;
      const r = big[0].getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: Math.round(r.width), src: String(big[0].src).slice(-30), 数量: big.length };
    });
    if (!inner || !geom) { log('★ 拿不到坐标', { geom, inner }); process.exitCode = 1; return; }
    const abs = { x: Math.round(geom.left + inner.cx), y: Math.round(geom.top + inner.cy) };
    log('iframe 位置:', geom, '| 缩略图:', inner, '| 绝对坐标:', abs);

    // ① 真实鼠标单击
    await page.mouse.move(abs.x, abs.y);
    await sleep(400);
    await page.mouse.click(abs.x, abs.y);
    await sleep(3500);
    const after1 = { 弹层仍在: page.frames().some((f) => /sucai-selector-ng/.test(f.url())), ...(await page.evaluate(slots)) };
    log('① 单击后:', after1);

    // ② 若没关 → 双击
    if (after1.弹层仍在 && after1.空槽 === 10) {
      await page.mouse.dblclick(abs.x, abs.y);
      await sleep(4000);
      const after2 = { 弹层仍在: page.frames().some((f) => /sucai-selector-ng/.test(f.url())), ...(await page.evaluate(slots)) };
      log('② 双击后:', after2);
    }

    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_click_img.png') }).catch(() => {});
    log('截图: output/recon_click_img.png');
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
