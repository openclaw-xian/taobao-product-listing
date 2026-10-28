#!/usr/bin/env node
/** 探针：宝贝详情「添加 → 图片」打开的图片空间面板结构（iframe 名 / 按钮 / 是否有确定(N)）。 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const PORT = process.env.TB_PORT || '9120';
const LOG = path.join(__dirname, '_detail_probe.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== probe_detail ${new Date().toISOString()} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const VIS = `const clean=(s)=>(s||'').replace(/\\s+/g,' ').trim();const vis=(e)=>{if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};`;

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('找不到发布页'); return; }

    // ① 点「添加」
    const add = await page.evaluate(`(() => { ${VIS}
      const cands = Array.from(document.querySelectorAll('div,span,button,a')).filter(vis).filter((e)=>clean(e.innerText)==='添加');
      const inner = cands.filter((e)=>!cands.some((o)=>o!==e&&e.contains(o)));
      if(!inner.length) return {ok:false,why:'no_add'};
      const el=inner[0];
      for(const ev of ['mousedown','mouseup','click']) el.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window}));
      return {ok:true};
    })()`);
    log('① 点「添加」:', add);
    await sleep(2500);

    // ② 菜单里有哪些项 + 点「图片」
    const menu = await page.evaluate(`(() => { ${VIS}
      const items = Array.from(document.querySelectorAll('[class*="add_item"],[class*="add-item"],div,span,li')).filter(vis)
        .map((e)=>clean(e.innerText)).filter((t)=>t&&t.length<8&&/图片|文字|源码|模板|高级|视频/.test(t));
      const cands = Array.from(document.querySelectorAll('[class*="add_item"],[class*="add-item"],div,span,li')).filter(vis).filter((e)=>clean(e.innerText)==='图片');
      const el = cands.filter((e)=>!cands.some((o)=>o!==e&&e.contains(o)))[0];
      if(!el) return {ok:false,菜单项:Array.from(new Set(items)).slice(0,10)};
      for(const ev of ['mousedown','mouseup','click']) el.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window}));
      return {ok:true,菜单项:Array.from(new Set(items)).slice(0,10)};
    })()`);
    log('② 点「图片」:', menu);
    await sleep(6000);

    // ③ 列出所有图片空间 iframe
    const frames = page.frames().filter((f) => /sucai-selector-ng/.test(f.url()));
    log('③ 图片空间 iframe 数 =', frames.length, frames.map((f) => f.name() + ' | ' + f.url().slice(0, 80)));
    const fr = frames[frames.length - 1];
    if (!fr) { log('★ 没有 sucai-selector-ng iframe'); return; }

    const info = await fr.evaluate(`(() => { ${VIS}
      const btns = Array.from(document.querySelectorAll('button')).map((b)=>({t:clean(b.innerText).slice(0,16),vis:vis(b),dis:!!b.disabled,cls:String(b.className).slice(0,40)}));
      const footer = Array.from(document.querySelectorAll('[class*=Footer],[class*=footer]')).filter(vis).map((e)=>clean(e.innerText).slice(0,40));
      return { 按钮: btns.filter((b)=>b.t).slice(0,14), 全部按钮数: btns.length, Footer文本: footer.slice(0,4),
        文件输入: document.querySelectorAll('input[type=file]').length,
        文件输入multiple: Array.from(document.querySelectorAll('input[type=file]')).map((i)=>i.multiple),
        大图数: Array.from(document.querySelectorAll('img')).filter((e)=>{const r=e.getBoundingClientRect();return r.width>=100&&r.height>=100;}).length,
        视口: { w: innerWidth, h: innerHeight } };
    })()`);
    log('③ 面板结构:', info);
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_detail_panel.png') }).catch(() => {});
    log('截图: output/recon_detail_panel.png');
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
