#!/usr/bin/env node
/**
 * 填「基础字段 + 必填属性」：**宝贝标题 / 导购标题 / 货号 / 主体材质 / 适用猫体型**。
 *
 * 值全部来自 `product.json`（= 素材包 excel，不猜）。属性**按页面上读到的属性名匹配 p-id**，
 * 所以换类目不用改脚本（id 是类目级的）。
 *
 * 幂等：每个字段先读回，已是目标值就跳过。失败会打印「在哪一步、为什么、候选是什么」。
 *
 * 用法：
 *   node scripts/tb_fill_basic.js --product output/MZB-001/product.json [--page-url <URL 子串>] [--dry]
 * 退出码：0 = 全部到位 / 1 = 有字段没填上（详见输出 JSON）
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
const PRODUCT_PATH = String(arg('product', 'output/MZB-001/product.json'));
const PAGE_URL = arg('page-url', null);
const DRY = !!arg('dry', false);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

const PRODUCT = JSON.parse(fs.readFileSync(path.resolve(PRODUCT_PATH), 'utf8'));
const ATTRS = PRODUCT.attributes || {};
// 淘宝标题限 30 汉字 = **60 字符（汉字按 2 字符算）** → 超了自动从尾部砍（用户 2026-10-10 指定）
function clampTitle(s) {
  let n = 0, out = '';
  for (const ch of String(s)) {
    const w = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (n + w > 60) break;
    n += w; out += ch;
  }
  return out.trim();
}
const TITLE_RAW = String(arg('title', PRODUCT.title || ''));
const TITLE = clampTitle(TITLE_RAW);
say('素材包给的：标题 =', TITLE);
say('属性 =', ATTRS);

// —— 读回属性区：属性名 → p-id / 控件类型 / 当前值 —— //
const readFields = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return Array.from(document.querySelectorAll('[id^="sell-field-p-"]')).map((box) => {
    const t = clean(box.innerText);
    const cls = String(box.className || '');
    const kind = ['combobox', 'select', 'checkbox', 'input', 'taoSirProp'].find((k) => new RegExp('(^|\\s)' + k).test(cls)) || '?';
    const label = ((t.replace(/^\*+/, '').split('重要')[0].trim().match(/^[^\s0-9/]+/) || [''])[0] || '').trim();
    const vals = Array.from(box.querySelectorAll('input')).filter(vis).map((i) => String(i.value || '')).filter(Boolean);
    // ⚠️ 读多选 tag 要**只取叶子文本**：一个 tag 里有 `.next-tag` / `.next-tag-body` / `.next-tag-close-btn`
    //    三层都匹配 `[class*=next-tag]` → 拿 `[class*=next-tag]` 会把 1 个值读成 3 个（实测：
    //    `已选择 2/49 项` 被读成 `户外/户外/阳台/阳台`）。→ 优先 `.next-tag-body`，没有才退回 `.next-tag`。
    const tagEls = Array.from(box.querySelectorAll('.next-tag-body'));
    const chips = (tagEls.length ? tagEls : Array.from(box.querySelectorAll('.next-tag,[class*=selection-item],[class*=SelectionItem]')))
      .map((e) => clean(e.innerText)).filter(Boolean);
    // 页面自己的多选计数（`已选择 2/49 项`）—— 最权威的读回，不受 tag DOM 结构影响
    const 已选计数 = (t.match(/已选择\s*(\d+)\s*\/\s*(\d+)\s*项/) || []).slice(1).join('/') || null;
    return { id: box.id, pid: (box.id.match(/p-(\d+)/) || [])[1] || null, kind, label, 输入值: vals[0] || null, chips: chips.slice(0, 6), 已选计数, 文本: t.slice(0, 50) };
  });
};

async function fillTitle(page, want) {
  return page.evaluate((v) => {
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const inp = Array.from(document.querySelectorAll('input')).filter(vis).find((i) => (i.getAttribute('placeholder') || '').includes('30个汉字'));
    if (!inp) return { ok: false, why: 'no_title_input' };
    if (inp.value === v) return { ok: true, already: true, 读回: inp.value };
    inp.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, v);
    for (const ev of ['input', 'change', 'blur']) inp.dispatchEvent(new Event(ev, { bubbles: true }));
    return { ok: true, 读回: inp.value, 字符数: inp.value.length };
  }, want);
}

async function fillInputByPid(page, pid, want) {
  return page.evaluate(({ pid, want }) => {
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const box = document.querySelector('#sell-field-p-' + pid);
    if (!box) return { ok: false, why: 'no_box' };
    // ⚠️ 同一个属性容器里可能有**子字段**（品牌 `p-20000` 与货号 `p-20000~1` 在同一个容器里）——
    //    直接取第一个 input 会拿到货号框，导致品牌值写错位（PE-001 实测：品牌被写成 PE木纹50cm）
    //    → 优先取 name **不带 `~`** 的主输入框
    const inp = Array.from(box.querySelectorAll('input')).filter(vis).find((i) => !/~/.test(i.getAttribute('name') || ''))
      || Array.from(box.querySelectorAll('input')).filter(vis).find((i) => !/~/.test(i.getAttribute('name') || ''))
      || Array.from(box.querySelectorAll('input')).filter(vis)[0];
    if (!inp) return { ok: false, why: 'no_input' };
    if (inp.value === want) return { ok: true, already: true, 读回: inp.value };
    inp.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, want);
    for (const ev of ['input', 'change', 'blur']) inp.dispatchEvent(new Event(ev, { bubbles: true }));
    return { ok: true, 读回: inp.value };
  }, { pid, want });
}

// ★ auto-complete 型下拉（**品牌**就是这种）：候选列表不可靠，但**直接在输入框打字 + 点空白触发**就生效
//   （用户 2026-10-10 验证：品牌框点一下 → 打「无品牌」→ 点空白 → 值就对了）
// ★ 点击前先查**遮挡**：品牌框在属性区中间，只要页面上还停着一个浮层（批量导入 / 上传结果 /
  //   平台公告等），真实鼠标点就会打在浮层上 → 字打不进去、读回为空。
  //   实测（同事反馈「品牌输入被残留遮罩挡住」）就是这么发生的。这里：先关遮挡物，再**重新取坐标**。
async function clearOverlayAt(page, x, y) {
  const info = await page.evaluate((p) => {
    const cls = (e) => String((e && e.getAttribute && e.getAttribute('class')) || '');
    const el = document.elementFromPoint(p.x, p.y);
    if (!el) return { blocked: false };
    // 命中的是 input / 它内部 → 没被挡
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || el.closest('#sell-field-p-20000')) return { blocked: false };
    const dlg = el.closest('.next-dialog,.next-overlay-wrapper,[class*=overlay],[class*=mask]');
    return { blocked: true, tag, cls: cls(el).slice(0, 50), inDialog: !!dlg, dialogText: dlg ? String(dlg.innerText || '').replace(/\s+/g, ' ').slice(0, 60) : null };
  }, { x, y }).catch(() => ({ blocked: false }));
  if (!info.blocked) return { ok: true, blocked: false };
  // 关掉遮挡物：优先按钮，兜底 Esc（注意：Esc 会顺手关掉规格抽屉，所以只在"确实被遮"时才按）
  let closed = false;
  const btn = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const b = Array.from(document.querySelectorAll('.next-dialog button,[class*=overlay] button')).filter(vis)
      .find((x) => /^(取消|关闭|知道了|好的|完成)/.test(clean(x.innerText)));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文案: clean(b.innerText) };
  }).catch(() => null);
  if (btn) {
    await page.mouse.click(btn.x, btn.y);
    closed = '点了「' + btn.文案 + '」';
  } else {
    await page.keyboard.press('Escape').catch(() => {});
    closed = '按了 Esc';
  }
  await sleep(1500);
  return { ok: true, blocked: true, 遮挡: info, 处理: closed };
}

async function pickAutoComplete(page, pid, want) {
  const locate = () => page.evaluate((p) => {
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const box = document.querySelector('#sell-field-p-' + p);
    if (!box) return null;
    const inputs = Array.from(box.querySelectorAll('input')).filter(vis);
    // ⚠️ 品牌(p-20000) 与货号(p-20000~1) 在同一个容器 → 取 name 不带 ~ 的那个
    const inp = inputs.find((i) => !/~/.test(i.getAttribute('name') || '')) || inputs[0];
    if (!inp) return null;
    inp.scrollIntoView({ block: 'center' });
    const r = inp.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 现: inp.value };
  }, pid);
  let c = await locate();
  if (!c) return { ok: false, why: 'no_input' };
  if (c.现 === want) return { ok: true, already: true, 读回: c.现 };
  // ★ 被遮 → 关遮挡物 → **重新取坐标**（关掉浮层后页面会回流，旧坐标失效）
  const ov = await clearOverlayAt(page, c.x, c.y);
  if (ov.blocked) {
    c = await locate();
    if (!c) return { ok: false, why: 'no_input_after_clear' };
    say('   品牌框原先被遮挡 → ' + ov.处理 + '，已重新取坐标');
  }
  await page.mouse.move(c.x, c.y);
  await sleep(200);
  await page.mouse.click(c.x, c.y);
  await sleep(1000);
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.type(String(want));
  await sleep(2000);
  // 有完全匹配的候选就点它（可省）
  await page.evaluate((w) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const hit = Array.from(document.querySelectorAll('.options-item,[class*=option-item],li')).filter(vis).find((e) => clean(e.innerText) === w);
    if (hit) for (const ev of ['mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
  }, want).catch(() => {});
  await sleep(600);
  // ★ 点空白触发 blur（不触发的话值不生效 —— 用户指路）
  const blank = await page.evaluate(() => {
    for (const p of [{ x: 1250, y: 60 }, { x: 300, y: 62 }]) {
      const el = document.elementFromPoint(p.x, p.y);
      if (el && !el.closest('input,textarea,select,button,a')) return p;
    }
    return { x: 1250, y: 60 };
  });
  await page.mouse.click(blank.x, blank.y);
  await sleep(900);
  const back = await page.evaluate((p) => {
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const box = document.querySelector('#sell-field-p-' + p);
    const inputs = box ? Array.from(box.querySelectorAll('input')).filter(vis) : [];
    const inp = inputs.find((i) => !/~/.test(i.getAttribute('name') || '')) || inputs[0];
    return inp ? inp.value : null;
  }, pid);
  return { ok: back === want, 读回: back };
}

// combobox / select：点开 → （有搜索框就过滤）→ 点 .options-item
async function pickOption(page, pid, want) {
  return page.evaluate(async ({ pid, want }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
    const box = document.querySelector('#sell-field-p-' + pid);
    if (!box) return { ok: false, why: 'no_box' };
    // ⚠️ 同一个属性容器里可能有**子字段**（品牌 `p-20000` 与货号 `p-20000~1` 在同一个容器里）——
    //    直接取第一个 input 会拿到货号框，导致品牌值写错位（PE-001 实测：品牌被写成 PE木纹50cm）
    //    → 优先取 name **不带 `~`** 的主输入框
    const inp = Array.from(box.querySelectorAll('input')).filter(vis).find((i) => !/~/.test(i.getAttribute('name') || ''))
      || Array.from(box.querySelectorAll('input')).filter(vis).find((i) => !/~/.test(i.getAttribute('name') || ''))
      || Array.from(box.querySelectorAll('input')).filter(vis)[0];
    if (!inp) return { ok: false, why: 'no_input' };
    // ⚠️ 现值要分两种读法：单选看 `input.value`；**多选（tag 型）的 `input.value` 恒为空**，
    //    值在 tag 里。只判 input.value 会把已选值**再点一次 = 取消**（实测踩过）。
    //    tag 取 `.next-tag-body`（一个 tag 有 tag/body/close-btn 三层，`[class*=next-tag]` 会读成 3 份）。
    const current = () => {
      const bodies = Array.from(box.querySelectorAll('.next-tag-body')).map((e) => clean(e.innerText)).filter(Boolean);
      if (bodies.length) return bodies;
      const tags = Array.from(box.querySelectorAll('.next-tag')).map((e) => clean(e.innerText)).filter(Boolean);
      if (tags.length) return tags;
      return inp.value ? [inp.value] : [];
    };
    if (current().includes(want)) return { ok: true, already: true, 现值: current().join('/') };
    if (inp.getAttribute('aria-expanded') !== 'true') {
      inp.focus();
      for (const ev of ['mousedown', 'mouseup', 'click']) inp.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      await sleep2(2000);
    }
    // 弹层可能重建 → 每次都用取值函数重新拿。
    // ⚠️ 弹层 class **不止一种**：实测表单页的多选/单选下拉是 `.sell-o-select-popup`
    //    （`next-overlay-inner next-select-popup-wrap sell-o-select-popup`），
    //    而老笔记里的 `.sell-o-select-options` 是类目页那套 → 都要认，且取**最后一个可见的**。
    const scopeOf = () => {
      const cands = Array.from(document.querySelectorAll('.sell-o-select-options,.sell-o-select-popup,.next-select-popup-wrap')).filter(vis);
      if (cands.length) return cands[cands.length - 1];
      const oc = document.querySelector('.options-content');
      return oc ? (oc.closest('div') || oc) : document;
    };
    let scope = scopeOf();
    const items = () => Array.from(scope.querySelectorAll('.options-item')).filter(vis);
    const hitOf = () => items().find((e) => clean(e.innerText) === want) || items().find((e) => clean(e.innerText).includes(want));

    // ① 先直接找（不少 combobox 展开后就有全量/推荐列表）
    let hit = hitOf();
    // ② 没命中才用弹层自带的搜索框过滤
    let usedSearch = false;
    const search = () => Array.from(scope.querySelectorAll('input')).filter(vis).find((i) => i !== inp && !box.contains(i));
    if (!hit && search()) {
      usedSearch = true;
      const s = search();
      s.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(s, want);
      s.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep2(2200);
      scope = scopeOf();
      hit = hitOf();
    }
    // ③ 仍没命中 → 滚 .options-content（长列表就是这种方式）
    if (!hit) {
      const cont = scope.querySelector('.options-content') || scope;
      if (cont && cont.scrollHeight > cont.clientHeight) {
        for (let y = 0; y <= cont.scrollHeight && !hit; y += 600) { cont.scrollTop = y; await sleep2(160); hit = hitOf(); }
        scope = scopeOf();
        hit = hitOf();
      }
    }
    if (!hit) {
      return {
        ok: false, why: 'option_not_found', 用过搜索: usedSearch, item数: items().length,
        候选: items().map((e) => clean(e.innerText)).slice(0, 24),
        弹层文本: clean(scope.innerText || '').slice(0, 180),
      };
    }
    for (const ev of ['mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
    await sleep2(1500);
    return { ok: true, 选中: clean(hit.innerText), 现值: current().join('/'), 读回: current().join('/') || inp.value };
  }, { pid, want });
}

// checkbox 组（多选）：点文本 == want 的那一项
async function pickCheckbox(page, pid, want) {
  return page.evaluate(async ({ pid, want }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
    const box = document.querySelector('#sell-field-p-' + pid);
    if (!box) return { ok: false, why: 'no_box' };
    const picked = () => Array.from(box.querySelectorAll('[class*=selection-item],[class*=SelectionItem]')).map((e) => clean(e.innerText)).filter(Boolean);
    if (picked().includes(want)) return { ok: true, already: true, 已选: picked() };
    const cands = Array.from(box.querySelectorAll('label,span,div,li')).filter(vis).filter((e) => clean(e.innerText) === want);
    if (!cands.length) {
      const more = Array.from(box.querySelectorAll('button,span,div')).filter(vis).find((e) => /更多|展开|全部/.test(clean(e.innerText)) && clean(e.innerText).length < 10);
      if (more) {
        for (const ev of ['mousedown', 'mouseup', 'click']) more.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        await sleep2(1200);
      }
      const again = Array.from(box.querySelectorAll('label,span,div,li')).filter(vis).filter((e) => clean(e.innerText) === want);
      if (!again.length) return { ok: false, why: 'option_not_found', 点过更多: !!more, 容器文本: clean(box.innerText).slice(0, 120) };
      cands.push(...again);
    }
    const el = cands[cands.length - 1];
    for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
    await sleep2(1300);
    return { ok: true, 已选: picked(), 容器文本: clean(box.innerText).slice(0, 80) };
  }, { pid, want });
}

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const pages = browser.contexts()[0].pages().filter((p) => /publish\.htm/.test(p.url()));
    let page = null;
    if (PAGE_URL) page = pages.find((p) => p.url().includes(String(PAGE_URL)));
    else page = pages.find((p) => !/fromAIImage=true/.test(p.url()));
    if (!page) {
      say('★ 找不到可用的发布页（publish.htm）—— 先跑 scripts/tb_enter_form.js');
      console.log(JSON.stringify({ ok: false, why: 'no_publish_page', 现有页: pages.map((p) => p.url().slice(0, 80)) }));
      process.exitCode = 1;
      return;
    }
    say('工作页:', page.url().slice(0, 96));

    // ★ 属性常被**折叠**（截图上那个「展开补充更多信息」「展开」）→ 先反复点开到没有为止，
    //    否则读不到、更填不上（PE木纹实测：15 个属性只读到 3 个）
    const expanded = await page.evaluate(async () => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const sl = (ms) => new Promise((r) => setTimeout(r, ms));
      const done = [];
      for (let pass = 0; pass < 5; pass++) {
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
    });
    say('①b 展开折叠区:', JSON.stringify(expanded));
    await sleep(1500);

    const fields = await page.evaluate(readFields);
    say('属性区块:', fields.map((f) => `${f.label}(p-${f.pid}|${f.kind})`).join('  '));
    const byLabel = (name) => fields.find((f) => f.label === name) || fields.find((f) => f.label.includes(name) || name.includes(f.label)) || null;
    // 兜底：不在属性区的属性（如「宝贝类型」「采购地」「图案」「材质」）→ 按属性名找最近的容器
    const fillByName = (name, val) => page.evaluate(async ({ n, v }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const sl = (ms) => new Promise((r) => setTimeout(r, ms));
      const cands = Array.from(document.querySelectorAll('div,label,span')).filter(vis)
        .filter((e) => new RegExp('^\\*?\\s*' + n + '(\\s|$)').test(clean(e.innerText)) && clean(e.innerText).length < 28);
      cands.sort((a, b) => a.innerText.length - b.innerText.length);
      const el = cands[0];
      if (!el) return { ok: false, why: 'no_box' };
      el.scrollIntoView({ block: 'center' });
      let p = el;
      let inp = null;
      for (let k = 0; k < 4 && p && !inp; k++) { inp = Array.from(p.querySelectorAll('input,textarea')).filter(vis)[0] || null; if (!inp) p = p.parentElement; }
      if (!inp) return { ok: false, why: 'no_input', 容器: clean(el.innerText).slice(0, 20) };
      if (inp.value === String(v)) return { ok: true, already: true, 读回: inp.value };
      const r = inp.getBoundingClientRect();
      inp.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, String(v));
      for (const ev of ['input', 'change', 'blur']) inp.dispatchEvent(new Event(ev, { bubbles: true }));
      await sl(400);
      return { ok: inp.value !== '', 填入: String(v), 读回: inp.value, 坐标: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } };
    }, { n: name, v: val });

    if (DRY) { console.log(JSON.stringify({ ok: true, dry: true, fields })); return; }

    const res = {};

    // ① 宝贝标题
    res['宝贝标题'] = TITLE ? await fillTitle(page, TITLE) : { ok: false, why: 'product.json 没有 title' };
    // ② 导购标题（素材包有才填）
    if (ATTRS['导购标题']) {
      res['导购标题'] = await page.evaluate((v) => {
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const inp = Array.from(document.querySelectorAll('input')).filter(vis).find((i) => (i.getAttribute('placeholder') || '').includes('15个汉字'));
        if (!inp) return { ok: false, why: 'no_input' };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, v);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: inp.value === v, 读回: inp.value };
      }, String(ATTRS['导购标题']));
    }
    // ③ 素材包给了的属性**逐个填**。
    // ⚠️ 不按容器 class 分堆：实测「适用猫体型」class 标着 `checkbox`，实际控件是**多选下拉**
    //    （容器里是 `next-select-trigger` + `next-select-arrow`，没有内联勾选项）→ 与 combobox 同样「点开下拉选 .options-item」。
    const INPUT_LIKE = new Set(['货号', '型号', '购买须知', '商家编码']);
    const missing = [];
    for (const [name, value] of Object.entries(ATTRS)) {
      // ★ 空值 = 用户明确不上这个属性 → 跳过。
      //   ⚠️ 绝不能拿空串去搜下拉：`includes('')` 恒真 → 会点中列表里的第一个选项（静默填错值）。
      if (value === null || value === undefined || String(value).trim() === '') { res[name] = { ok: true, 跳过: '空值（用户口径不上）' }; continue; }
      const f = byLabel(name);
      let r;
      if (!f) {
        r = await fillByName(name, value);           // 不在属性区 → 按属性名兜底
      } else if (name === '品牌') {
        r = await pickAutoComplete(page, f.pid, String(value));   // 品牌是 auto-complete 型
      } else if (INPUT_LIKE.has(name) || f.kind === 'input') {
        r = await fillInputByPid(page, f.pid, String(value));
      } else {
        // ★ 素材包口径：多值用**英文逗号**分隔（填写说明「多值内容 | 多个值使用英文逗号分隔」）。
        //   多选控件要**逐个值**分别点选 —— 把 `阳台,户外` 整串丢进搜索框只会得到「无选项」（实测踩到）。
        const vals = String(value).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        if (vals.length > 1) {
          const sub = [];
          for (const v of vals) sub.push(await pickOption(page, f.pid, v));
          r = { ok: sub.every((x) => x.ok), 多值: vals, 结果: sub };
        } else {
          r = await pickOption(page, f.pid, String(value));
        }
      }
      // ★ `no_box` = **本类目页面上没有这个属性**（素材包的属性集比现场表更宽，如实测地毯类目的
      //   「适用场景」页面上就没有）→ 不算失败，但要显式报出来，不能静默吞掉。
      //   例外：**过半**属性都找不到 → 多半是类目/页面不对，仍然判失败。
      if (!r.ok && r.why === 'no_box') { r = { ok: true, 跳过: '本类目页面上没有这个属性（未填）' }; missing.push(name); }
      res[name] = r;
    }
    if (missing.length) say('⚠ 页面上没有这些属性（已跳过、未填）：' + missing.join('、'));

    await sleep(1200);
    const after = await page.evaluate(readFields);
    const ok = Object.values(res).every((r) => r.ok) && missing.length <= Object.keys(ATTRS).length / 2;
    if (missing.length > Object.keys(ATTRS).length / 2) say('★ 过半属性在页面上找不到 → 疑似类目/页面不对，请核对');
    console.log('\n' + JSON.stringify({ ok, 结果: res, 读回: after.filter((f) => Object.keys(res).some((k) => k === f.label)) }, null, 1));
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
