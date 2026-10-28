#!/usr/bin/env node
/**
 * 图片空间面板内部结构探针（只读）：列出 `mainImagesGroup` iframe 里**所有** img / button 的
 * 可见性与坐标，以及可滚容器。用来搞清「点哪张图」「确认按钮叫什么、在哪」。
 *
 * 若面板没开，会先点一次主图空槽打开它。
 *
 * 用法：node tests/probe_imgpanel.js
 * 日志：tests/_imgpanel.log
 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));

const PORT = process.env.TB_PORT || '9120';
const LOG = path.join(__dirname, '_imgpanel.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== probe_imgpanel ${new Date().toISOString()} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

const PANEL = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const rect = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const imgs = Array.from(document.querySelectorAll('img'));
  const btns = Array.from(document.querySelectorAll('button'));
  return {
    视口: { w: window.innerWidth, h: window.innerHeight, scrollY: Math.round(window.scrollY) },
    img总数: imgs.length,
    img可见数: imgs.filter(vis).length,
    img前12: imgs.slice(0, 12).map((e) => ({ alt: e.alt || null, vis: vis(e), rect: rect(e), src: String(e.src || '').slice(-30) })),
    img可见前8: imgs.filter(vis).slice(0, 8).map((e) => ({ alt: e.alt || null, rect: rect(e), src: String(e.src || '').slice(-30) })),
    button全部: btns.map((e) => ({ t: clean(e.innerText).slice(0, 16), vis: vis(e), disabled: !!e.disabled, rect: rect(e) })),
    可滚容器: Array.from(document.querySelectorAll('div')).filter((e) => e.scrollHeight > e.clientHeight + 20)
      .map((e) => ({ cls: String(e.className).slice(0, 44), sh: e.scrollHeight, ch: e.clientHeight, st: e.scrollTop })).slice(0, 8),
    勾选: Array.from(document.querySelectorAll('[class*=checked],[class*=Checked],[class*=selected]')).map((e) => clean(e.className).slice(0, 40)).slice(0, 6),
  };
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('找不到发布页'); process.exitCode = 1; return; }
    let fr = page.frames().find((f) => /sucai-selector-ng/.test(f.url()));
    if (!fr) {
      log('面板没开 → 点一次主图空槽');
      await page.locator('text=上传图片').first().click({ force: true, timeout: 8000 }).catch(() => {});
      await sleep(4500);
      fr = page.frames().find((f) => /sucai-selector-ng/.test(f.url()));
    }
    if (!fr) { log('★ 仍然没有 sucai-selector-ng iframe'); process.exitCode = 1; return; }
    log('iframe:', fr.name(), fr.url().slice(0, 90));
    log('\n--- 面板内部 ---');
    log(await fr.evaluate(PANEL));
    log('\n--- 主文档里可见的「确定/完成」按钮 ---');
    log(await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return Array.from(document.querySelectorAll('button')).filter(vis).map((b) => ({ t: clean(b.innerText).slice(0, 14), rect: (() => { const r = b.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })() })).filter((b) => /确定|完成|取消|保存/.test(b.t));
    }));
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_imgpanel.png') }).catch(() => {});
    log('\n截图: output/recon_imgpanel.png');
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
