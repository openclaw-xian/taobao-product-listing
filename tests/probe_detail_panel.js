#!/usr/bin/env node
/**
 * 侦察：**宝贝详情**图片空间面板的当前状态。
 * 背景：`tb_upload_detail.js --force-upload` 把 26 张喂进 filechooser 后，底部显示
 *   「确定（已选 0 / 期望 26）」→ 没自动全选 → 确定按钮 disabled → 详情 img 数没变（3）。
 *   而门禁 13 记的是「上传完面板自动全选（确定（N））」。
 * 要弄清：面板是否还开着 / 图到底进没进图片空间 / 列表里有没有我们的「详情图_xx.jpg」/
 *   卡片有没有「已选」态 / 底部文案。
 *
 * 用法：node tests/probe_detail_panel.js [--port 9120]
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

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const p = browser.contexts()[0].pages().filter((x) => /publish\.htm/.test(x.url())).pop();
    if (!p) { console.log('没有 publish.htm 页'); process.exit(1); }
    console.log('URL:', p.url().slice(0, 80));

    // 顶层：iframe 几何 + 页面上可见的对话框
    const top = await p.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const ifr = Array.from(document.querySelectorAll('iframe')).map((f) => {
        const r = f.getBoundingClientRect();
        return { src: String(f.src || '').slice(0, 60), 可见: vis(f), 几何: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
      });
      const dlgs = Array.from(document.querySelectorAll('.next-dialog')).filter(vis).map((d) => ({
        文本: clean(d.innerText).slice(0, 120),
        按钮: Array.from(d.querySelectorAll('button')).filter(vis).map((b) => clean(b.innerText).slice(0, 10)),
      }));
      return { iframes: ifr, 可见对话框: dlgs };
    });
    console.log('顶层:', JSON.stringify(top, null, 1));

    // iframe 内：图片列表 / 已选 / 底部
    const frs = p.frames().filter((f) => /sucai-selector-ng/.test(f.url()));
    console.log('sucai-selector-ng frames:', frs.length);
    for (const fr of frs) {
      const r = await fr.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const btns = Array.from(document.querySelectorAll('button')).filter(vis).map((b) => ({ t: clean(b.innerText).slice(0, 16), disabled: !!b.disabled }));
        // 图片卡片：找含 .jpg/png 文件名的元素
        const cards = Array.from(document.querySelectorAll('div,li')).filter(vis).filter((e) => {
          const t = clean(e.innerText);
          return /\.(jpe?g|png|gif|webp)/i.test(t) && t.length < 120;
        });
        const names = Array.from(new Set(cards.map((e) => (clean(e.innerText).match(/[\w\u4e00-\u9fa5.-]+\.(jpe?g|png|gif|webp)/i) || [''])[0]).filter(Boolean)));
        const ours = names.filter((n) => /详情图|1比1主图|规格图/.test(n));
        const selectedish = cards.filter((e) => /selected|is-checked|checked/i.test(String(e.className))).length;
        return {
          底部按钮: btns.slice(-6),
          卡片数: cards.length,
          文件名数: names.length,
          我们的文件: ours.slice(0, 30),
          我们的文件数: ours.length,
          带selected类卡片数: selectedish,
          页面文本尾部: clean(document.body.innerText).slice(-260),
        };
      });
      console.log('iframe[' + fr.url().slice(-30) + ']:', JSON.stringify(r, null, 1));
    }
  } finally { await browser.close().catch(() => {}); }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
