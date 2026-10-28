#!/usr/bin/env node
/**
 * 「以图发品」+ **手动选类目**（不采用 AI 推荐）全链。
 *
 * 用户要求：**在一开始的以图发品那步就得把类目选对**，不要事后在已有草稿上改。
 * 所以流程是：传图 → 类目页 → **点「更多类目」/手动选择 → 按素材包路径逐级点级联 → 确定** → 品牌 → 下一步。
 *
 * 用法：
 *   node tests/recon_yitu_manualcat.js --files "a.jpg,b.jpg" --cat "宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板" [--brand 无品牌]
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const BRAND = String(arg('brand', '无品牌'));
const CAT = String(arg('cat', ''));
const FILES = String(arg('files', '')).split(',').map((s) => s.trim()).filter(Boolean);
if (!FILES.length || !CAT) { console.error('需要 --files 与 --cat'); process.exit(2); }
const LEVELS = CAT.split(/>|>>/).map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

// 按可见文本点（合成鼠标事件序列；这类卡片/弹窗按钮上 Playwright 真实点击常超时）
async function clickText(page, text, opts = {}) {
  return page.evaluate(async ({ t, contains }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const pool = Array.from(document.querySelectorAll('button,a,span,div,li')).filter((e) => vis(e));
    const hit = contains ? pool.filter((e) => clean(e.innerText).includes(t)) : pool.filter((e) => clean(e.innerText) === t);
    if (!hit.length) return { ok: false, why: 'no_match', tried: t };
    const inner = hit.filter((e) => !hit.some((o) => o !== e && e.contains(o)));
    const el = inner[0];
    for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
    return { ok: true, tag: el.tagName.toLowerCase(), text: clean(el.innerText).slice(0, 40) };
  }, { t: text, contains: !!opts.contains });
}

const STATE = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const t = clean(document.body.innerText);
  const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
  const brandBox = document.querySelector('#sell-field-p-20000');
  const brandVal = brandBox ? Array.from(brandBox.querySelectorAll('input')).map((i) => i.value).filter(Boolean)[0] : null;
  return {
    url: location.href.slice(0, 100),
    在类目页: /category\.htm/.test(location.href),
    在表单: /publish\.htm/.test(location.href),
    弹窗: dlg ? clean(dlg.innerText).slice(0, 150) : null,
    当前类目: (t.match(/当前类目\\s*\\*?\\s*([^\\n]{0,60})/) || [])[1] || null,
    AI推荐: (t.match(/宠物\\/[^\\n]{0,90}/g) || []).slice(0, 3),
    品牌值: brandVal,
    级联项: document.querySelectorAll('li.category-item').length,
  };
})()`;

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const show = async (tag, page) => console.log(`\n== ${tag} ==\n` + JSON.stringify(await page.evaluate(STATE), null, 1));
  try {
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    await page.goto('https://item.upload.taobao.com/sell/ai/category.htm', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(7000);
    console.log('目标类目路径（来自素材包）:', LEVELS.join(' > '));

    console.log('\n① 点「以图发品」:', JSON.stringify(await clickText(page, '以图发品')));
    await sleep(3500);
    const inputs = await page.$$('input[type=file]');
    if (!inputs.length) { console.log('没有 file input → 停'); return; }
    await inputs[0].setInputFiles(FILES);
    console.log('② 已上传', FILES.length, '张');
    await sleep(9000);
    console.log('③ 点「确认，下一步」:', JSON.stringify(await clickText(page, '确认，下一步')));
    await sleep(10000);
    await show('③ 类目+品牌页（AI 推荐了什么）', page);

    // ④ 手动选类目：先找入口
    let entry = null;
    for (const label of ['更多类目', '选择类目', '手动选择', '修改类目', '切换类目']) {
      const r = await clickText(page, label);
      if (r.ok) { entry = label; console.log(`④ 点开手动入口「${label}」:`, JSON.stringify(r)); break; }
    }
    if (!entry) console.log('④ ✗ 没找到手动选类目的入口（待现场看）');
    await sleep(4000);
    await show('④ 打开后', page);

    // ⑤ 逐级点级联（按素材包路径）
    for (const lv of LEVELS) {
      const r = await page.evaluate(async (want) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const lis = Array.from(document.querySelectorAll('li.category-item')).filter((e) => vis(e) && clean(e.innerText) === want);
        if (!lis.length) return { ok: false, why: 'no_item', want };
        const el = lis[0];
        for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        return { ok: true };
      }, lv);
      console.log(`⑤ 点级联「${lv}」:`, JSON.stringify(r));
      await sleep(2000);
    }
    await show('⑤ 三级点完', page);

    // ⑥ 确定 → 品牌 → 下一步
    console.log('⑥ 点「确定」:', JSON.stringify(await clickText(page, '确定')));
    await sleep(3000);
    await show('⑥ 确定后', page);

    const brandRes = await page.evaluate(async (want) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const box = document.querySelector('#sell-field-p-20000');
      const inp = box ? box.querySelector('input[placeholder="请输入"]') : Array.from(document.querySelectorAll('input')).filter(vis).filter((i) => i.getAttribute('placeholder') === '请输入')[0];
      if (!inp) return { ok: false, why: 'no_input' };
      if (inp.getAttribute('aria-expanded') !== 'true') {
        inp.focus();
        for (const ev of ['mousedown', 'mouseup', 'click']) inp.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        await new Promise((r) => setTimeout(r, 1500));
      }
      const cont = document.querySelector('.options-content');
      if (!cont) return { ok: false, why: 'no_options' };
      const find = () => Array.from(document.querySelectorAll('.options-item')).filter(vis).find((e) => clean(e.innerText) === want);
      let hit = find();
      for (let pass = 0; pass < 3 && !hit; pass++) {
        cont.scrollTop = 0; await new Promise((r) => setTimeout(r, 200)); hit = find();
        for (let y = 0; y <= cont.scrollHeight && !hit; y += 600) { cont.scrollTop = y; await new Promise((r) => setTimeout(r, 160)); hit = find(); }
        if (!hit) { cont.scrollTop = cont.scrollHeight; await new Promise((r) => setTimeout(r, 250)); hit = find(); }
      }
      if (!hit) return { ok: false, why: 'option_not_found' };
      for (const ev of ['mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      await new Promise((r) => setTimeout(r, 1200));
      return { ok: true, 品牌值: inp.value };
    }, BRAND);
    console.log('⑦ 选品牌:', JSON.stringify(brandRes));
    await sleep(1500);

    console.log('⑧ 点「确认，下一步」:', JSON.stringify(await clickText(page, '确认，下一步')));
    await sleep(14000);
    await show('⑧ 表单（校验类目/品牌）', page);
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_yitu_manual.png') });
    console.log('截图: output/recon_yitu_manual.png');
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
