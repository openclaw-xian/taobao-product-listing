#!/usr/bin/env node
/**
 * 在**已开着的调试端口 Chrome** 里打开一个 URL（新标签页），可选等待与截图。
 *
 * 为什么需要它：这个技能靠 CDP 连用户的浏览器，但「开一个页面」这件事没法用只读探针做
 * （probe_dom.js 只读现有页）。发布页入口/表单都需要先导航过去。
 *
 * 用法：
 *   node scripts/open_page.js --url "https://item.upload.taobao.com/sell/ai/category.htm"
 *   node scripts/open_page.js --url "..." --wait 8000 --shot "D:\tmp\cat.png"
 *   node scripts/open_page.js --list                     # 只列当前页面，不开新的
 *
 * 注意：只负责「打开 + 等一会儿 + 读回标题」，**不点任何东西**（点击属于 tb_flow.js）。
 */
const path = require('path');
const http = require('http');
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
const URL_ = arg('url', null);
const WAIT = Number(arg('wait', 6000));
const SHOT = arg('shot', null);
const LIST = arg('list', false);

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  if (!URL_ || LIST) {
    const list = await getJSON('/json/list').catch((e) => { console.error('端口不可达:', e.message); process.exit(2); });
    list.filter((t) => t.type === 'page').forEach((t, i) => console.log(`  [${i}] ${(t.title || '').slice(0, 40)} | ${(t.url || '').slice(0, 100)}`));
    if (!URL_) return;
  }

  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const ctx = browser.contexts()[0];
    if (!ctx) { console.error('没有可用 context'); process.exit(2); }
    // 已经开着这个 URL 就复用它，别重复开（避免标签页越攒越多）
    const norm = (u) => String(u || '').replace(/\/$/, '').split('?')[0];
    let page = ctx.pages().find((p) => norm(p.url()) === norm(URL_));
    if (page) {
      console.log('复用已打开的页:', page.url().slice(0, 100));
    } else {
      page = await ctx.newPage();
      await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log('已打开:', URL_);
    }
    await page.bringToFront();
    await new Promise((r) => setTimeout(r, WAIT));
    const info = await Promise.race([
      page.evaluate(() => ({
        url: location.href,
        title: document.title,
        h1: Array.from(document.querySelectorAll('h1,h2,[class*=title]')).slice(0, 6).map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50)).filter(Boolean),
        bodyLines: document.body.innerText.split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 25),
      })),
      new Promise((r) => setTimeout(() => r({ timeout: true }), 15000)),
    ]);
    console.log(JSON.stringify(info, null, 1));
    if (SHOT) { await page.screenshot({ path: SHOT, fullPage: false }); console.log('截图:', SHOT); }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
