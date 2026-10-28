#!/usr/bin/env node
/**
 * 实验：**详情图面板里，缩略图能不能点选**（真实鼠标坐标）。
 * 背景：`tb_upload_detail.js` 依赖「上传后面板自动全选」，但这次没全选（底部「确定」disabled、
 *   已选 0）。要先确认：点一下缩略图会不会把「确定（N）」的 N 加 1 —— 会的话就有确定的兜底选法。
 *
 * 用搜索框把目标图定位到第一行（不然列表几千张、图在很下面），再用真实鼠标点。
 *
 * 用法：node tests/exp_detail_select.js [--name 详情图_01.jpg] [--port 9120]
 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const NAME = String(arg('name', '详情图_01.jpg'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().filter((x) => /publish\.htm/.test(x.url())).pop();
    const fr = page.frames().filter((f) => /sucai-selector-ng/.test(f.url()))[0];
    if (!fr) { say('没有 sucai-selector-ng 面板'); process.exitCode = 1; return; }
    const geom = await page.evaluate(() => {
      const f = Array.from(document.querySelectorAll('iframe')).filter((x) => /sucai-selector-ng/.test(x.src || '')).pop();
      const r = f.getBoundingClientRect();
      return { left: r.left, top: r.top };
    });
    const footer = () => fr.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /^确定/.test(clean(x.innerText)));
      return b ? { 文本: clean(b.innerText), disabled: !!b.disabled } : null;
    });
    say('起始底部:', await footer());

    // 搜索框定位
    const searched = await fr.evaluate(async (n) => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const i = Array.from(document.querySelectorAll('input')).filter(vis)
        .find((x) => /搜索图片名称|请输入文件名称|搜索/.test(x.getAttribute('placeholder') || ''));
      if (!i) return { ok: false, why: 'no_search' };
      i.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(i, n);
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, placeholder: i.getAttribute('placeholder') };
    }, NAME);
    say('输入搜索词:', searched);
    await fr.page().keyboard.press('Enter');
    await sleep(3500);

    // 找卡片（这一层只含这一个文件名）
    const card = await fr.evaluate((n) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const cands = Array.from(document.querySelectorAll('div,li')).filter(vis).filter((e) => {
        const t = clean(e.innerText);
        if (!t.includes(n)) return false;
        const names = Array.from(new Set((t.match(/[\w\u4e00-\u9fa5.-]+\.(jpe?g|png|gif|webp)/gi) || []).map((x) => x.toLowerCase())));
        return names.length === 1;
      });
      cands.sort((a, b) => a.innerText.length - b.innerText.length);
      const e = cands[0];
      if (!e) return { ok: false, why: 'no_card' };
      const r = e.getBoundingClientRect();
      const img = e.querySelector('img');
      const ri = img ? img.getBoundingClientRect() : null;
      return {
        ok: true, 卡片: clean(e.innerText).slice(0, 40), cls: clean(e.className).slice(0, 60),
        卡片中: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) },
        图中: ri ? { x: Math.round(ri.left + ri.width / 2), y: Math.round(ri.top + ri.height / 2), w: Math.round(ri.width), h: Math.round(ri.height) } : null,
      };
    }, NAME);
    say('卡片:', card);
    if (!card.ok) { process.exitCode = 1; return; }

    const t = card.图中 || card.卡片中;
    const abs = { x: Math.round(geom.left + t.x), y: Math.round(geom.top + t.y) };
    say('点绝对坐标:', abs);
    await page.mouse.move(abs.x, abs.y);
    await sleep(250);
    await page.mouse.click(abs.x, abs.y);
    await sleep(2000);
    say('点一下之后底部:', await footer());
    await page.mouse.click(abs.x, abs.y);
    await sleep(2000);
    say('再点一下之后底部（应变回 0 = 可切换）:', await footer());
  } finally { await browser.close().catch(() => {}); }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
