#!/usr/bin/env node
/**
 * 「搜索发品」+ **手动按素材包路径选类目** 全链侦察。
 *
 * ⚠️ 已被 `tests/recon_catpage_brand2.js` 取代（那是最终验通版），本脚本保留价值只有两条发现：
 *   ① 入口页已改版 —— 「搜索发品」卡片直接是 搜索框 + 发布历史 + 类目级联树，**没有「开启」按钮**；
 *   ② 类目三级点完「确认，下一步」**仍是 disabled**（当时误判为「叶子没选中」，实为品牌未选）。
 *   ⚠️ 本脚本第 ⑤ 步用 `li` 扫品牌选项是**错的**（类目页品牌选项是 `div.options-item`）。
 *
 * 背景：用户弃用「以图发品」（它会把上传的主图自动铺进**宝贝详情图**），改回**搜索发品**；
 * 且要求类目**自己按素材包路径选对**（不采用 AI/搜索推荐）。
 *
 * 要验的问题：
 *   Q1 搜索发品卡片上那个「选择类目」按钮，点开的是不是带 3 列级联的【选择类目】弹窗？
 *   Q2 若能，按素材包路径逐级点 li.category-item → 确定，类目是否就定下来了？
 *   Q3 品牌仍要真选（下拉 .options-content → .options-item）→ 「确认，下一步」能否进 publish.htm？
 *
 * 用法：
 *   node tests/recon_search_manualcat.js [--cat "宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板"] [--brand 无品牌]
 * 日志：tests/_search_manual.log（脚本自己写文件，避免 PowerShell 管道截断/编码问题）
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
const CAT = String(arg('cat', '宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板'));
const LEVELS = CAT.split(/>|>>/).map((s) => s.trim()).filter(Boolean);
const KEYWORD = String(arg('kw', LEVELS[LEVELS.length - 1]));
const LOG = path.join(__dirname, '_search_manual.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.writeFileSync(LOG, `== recon_search_manualcat ${new Date().toISOString()} ==\n目标类目: ${LEVELS.join(' > ')}\n关键词: ${KEYWORD}\n品牌: ${BRAND}\n`);
function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' ');
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

// 按可见文本点（合成鼠标事件序列；卡片/弹窗按钮上 Playwright 真实点击常超时）
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
  const dlgs = Array.from(document.querySelectorAll('.next-dialog')).filter(vis);
  const box = document.querySelector('#sell-field-p-20000');
  const brandVal = box ? Array.from(box.querySelectorAll('input')).map((i) => i.value).filter(Boolean)[0] : null;
  return {
    url: location.href.slice(0, 110),
    在入口页: /category\\.htm/.test(location.href),
    在表单: /publish\\.htm/.test(location.href),
    弹窗数: dlgs.length,
    弹窗: dlgs.length ? clean(dlgs[0].innerText).slice(0, 220) : null,
    级联项: document.querySelectorAll('li.category-item').length,
    搜索框: Array.from(document.querySelectorAll('input')).filter(vis).map((i) => i.getAttribute('placeholder')).filter(Boolean).slice(0, 6),
    已选类目: (t.match(/已选类目[:：]?\\s*([^\\n]{0,70})/) || [])[1] || null,
    当前类目: (t.match(/当前类目\\s*\\*?\\s*([^\\n]{0,70})/) || [])[1] || null,
    页面类目路径: (t.match(/宠物\\/[^\\n]{0,90}/g) || []).slice(0, 3),
    品牌值: brandVal,
    有确定: Array.from(document.querySelectorAll('button')).filter(vis).some((b) => clean(b.innerText) === '确定'),
    有确认下一步: Array.from(document.querySelectorAll('button,div,span')).filter(vis).some((b) => clean(b.innerText) === '确认，下一步'),
  };
})()`;

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const show = async (tag, page) => log(`\n== ${tag} ==\n` + JSON.stringify(await page.evaluate(STATE), null, 1));
  try {
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    await page.goto('https://item.upload.taobao.com/sell/ai/category.htm', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(7000);

    // ① 点「搜索发品」卡片里的「开启」（页面上有多个「开启」）
    const opened = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const btns = Array.from(document.querySelectorAll('button')).filter(vis).filter((b) => clean(b.innerText) === '开启');
      const info = { 开启按钮数: btns.length };
      const cards = Array.from(document.querySelectorAll('div,section')).filter(vis).filter((e) => clean(e.innerText).includes('搜索发品'));
      cards.sort((a, b) => a.innerText.length - b.innerText.length);
      let target = null;
      for (const card of cards) {
        const b = Array.from(card.querySelectorAll('button')).filter(vis).find((x) => clean(x.innerText) === '开启');
        if (b) { target = b; info.卡片文本 = clean(card.innerText).slice(0, 80); break; }
      }
      if (!target && btns.length) { target = btns[0]; info.fallback = '取第 1 个开启'; }
      if (!target) return { ok: false, ...info, why: 'no_open_btn' };
      for (const ev of ['mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      return { ok: true, ...info };
    });
    log('① 点「搜索发品 → 开启」:', opened);
    await sleep(4000);
    await show('① 展开后的搜索区', page);

    // ② Q1：点「选择类目」按钮，看打开什么
    const q1 = await clickText(page, '选择类目', { contains: true });
    log('② 点「选择类目」:', q1);
    await sleep(4000);
    await show('② 点开「选择类目」后', page);
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_search_catbtn.png') }).catch(() => {});

    let mode = 'dialog';
    let state = await page.evaluate(STATE);
    if (!state.级联项) {
      // 回退：走搜索框（输入关键词 → 回车 → 点类目推荐行）
      mode = 'search';
      log('②b 没出级联 → 回退走搜索框');
      const typed = await page.evaluate(async (kw) => {
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const inp = Array.from(document.querySelectorAll('input')).filter(vis).find((i) => (i.getAttribute('placeholder') || '').includes('可输入产品名称'));
        if (!inp) return { ok: false, why: 'no_search_input' };
        inp.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, kw);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
        return { ok: true, value: inp.value };
      }, KEYWORD);
      log('②b 搜索框输入+回车:', typed);
      await page.keyboard.press('Enter').catch(() => {});
      await sleep(5000);
      await show('②b 搜索结果', page);
      // 点类目推荐行（路径文本含目标路径）
      const picked = await page.evaluate((want) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const rows = Array.from(document.querySelectorAll('div.sell-component-general-category-result-cate, [class*="result-item"]')).filter(vis);
        const hit = rows.find((r) => clean(r.innerText).replace(/\s+/g, '').includes(want.replace(/\s+/g, ''))) || rows[0];
        if (!hit) return { ok: false, why: 'no_result_row' };
        for (const ev of ['mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        return { ok: true, text: clean(hit.innerText).slice(0, 90) };
      }, LEVELS.join('>'));
      log('②c 点类目推荐行:', picked);
      await sleep(4000);
      await show('②c 点后（应切到级联）', page);
    }
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_search_cascade.png') }).catch(() => {});

    // ③ 逐级点级联（按素材包路径）
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
      log(`③ 点级联「${lv}」:`, r);
      await sleep(2200);
    }
    await show('③ 三级点完', page);

    // ④ 弹窗里的「确定」（若走弹窗）；搜索路线不需要
    if (mode === 'dialog') {
      const ok = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
        const scope = dlg || document;
        const btn = Array.from(scope.querySelectorAll('button')).filter(vis).find((b) => clean(b.innerText) === '确定');
        if (!btn) return { ok: false, why: 'no_confirm_btn' };
        for (const ev of ['mousedown', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        return { ok: true };
      });
      log('④ 点弹窗「确定」:', ok);
      await sleep(3500);
      await show('④ 确定后（类目应已定）', page);
    }

    // ⑤ 品牌真选
    const brandRes = await page.evaluate(async (want) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const box = document.querySelector('#sell-field-p-20000')
        || Array.from(document.querySelectorAll('[id^="sell-field-p-"]')).filter(vis).find((b) => clean(b.innerText).includes('品牌'));
      if (!box) return { ok: false, why: 'no_brand_box' };
      const inp = Array.from(box.querySelectorAll('input')).filter(vis)[0];
      if (!inp) return { ok: false, why: 'no_input' };
      if (inp.getAttribute('aria-expanded') !== 'true') {
        inp.focus();
        for (const ev of ['mousedown', 'mouseup', 'click']) inp.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        await new Promise((r) => setTimeout(r, 1500));
      }
      const cont = document.querySelector('.options-content');
      if (!cont) return { ok: false, why: 'no_options', 品牌框id: box.id };
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
      return { ok: true, 品牌值: inp.value, 品牌框id: box.id };
    }, BRAND);
    log('⑤ 选品牌:', brandRes);
    await sleep(1500);

    // ⑥ 确认，下一步 → 进表单
    log('⑥ 点「确认，下一步」:', await clickText(page, '确认，下一步'));
    await sleep(14000);
    await show('⑥ 表单（校验类目/品牌）', page);
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_search_form.png') }).catch(() => {});
    log('\n截图: output/recon_search_catbtn.png / recon_search_cascade.png / recon_search_form.png');
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
