#!/usr/bin/env node
/**
 * 填「下拉/单选类」类目属性（属性区里不是文本框的那些）。
 *
 * 为什么单独一个脚本：`tb_fill_basic.js` 的通用填法只覆盖文本框；
 * 下拉类（库存类型 / 功能 / 适用空间 / 风格 / 图案 / 材质 / 面层工艺 …）要
 * **先展开折叠区 → 按属性名找到下拉 → 真实鼠标点开 → 点选项 → 点空白触发**。
 *
 * 用法：node scripts/tb_fill_selects.js --product output/PE-001/product.json [--dry]
 * 退出码：0 = 全部填上 / 1 = 有没填上的（逐条打印候选，便于修）
 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, 'pwresolver.js'));
const { guardCheck } = require(path.join(__dirname, 'guard.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const PRODUCT = JSON.parse(fs.readFileSync(path.resolve(String(arg('product', 'output/MZB-001/product.json'))), 'utf8'));
const ATTRS = PRODUCT.attributes || {};
const DRY = !!arg('dry', false);
// 已经在属性区由 tb_fill_basic 处理过的（文本类）不在这里重复；这里只做"选择类"
const SKIP = new Set(['品牌', '货号', '型号', '购买须知', '商家编码']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

const expandAll = () => ({
  // 反复点开所有折叠入口
  js: async () => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const sl = (ms) => new Promise((r) => setTimeout(r, ms));
    const done = [];
    for (let pass = 0; pass < 6; pass++) {
      const cands = Array.from(document.querySelectorAll('div,span,a,button')).filter(vis)
        .filter((e) => /^(展开补充更多信息|展开|更多属性|查看更多|展开全部)$/.test(clean(e.innerText)));
      const el = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)))[0];
      if (!el) break;
      el.scrollIntoView({ block: 'center' });
      for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      done.push(clean(el.innerText));
      await sl(1500);
    }
    return done;
  },
});

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().filter((p) => /publish\.htm/.test(p.url()) && !/fromAIImage/.test(p.url())).pop();
    if (!page) { say('没有发布页'); process.exitCode = 1; return; }
    say('工作页:', page.url().slice(0, 90));
    say('展开折叠区:', JSON.stringify(await page.evaluate(expandAll().js)));
    await sleep(1500);

    const todo = Object.entries(ATTRS).filter(([k]) => !SKIP.has(k));
    say('待填属性:', todo.map(([k]) => k).join(' / '));

    const result = {};
    for (const [name, val] of todo) {
      // ① 找容器里那个"下拉触发框"
      const c = await page.evaluate((n) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const cands = Array.from(document.querySelectorAll('div,label')).filter(vis)
          .filter((e) => new RegExp('^\\*?\\s*' + n + '(\\s|$)').test(clean(e.innerText)) && clean(e.innerText).length < 34);
        cands.sort((a, b) => a.innerText.length - b.innerText.length);
        let box = cands[0];
        if (!box) return { ok: false, why: 'no_box' };
        box.scrollIntoView({ block: 'center' });
        let inp = Array.from(box.querySelectorAll('input')).filter(vis)[0];
        if (!inp) { let p = box.parentElement; for (let k = 0; k < 3 && p && !inp; k++) { inp = Array.from(p.querySelectorAll('input')).filter(vis)[0]; if (!inp) p = p.parentElement; } }
        if (!inp) return { ok: false, why: 'no_input', 容器: clean(box.innerText).slice(0, 24) };
        const r = inp.getBoundingClientRect();
        return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 现: inp.value, 只读: inp.readOnly };
      }, name);
      if (!c.ok) { result[name] = c; say(`✗ ${name}:`, c); continue; }
      if (!DRY) {
        await page.mouse.move(c.x, c.y);
        await sleep(200);
        await page.mouse.click(c.x, c.y);
        await sleep(1600);
      }
      // ② 弹层里选值
      const hit = DRY ? { ok: false, why: 'dry' } : await page.evaluate((v) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const pool = Array.from(document.querySelectorAll('li,[class*=option-item],[class*=menu-item],[class*=select-item]')).filter(vis);
        const h = pool.find((e) => clean(e.innerText) === v) || pool.find((e) => clean(e.innerText).includes(v)) || pool.find((e) => clean(e.innerText).includes(String(v).split('/')[0]));
        if (!h) return { ok: false, why: 'no_option', 候选: pool.map((e) => clean(e.innerText)).slice(0, 16) };
        for (const ev of ['mousedown', 'mouseup', 'click']) h.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        return { ok: true, 选中: clean(h.innerText).slice(0, 16) };
      }, String(val));
      if (!DRY) {
        await sleep(700);
        const blank = await page.evaluate(() => {
          for (const p of [{ x: 1250, y: 60 }, { x: 300, y: 62 }]) {
            const el = document.elementFromPoint(p.x, p.y);
            if (el && !el.closest('input,textarea,select,button,a')) return p;
          }
          return { x: 1250, y: 60 };
        });
        await page.mouse.click(blank.x, blank.y);
        await sleep(600);
      }
      result[name] = hit;
      say(`${hit.ok ? '✓' : '✗'} ${name} = ${val}`, hit.ok ? hit.选中 : JSON.stringify(hit));
    }
    const bad = Object.entries(result).filter(([, r]) => !r.ok).map(([k]) => k);
    console.log('\n' + JSON.stringify({ ok: bad.length === 0, 未填上: bad }, null, 1));
    process.exitCode = bad.length === 0 ? 0 : 1;
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
