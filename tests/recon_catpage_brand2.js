#!/usr/bin/env node
/**
 * 类目页（category.htm）品牌选定的正解尝试 v2：**用下拉自带的 `options-search` 搜索框过滤**。
 *
 * 上一轮（recon_catpage_brand.js）探测结论：
 *   - 品牌下拉面板 = `.sell-o-select-options`（内含 `options-search` 1 个、`options-content` 1 个、`.options-item` 14 个）
 *   - **选项是 `div.options-item`，不是 `li`**（上一轮误用 li 所以扫不到）
 *   - `.options-content` scrollHeight 392 / clientHeight 290 → 只有 14 项、**硬滚滚不出更多**
 * 所以：不滚，改用 `options-search` 输入「无品牌」过滤。
 *
 * 全链：入口页 → 按素材包路径点级联 → 品牌（搜索过滤真选）→ 确认，下一步 → publish.htm 读回
 *
 * 用法：node tests/recon_catpage_brand2.js
 * 日志：tests/_catpage_brand2.log
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
const LOG = path.join(__dirname, '_catpage_brand2.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.writeFileSync(LOG, `== recon_catpage_brand2 ${new Date().toISOString()} ==\n类目: ${LEVELS.join(' > ')}\n品牌: ${BRAND}\n`);
function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' ');
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

// 页面级读回（弹层外的品牌输入框 / 下一步按钮 / 底部路径）
const pageState = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const popup = document.querySelector('.sell-o-select-options');
  const brandInp = Array.from(document.querySelectorAll('input')).filter(vis).find((i) => (i.getAttribute('placeholder') || '') === '请输入' && !(popup && popup.contains(i)));
  const nb = Array.from(document.querySelectorAll('button')).filter(vis).find((b) => clean(b.innerText).includes('确认，下一步'));
  const t = clean(document.body.innerText);
  return {
    url: location.href.slice(0, 90),
    在类目页: /category\.htm/.test(location.href),
    在表单: /publish\.htm/.test(location.href),
    品牌值: brandInp ? brandInp.value : null,
    品牌输入框存在: !!brandInp,
    下一步disabled: nb ? !!nb.disabled : null,
    底部路径: (t.match(/宠物\/[^\n]{0,80}确认，下一步/) || [])[0] || null,
    弹层打开: !!popup,
  };
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = await browser.contexts()[0].newPage();
    await page.goto('https://item.upload.taobao.com/sell/ai/category.htm', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(8000);

    for (const lv of LEVELS) {
      const r = await page.evaluate((want) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const el = Array.from(document.querySelectorAll('li.category-item')).filter((e) => vis(e) && clean(e.innerText) === want)[0];
        if (!el) return { ok: false, why: 'no_item', want };
        for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        return { ok: true };
      }, lv);
      log(`① 点级联「${lv}」:`, r);
      await sleep(2500);
    }
    log('② 选完类目:', await page.evaluate(pageState));

    // ③ 打开品牌下拉（弹层外的那个「请输入」）
    const opened = await page.evaluate(async () => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const popup = document.querySelector('.sell-o-select-options');
      const inp = Array.from(document.querySelectorAll('input')).filter(vis).find((i) => (i.getAttribute('placeholder') || '') === '请输入' && !(popup && popup.contains(i)));
      if (!inp) return { ok: false, why: 'no_brand_input' };
      if (inp.getAttribute('aria-expanded') !== 'true') {
        inp.focus();
        for (const ev of ['mousedown', 'mouseup', 'click']) inp.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        await new Promise((r) => setTimeout(r, 2500));
      }
      const pop = document.querySelector('.sell-o-select-options');
      const search = pop ? pop.querySelector('.options-search input') || pop.querySelector('input') : null;
      return {
        ok: true,
        弹层: !!pop,
        选项数: document.querySelectorAll('.options-item').length,
        选项前20: Array.from(document.querySelectorAll('.options-item')).filter(vis).map((e) => clean(e.innerText)).slice(0, 20),
        搜索框placeholder: search ? search.getAttribute('placeholder') : null,
        搜索框count: pop ? pop.querySelectorAll('input').length : 0,
      };
    });
    log('③ 打开品牌下拉:', opened);

    // ④ 用弹出层的搜索框过滤品牌
    const filtered = await page.evaluate(async (want) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const pop = document.querySelector('.sell-o-select-options');
      if (!pop) return { ok: false, why: 'no_popup' };
      const inputs = Array.from(pop.querySelectorAll('input')).filter(vis);
      const search = inputs[0];
      if (!search) return { ok: false, why: 'no_search_input', popHTML: pop.outerHTML.slice(0, 400) };
      search.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(search, want);
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 2500));
      const items = Array.from(pop.querySelectorAll('.options-item')).filter(vis).map((e) => clean(e.innerText));
      return { ok: true, 搜索框值: search.value, 过滤后项数: items.length, 过滤后项: items.slice(0, 20) };
    }, BRAND);
    log('④ 搜索框过滤「' + BRAND + '」:', filtered);
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_catpage_brand2.png') }).catch(() => {});

    // ⑤ 点中它
    const picked = await page.evaluate(async (want) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const pop = document.querySelector('.sell-o-select-options');
      const items = Array.from((pop || document).querySelectorAll('.options-item')).filter(vis);
      const hit = items.find((e) => clean(e.innerText) === want) || items.find((e) => clean(e.innerText).includes(want));
      if (!hit) return { ok: false, why: 'no_match', 现有: items.map((e) => clean(e.innerText)).slice(0, 20) };
      for (const ev of ['mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      await new Promise((r) => setTimeout(r, 1800));
      const popup2 = document.querySelector('.sell-o-select-options');
      const inp = Array.from(document.querySelectorAll('input')).filter(vis).find((i) => (i.getAttribute('placeholder') || '') === '请输入' && !(popup2 && popup2.contains(i)));
      return { ok: true, 选中: clean(hit.innerText), 品牌值: inp ? inp.value : null };
    }, BRAND);
    log('⑤ 点品牌选项:', picked);
    await sleep(2000);
    log('⑥ 选品牌后:', await page.evaluate(pageState));

    // ⑦ 确认，下一步
    const next = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const nb = Array.from(document.querySelectorAll('button')).filter(vis).find((b) => clean(b.innerText).includes('确认，下一步'));
      if (!nb) return { ok: false, why: 'no_next_btn' };
      if (nb.disabled) return { ok: false, why: 'still_disabled' };
      for (const ev of ['mousedown', 'mouseup', 'click']) nb.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      return { ok: true };
    });
    log('⑦ 点「确认，下一步」:', next);
    await sleep(15000);
    log('⑧ 落地:', await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const t = clean(document.body.innerText);
      const box = document.querySelector('#sell-field-p-20000');
      const brandVal = box ? Array.from(box.querySelectorAll('input')).map((i) => i.value).filter(Boolean)[0] : null;
      return {
        url: location.href.slice(0, 180),
        在表单: /publish\.htm/.test(location.href),
        catId: (location.search.match(/catId=(\d+)/) || [])[1] || null,
        当前类目: (t.match(/当前类目\s*\*?\s*([^\n]{0,70})/) || [])[1] || null,
        品牌值: brandVal,
        有提交按钮: t.includes('提交宝贝信息'),
        顶部红框报错: (t.match(/请发布前修改以下出错项[^\n]{0,80}/) || [])[0] || null,
      };
    }));
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_search_form.png') }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
