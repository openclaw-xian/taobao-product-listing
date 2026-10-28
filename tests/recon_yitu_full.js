#!/usr/bin/env node
/**
 * 「以图发品」全链侦察：新开页 → 以图发品 → 传图 → 确认 → 类目+品牌 → 确认 → 读回表单（AI 填了什么）
 *
 * ⚠️ 只读 + 只填我们该填的（类目、品牌=无品牌）；**不点「提交宝贝信息」**。
 * 用法：node tests/recon_yitu_full.js --files "a.jpg,b.jpg" [--brand 无品牌] [--port 9120]
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
const FILES = String(arg('files', '')).split(',').map((s) => s.trim()).filter(Boolean);
if (!FILES.length) { console.error('需要 --files'); process.exit(2); }
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

// 页面里：按可见文本点（合成鼠标事件；弹窗/卡片按钮上 Playwright 真实点击常超时）
const CLICK = `(async (t) => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const all = Array.from(document.querySelectorAll('button,a,span,div,label')).filter((e) => vis(e) && clean(e.innerText) === t);
  if (!all.length) return { ok: false, why: 'no_match' };
  const pool = all.filter((e) => /^(button|a)$/i.test(e.tagName) || e.getAttribute('role') === 'button');
  const list = (pool.length ? pool : all).filter((e) => !(pool.length ? pool : all).some((o) => o !== e && e.contains(o)));
  const el = list[0];
  for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
  return { ok: true, tag: el.tagName.toLowerCase() };
})`;

const DUMP = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const t = clean(document.body.innerText);
  const titleInput = Array.from(document.querySelectorAll('input')).filter(vis).find((i) => /个字符/.test(i.getAttribute('placeholder') || ''));
  const brandBox = document.querySelector('#sell-field-p-20000');
  const brand = brandBox ? Array.from(brandBox.querySelectorAll('input')).map((i) => i.value).filter(Boolean)[0] : null;
  const attrs = Array.from(document.querySelectorAll('[id^="sell-field-p-"]')).filter(vis).map((e) => {
    const lab = clean(e.innerText).slice(0, 18);
    const v = Array.from(e.querySelectorAll('input')).map((i) => i.value).filter(Boolean).join('|');
    return { id: e.id, label: lab, val: v.slice(0, 30) };
  });
  const skuRows = document.querySelectorAll('table tbody tr').length;
  return {
    url: location.href.slice(0, 130), title: document.title,
    标题框值: titleInput ? titleInput.value : null,
    品牌值: brand,
    属性: attrs.slice(0, 20),
    SKU行: skuRows,
    类目候选: (t.match(/宠物\\/[^\\n]{0,80}/g) || []).slice(0, 4),
    关键行: (t.match(/(属性信息|已上传|规格|SKU模式)[^\\n]{0,60}/g) || []).slice(0, 6),
  };
})()`;

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const log = (t, o) => console.log(`\n===== ${t} =====\n` + (typeof o === 'string' ? o : JSON.stringify(o, null, 1)));
  try {
    const ctx = browser.contexts()[0];
    // ① 新开一张干净的发布入口页（不动别的标签）
    const page = await ctx.newPage();
    await page.goto('https://item.upload.taobao.com/sell/ai/category.htm', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(7000);
    log('① 新页就绪', await page.evaluate(DUMP));

    // ② 切到「以图发品」
    console.log('② 点「以图发品」:', JSON.stringify(await page.evaluate(`${CLICK}('以图发品')`)));
    await sleep(4000);

    // ③ 传图
    const inputs = await page.$$('input[type=file]');
    if (!inputs.length) { log('③ 没有 file input', '停'); return; }
    await inputs[0].setInputFiles(FILES);
    console.log('③ 已上传', FILES.length, '张');
    await sleep(9000);

    // ④ 确认，下一步 → 类目+品牌页
    console.log('④ 点「确认，下一步」:', JSON.stringify(await page.evaluate(`${CLICK}('确认，下一步')`)));
    await sleep(10000);
    log('④ 类目+品牌页', await page.evaluate(DUMP));

    // ⑤ 点 AI 推荐的第 1 个类目（文本以「宠物/」开头那条 chip）
    const picked = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const cands = Array.from(document.querySelectorAll('div,span,li')).filter((e) => vis(e) && /^宠物\/宠物食品及用品>>猫\/狗玩具>>猫抓板$/.test(clean(e.innerText)));
      if (!cands.length) return { ok: false, why: 'no_cat_chip' };
      const el = cands[cands.length - 1];
      for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      return { ok: true, text: clean(el.innerText) };
    });
    console.log('⑤ 选类目:', JSON.stringify(picked));
    await sleep(2500);

    // ⑥ 选品牌（下拉真选）
    const brandRes = await page.evaluate(async (want) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      // 找品牌输入框：优先 #sell-field-p-20000，否则「请输入」里最后一个
      const box = document.querySelector('#sell-field-p-20000');
      const inp = box ? box.querySelector('input[placeholder="请输入"]') : null;
      const target = inp || Array.from(document.querySelectorAll('input')).filter(vis).filter((i) => i.getAttribute('placeholder') === '请输入')[0];
      if (!target) return { ok: false, why: 'no_brand_input' };
      if (target.getAttribute('aria-expanded') !== 'true') {
        target.focus();
        for (const ev of ['mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        await new Promise((r) => setTimeout(r, 1500));
      }
      const cont = document.querySelector('.options-content');
      if (!cont) return { ok: false, why: 'no_options_content' };
      const find = () => Array.from(document.querySelectorAll('.options-item')).filter(vis).find((e) => clean(e.innerText) === want);
      let hit = find();
      for (let pass = 0; pass < 3 && !hit; pass++) {
        cont.scrollTop = 0; await new Promise((r) => setTimeout(r, 200)); hit = find();
        for (let y = 0; y <= cont.scrollHeight && !hit; y += 80) { cont.scrollTop = y; await new Promise((r) => setTimeout(r, 110)); hit = find(); }
        if (!hit) { cont.scrollTop = cont.scrollHeight; await new Promise((r) => setTimeout(r, 250)); hit = find(); }
      }
      if (!hit) return { ok: false, why: 'option_not_found', want };
      for (const ev of ['mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      await new Promise((r) => setTimeout(r, 1200));
      return { ok: true, 品牌输入框值: target.value };
    }, BRAND);
    console.log('⑥ 选品牌:', JSON.stringify(brandRes));
    await sleep(2000);
    log('⑥ 后状态', await page.evaluate(DUMP));

    // ⑦ 确认，下一步 → 表单
    console.log('⑦ 点「确认，下一步」:', JSON.stringify(await page.evaluate(`${CLICK}('确认，下一步')`)));
    for (const w of [12000, 10000]) {
      await sleep(w);
      log(`⑦ 之后 +${w}ms（看 AI 填了什么）`, await page.evaluate(DUMP));
    }
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_yitu_form.png') });
    console.log('截图: output/recon_yitu_form.png');
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
