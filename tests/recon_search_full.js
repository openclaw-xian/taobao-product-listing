#!/usr/bin/env node
/**
 * 「搜索发品」全链（**不用 AI/搜索推荐，直接按素材包路径点级联**）→ 进 publish.htm。
 *
 * 接 tests/recon_search_manualcat.js 的结论：入口页已改版，没有「开启」按钮，
 * 「搜索发品」卡片里直接就是 搜索框 + 发布历史 + 类目级联树；按路径逐级点 li.category-item
 * 到底层叶子后，底部就显示选中路径。
 *
 * 本脚本要收口的三件事：
 *   Q1 级联选到底层后，底部「确认，下一步」是否可点（叶子是否真的选中）？
 *   Q2 这一步有没有 ★品牌 字段？有 → 真选；没有 → 直接下一步（品牌到表单里填）
 *   Q3 点「确认，下一步」→ 落到 publish.htm？读回 当前类目 / 品牌 / URL
 *
 * 用法：node tests/recon_search_full.js
 * 日志：tests/_search_full.log
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
const BRAND = String(arg('brand', '无品牌'));
const CAT = String(arg('cat', '宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板'));
const LEVELS = CAT.split(/>|>>/).map((s) => s.trim()).filter(Boolean);
const LOG = path.join(__dirname, '_search_full.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.writeFileSync(LOG, `== recon_search_full ${new Date().toISOString()} ==\n目标类目: ${LEVELS.join(' > ')}\n品牌: ${BRAND}\n`);
function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' ');
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

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

// 读回「类目页」状态：底部叶子路径 / 下一步按钮是否可点 / 品牌字段
const CATPAGE = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const t = clean(document.body.innerText);
  const nextBtns = Array.from(document.querySelectorAll('button')).filter(vis).filter((b) => clean(b.innerText).includes('确认，下一步'));
  const nb = nextBtns[0];
  const brandInps = Array.from(document.querySelectorAll('input')).filter(vis).filter((i) => (i.getAttribute('placeholder') || '') === '请输入');
  const bi = brandInps[0];
  let brandBox = null;
  if (bi) {
    let p = bi;
    for (let k = 0; k < 6 && p; k++) {
      p = p.parentElement;
      if (!p) break;
      if (p.id || /brand|prop|field/i.test(p.className || '')) { brandBox = { id: p.id || null, cls: String(p.className).slice(0, 90), text: clean(p.innerText).slice(0, 60) }; break; }
    }
  }
  const leaves = Array.from(document.querySelectorAll('li.category-item')).filter(vis);
  return {
    url: location.href.slice(0, 90),
    在类目页: /category\\.htm/.test(location.href),
    在表单: /publish\\.htm/.test(location.href),
    级联项: leaves.length,
    选中叶子: leaves.filter((e) => (e.className || '').includes('selected')).map((e) => clean(e.innerText)).slice(0, 8),
    底部路径: (t.match(/宠物\\/[^\\n]{0,80}确认，下一步/) || [])[0] || null,
    下一步按钮: nb ? { text: clean(nb.innerText), disabled: !!nb.disabled, cls: String(nb.className).slice(0, 60) } : null,
    品牌输入框数: brandInps.length,
    品牌框: brandBox,
    品牌值: bi ? bi.value : null,
    有问号助手类目提示: t.includes('商品类目怎么选'),
  };
})()`;

const FORMPAGE = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const t = clean(document.body.innerText);
  const brandBox = document.querySelector('#sell-field-p-20000');
  const brandVal = brandBox ? Array.from(brandBox.querySelectorAll('input')).map((i) => i.value).filter(Boolean)[0] : null;
  const title = Array.from(document.querySelectorAll('input')).filter(vis).find((i) => (i.getAttribute('placeholder') || '').includes('30个汉字'));
  return {
    url: location.href.slice(0, 160),
    在表单: /publish\\.htm/.test(location.href),
    catId: (location.search.match(/catId=(\\d+)/) || [])[1] || null,
    当前类目: (t.match(/当前类目\\s*\\*?\\s*([^\\n]{0,70})/) || [])[1] || null,
    品牌值: brandVal,
    标题值: title ? title.value : null,
    1比1主图槽: (t.match(/1:1主图[\\s\\S]{0,60}/) || [])[0] || null,
    详情已铺图: (t.match(/宝贝详情[\\s\\S]{0,80}/) || [])[0] || null,
    有提交按钮: t.includes('提交宝贝信息'),
  };
})()`;

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    await page.goto('https://item.upload.taobao.com/sell/ai/category.htm', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(8000);
    log('① 入口页（搜索发品卡片）:', await page.evaluate(CATPAGE));

    // ② 按素材包路径逐级点级联
    for (const lv of LEVELS) {
      const r = await page.evaluate(async (want) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const lis = Array.from(document.querySelectorAll('li.category-item')).filter((e) => vis(e) && clean(e.innerText) === want);
        if (!lis.length) return { ok: false, why: 'no_item', want, 可见项: Array.from(document.querySelectorAll('li.category-item')).filter(vis).map((e) => clean(e.innerText)).slice(0, 12) };
        const el = lis[0];
        for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        return { ok: true };
      }, lv);
      log(`② 点级联「${lv}」:`, r);
      await sleep(2500);
    }
    await sleep(2000);
    const st = await page.evaluate(CATPAGE);
    log('③ 级联点完后:', st);
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_search_leaf.png') }).catch(() => {});

    // ④ 品牌（若有）
    if (st.品牌输入框数) {
      const brandRes = await page.evaluate(async (want) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const inp = Array.from(document.querySelectorAll('input')).filter(vis).find((i) => (i.getAttribute('placeholder') || '') === '请输入');
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
        if (!hit) return { ok: false, why: 'option_not_found', 候选样本: Array.from(document.querySelectorAll('.options-item')).filter(vis).map((e) => clean(e.innerText)).slice(0, 10) };
        for (const ev of ['mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        await new Promise((r) => setTimeout(r, 1200));
        return { ok: true, 品牌值: inp.value };
      }, BRAND);
      log('④ 类目页选品牌:', brandRes);
      await sleep(1500);
    } else {
      log('④ 类目页没有品牌字段 → 品牌留到表单里填');
    }

    // ⑤ 确认，下一步
    log('⑤ 点「确认，下一步」:', await clickText(page, '确认，下一步'));
    await sleep(14000);
    log('⑥ 落地的页面:', await page.evaluate(FORMPAGE));
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_search_form.png') }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
