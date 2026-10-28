#!/usr/bin/env node
/**
 * 侦察：详情图面板里**卡片的可点元素**到底在哪。
 * 背景：`详情图_05.jpg` 搜索定位成功、点标题那层却**选中不了**（底部「确定」一直 disabled），
 *   而早先同样的点法成功过一次 → 说明真正可点的不是标题层，得找到正确的目标元素。
 *
 * 用法：node tests/probe_detail_card.js [--name 详情图_05.jpg]
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
const NAME = String(arg('name', '详情图_05.jpg'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const p = browser.contexts()[0].pages().filter((x) => /publish\.htm/.test(x.url())).pop();
    const fr = p.frames().filter((f) => /sucai-selector-ng/.test(f.url()))[0];
    await fr.evaluate((n) => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const i = Array.from(document.querySelectorAll('input')).filter(vis).find((x) => /搜索图片名称/.test(x.getAttribute('placeholder') || ''));
      if (i) { i.focus(); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(i, n); i.dispatchEvent(new Event('input', { bubbles: true })); }
    }, NAME);
    await p.keyboard.press('Enter');
    await sleep(3500);

    const d = await fr.evaluate((n) => {
      const cls = (e) => String((e && e.getAttribute && e.getAttribute('class')) || '');
      const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const cands = Array.from(document.querySelectorAll('div,li')).filter(vis).filter((e) => clean(e.innerText).includes(n));
      cands.sort((a, b) => a.innerText.length - b.innerText.length);
      const leaf = cands[0];
      if (!leaf) return { 找不到: true };
      const chain = [];
      let cur = leaf;
      for (let k = 0; k <= 4 && cur; k++) {
        const r = cur.getBoundingClientRect();
        chain.push({
          层: k, tag: cur.tagName, cls: cls(cur).slice(0, 74),
          几何: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          img数: cur.querySelectorAll('img').length,
          勾选类: Array.from(cur.querySelectorAll('*')).map(cls).filter((c) => /check|select|circle|radio|tick/i.test(c)).slice(0, 5),
        });
        cur = cur.parentElement;
      }
      const marks = Array.from(document.querySelectorAll('*')).filter(vis)
        .filter((e) => /check|Check|select-circle|tick|next-radio/i.test(cls(e))).slice(0, 8)
        .map((e) => { const r = e.getBoundingClientRect(); return { cls: cls(e).slice(0, 54), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; });
      const imgs = Array.from(leaf.querySelectorAll('img')).map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; });
      return { leaf文本: clean(leaf.innerText).slice(0, 40), 链: chain, leaf内img: imgs, 勾选控件: marks };
    }, NAME);
    console.log(JSON.stringify(d, null, 1));
  } finally { await browser.close().catch(() => {}); }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
