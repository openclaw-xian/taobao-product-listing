#!/usr/bin/env node
/**
 * 卡点侦察：**类目页（category.htm）的品牌下拉** + 「确认，下一步」的启用条件。
 *
 * 已知（2026-10-10 实测）：
 *   ① 入口页已改版 —— 「搜索发品」卡片里直接是 搜索框 + 发布历史 + 类目级联树（没有「开启」按钮）
 *   ② 按素材包路径点 li.category-item 三级 → 三个都 selected + 底部显示路径 ✓
 *   ③ 但「确认，下一步」仍 `disabled=true`，品牌字段（`sell-o-combobox sell-catProp-item-s`）为空
 *   ④ 复用表单页那套（`.options-content` + `.options-item`）滚 3 遍**找不到**「无品牌」→ 滚动容器大概率不对
 *
 * 本脚本回答：
 *   Q1 类目页品牌下拉的弹层长什么样（选项项 class / 可滚容器 / 项数）
 *   Q2 「无品牌」在不在里面、怎么滚到
 *   Q3 选完品牌后「确认，下一步」是否变可点
 *   Q4 能进 publish.htm 吗（URL / 当前类目 / 品牌）
 *
 * 用法：node tests/recon_catpage_brand.js
 * 日志：tests/_catpage_brand.log
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
const LOG = path.join(__dirname, '_catpage_brand.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.writeFileSync(LOG, `== recon_catpage_brand ${new Date().toISOString()} ==\n目标类目: ${LEVELS.join(' > ')}\n品牌: ${BRAND}\n`);
function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' ');
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

// 读回类目页状态（函数形式，避免字符串转义踩坑）
const catState = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const t = clean(document.body.innerText);
  const nb = Array.from(document.querySelectorAll('button')).filter(vis).find((b) => clean(b.innerText).includes('确认，下一步'));
  const brandInp = Array.from(document.querySelectorAll('input')).filter(vis).find((i) => (i.getAttribute('placeholder') || '') === '请输入');
  return {
    url: location.href.slice(0, 90),
    在类目页: /category\.htm/.test(location.href),
    在表单: /publish\.htm/.test(location.href),
    下一步disabled: nb ? !!nb.disabled : null,
    底部路径: (t.match(/宠物\/[^\n]{0,80}确认，下一步/) || [])[0] || null,
    品牌值: brandInp ? brandInp.value : null,
    品牌输入框存在: !!brandInp,
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
    log('② 选完类目:', await page.evaluate(catState));

    // ③ 打开品牌下拉 + 探测弹层结构
    const probe = await page.evaluate(async () => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const inp = Array.from(document.querySelectorAll('input')).filter(vis).find((i) => (i.getAttribute('placeholder') || '') === '请输入');
      if (!inp) return { ok: false, why: 'no_brand_input' };
      inp.focus();
      for (const ev of ['mousedown', 'mouseup', 'click']) inp.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      await new Promise((r) => setTimeout(r, 2500));
      const scrollers = Array.from(document.querySelectorAll('div,ul')).filter(vis)
        .filter((e) => e.scrollHeight > e.clientHeight + 20)
        .map((e) => ({ cls: String(e.className).slice(0, 90), sh: e.scrollHeight, ch: e.clientHeight, 子项: e.querySelectorAll('li').length, 文本: clean(e.innerText).slice(0, 50) }))
        .slice(0, 12);
      const itemClasses = {};
      Array.from(document.querySelectorAll('li,div')).filter(vis).forEach((e) => {
        const c = String(e.className || '');
        if (/option|select-item|SelectItem/i.test(c)) { const key = c.slice(0, 70); itemClasses[key] = (itemClasses[key] || 0) + 1; }
      });
      const liTexts = Array.from(document.querySelectorAll('li')).filter(vis).map((e) => clean(e.innerText)).filter(Boolean);
      return {
        ok: true,
        输入框aria: inp.getAttribute('aria-expanded'),
        输入框class: String(inp.className).slice(0, 90),
        可滚容器: scrollers,
        选项类名统计: itemClasses,
        li总数: liTexts.length,
        li前25: liTexts.slice(0, 25),
        有无品牌字样: liTexts.filter((t) => t.includes('品牌')).slice(0, 8),
      };
    });
    log('③ 品牌下拉探测:', probe);

    // ④ 用探测到的可滚容器扫「无品牌」
    const pick = await page.evaluate(async (want) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const inp = Array.from(document.querySelectorAll('input')).filter(vis).find((i) => (i.getAttribute('placeholder') || '') === '请输入');
      if (!inp) return { ok: false, why: 'no_brand_input' };
      if (inp.getAttribute('aria-expanded') !== 'true') {
        inp.focus();
        for (const ev of ['mousedown', 'mouseup', 'click']) inp.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        await new Promise((r) => setTimeout(r, 2000));
      }
      // 候选容器：所有可见可滚元素 + .options-content
      const cands = Array.from(document.querySelectorAll('div,ul')).filter(vis).filter((e) => e.scrollHeight > e.clientHeight + 20);
      const oc = document.querySelector('.options-content');
      if (oc && !cands.includes(oc)) cands.push(oc);
      const find = () => Array.from(document.querySelectorAll('li')).filter(vis).find((e) => clean(e.innerText) === want);
      let hit = find();
      const tried = [];
      for (const c of cands) {
        if (hit) break;
        const before = Array.from(document.querySelectorAll('li')).filter(vis).length;
        c.scrollTop = 0; await new Promise((r) => setTimeout(r, 200));
        for (let y = 0; y <= c.scrollHeight && !hit; y += 400) {
          c.scrollTop = y; await new Promise((r) => setTimeout(r, 130)); hit = find();
        }
        tried.push({ cls: String(c.className).slice(0, 60), sh: c.scrollHeight, 滚动前li: before, 滚动后li: Array.from(document.querySelectorAll('li')).filter(vis).length });
      }
      if (!hit) {
        const all = Array.from(document.querySelectorAll('li')).filter(vis).map((e) => clean(e.innerText));
        return { ok: false, why: 'not_found', tried, li总数: all.length, li末10: all.slice(-10) };
      }
      for (const ev of ['mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: true, 选中文本: clean(hit.innerText), 输入框值: inp.value, tried };
    }, BRAND);
    log('④ 扫「' + BRAND + '」:', pick);
    await sleep(1500);

    log('⑤ 选品牌后:', await page.evaluate(catState));
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_catpage_brand.png') }).catch(() => {});

    // ⑥ 点「确认，下一步」
    const next = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const nb = Array.from(document.querySelectorAll('button')).filter(vis).find((b) => clean(b.innerText).includes('确认，下一步'));
      if (!nb) return { ok: false, why: 'no_next_btn' };
      if (nb.disabled) return { ok: false, why: 'still_disabled' };
      for (const ev of ['mousedown', 'mouseup', 'click']) nb.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      return { ok: true };
    });
    log('⑥ 点「确认，下一步」:', next);
    await sleep(15000);
    log('⑦ 落地:', await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const t = clean(document.body.innerText);
      const box = document.querySelector('#sell-field-p-20000');
      const brandVal = box ? Array.from(box.querySelectorAll('input')).map((i) => i.value).filter(Boolean)[0] : null;
      return {
        url: location.href.slice(0, 170),
        在表单: /publish\.htm/.test(location.href),
        catId: (location.search.match(/catId=(\d+)/) || [])[1] || null,
        当前类目: (t.match(/当前类目\s*\*?\s*([^\n]{0,70})/) || [])[1] || null,
        品牌值: brandVal,
        有提交按钮: t.includes('提交宝贝信息'),
      };
    }));
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_search_form.png') }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
