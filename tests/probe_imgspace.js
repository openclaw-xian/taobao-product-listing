#!/usr/bin/env node
/**
 * 图片空间探针（**只读 + 点一次空槽**）：摸「1:1 主图」上传走的那套 iframe。
 *
 * 已知（门禁 5）：发布页**没有** `input[type=file]`，主图/详情图/规格图都走「图片空间」iframe
 * （`sucai-selector-ng`）→ 点空位 → iframe 内「本地上传」触发 filechooser → 选中 → iframe 内「确定(N)」。
 * 本脚本要把这些**现场确认**下来：iframe 的 name/url、内部按钮文案、file input 在哪一层。
 *
 * 用法：
 *   node tests/probe_imgspace.js            # 只读：列出所有图片槽与分组
 *   node tests/probe_imgspace.js --click 0   # 真实点击第 0 个槽，然后列出 iframe 结构
 * 日志/截图：tests/_imgspace.log、output/recon_imgspace.png
 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const CLICK = arg('click', null);
const LOG = path.join(__dirname, '_imgspace.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== probe_imgspace click=${CLICK} ${new Date().toISOString()} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

const slots = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // 「上传图片」文案的最内层元素
  const raw = Array.from(document.querySelectorAll('div,span,li,p')).filter(vis).filter((e) => clean(e.innerText) === '上传图片');
  const inner = raw.filter((e) => !raw.some((o) => o !== e && e.contains(o)));
  const t = clean(document.body.innerText);
  return {
    区块文案: {
      '1:1': (t.match(/1:1主图[\s\S]{0,110}/) || [])[0] || null,
      '3:4': (t.match(/3:4主图[\s\S]{0,110}/) || [])[0] || null,
    },
    槽数: inner.length,
    槽: inner.map((e, i) => {
      const r = e.getBoundingClientRect();
      const card = e.closest('[class*="upload"],[class*="image"],[class*="pic"],[class*="slot"]') || e.parentElement;
      return {
        i,
        y: Math.round(r.top),
        x: Math.round(r.left),
        w: Math.round(r.width),
        h: Math.round(r.height),
        卡片class: card ? String(card.className).slice(0, 70) : null,
        卡片内img: card ? card.querySelectorAll('img').length : 0,
        卡片文本: card ? clean(card.innerText).slice(0, 30) : null,
      };
    }),
    当前iframe: Array.from(document.querySelectorAll('iframe')).map((f) => {
      const r = f.getBoundingClientRect();
      return { name: f.name || null, src: (f.src || '').slice(0, 90), w: Math.round(r.width), h: Math.round(r.height), 可见: r.width > 0 && r.height > 0 };
    }),
  };
};

async function frameReport(page) {
  const out = [];
  for (const f of page.frames()) {
    const isMain = f === page.mainFrame();
    let info = { name: f.name() || '(无名)', url: f.url().slice(0, 110), isMain };
    if (!isMain) {
      try {
        info = Object.assign(info, await f.evaluate(() => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          return {
            文件输入数: document.querySelectorAll('input[type=file]').length,
            按钮: Array.from(document.querySelectorAll('button')).filter(vis).map((b) => clean(b.innerText)).filter(Boolean).slice(0, 24),
            可点文案: Array.from(document.querySelectorAll('a,span,div,label')).filter(vis).map((e) => clean(e.innerText)).filter((t) => t && t.length < 12 && /上传|本地|确定|确定\(|选择|图片|全部|取消|新建/.test(t)).slice(0, 24),
            标题: clean(document.title).slice(0, 60),
          };
        }));
      } catch (e) {
        info.err = e.message.slice(0, 90);
      }
    }
    out.push(info);
  }
  return out;
}

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('找不到可用发布页'); process.exitCode = 1; return; }
    log('页面:', page.url().slice(0, 96));
    const s = await page.evaluate(slots);
    log('\n--- 图片槽 ---');
    log(JSON.stringify(s.区块文案, null, 1));
    log('槽数 =', s.槽数);
    s.槽.forEach((x) => log('  ', x));
    log('当前 iframe:', s.当前iframe);

    if (CLICK !== null) {
      const i = parseInt(String(CLICK), 10);
      log(`\n--- 真实点击槽 [${i}] ---`);
      const loc = page.locator('text=上传图片').nth(i);
      const r = await loc.click({ force: true, timeout: 8000 }).then(() => ({ ok: true })).catch((e) => ({ ok: false, err: e.message.slice(0, 120) }));
      log('点击:', r);
      await sleep(5000);
      log('\n--- 点击后的 iframe ---');
      log(await frameReport(page));
      await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_imgspace.png') }).catch(() => {});
      log('\n截图: output/recon_imgspace.png');
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
