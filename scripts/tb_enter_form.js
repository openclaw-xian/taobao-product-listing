#!/usr/bin/env node
/**
 * 入口段固化脚本：**搜索发品 → 按素材包路径选类目 → 本页选品牌 → 进 publish.htm 表单**。
 *
 * 为什么不能走「以图发品」：实测它会把上传的主图**自动铺进宝贝详情图**，
 * 与「主图 5 张 / 详情 20 张各自独立」的口径冲突（用户 2026-10-10 拍板弃用，SKILL 门禁 19）。
 *
 * 幂等：若店里已有「目标 catId 且不是以图发品来的」publish.htm 页 → **直接读回，不重开页**。
 *
 * 用法：
 *   node scripts/tb_enter_form.js --cat "宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板" [--brand 无品牌] [--port 9120]
 *   node scripts/tb_enter_form.js --cat "..." --list        # 只列出手上所有 publish.htm 页与状态，不动页面
 *   node scripts/tb_enter_form.js --cat "..." --force        # 忽略已有页面，重新走一遍入口
 *
 * 退出码：0 = 已就绪（读回通过）/ 1 = 失败（打印在哪一步、为什么）
 * 输出：最后一行是单行 JSON，便于被上层脚本解析。
 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, 'pwresolver.js'));
const { guardCheck } = require(path.join(__dirname, 'guard.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
// 可选：传 product.json → 类目页的**其它必填字段**（如墙纸类目的「货号」）也从这里取
const PRODUCT_PATH = arg('product', null);
// 中文参数在 PowerShell 里传 CLI 容易乱码 → 支持用环境变量 TB_CAT / TB_BRAND 传（Unicode API，可靠）
const BRAND = String(arg('brand', process.env.TB_BRAND || '无品牌'));
const CAT = String(arg('cat', process.env.TB_CAT || ''));
const LIST_ONLY = !!arg('list', false);
const FORCE = !!arg('force', false);
if (!CAT && !process.env.TB_CATID && !arg('catid', '')) { console.error('需要 --cat "<完整类目路径>"（用 > 或 >> 分隔），或 --catid <数字> + 环境变量 TB_CAT'); process.exit(2); }
const LEVELS = CAT.split(/>|>>/).map((s) => s.trim()).filter(Boolean);
const CATID = String(arg('catid', process.env.TB_CATID || ''));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => console.log(JSON.stringify(o));
const say = (...a) => console.log('  ' + a.join(' '));

// —— 读回：表单页 / 类目页 —— //
const formState = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const t = clean(document.body.innerText);
  const box = document.querySelector('#sell-field-p-20000');
  const brand = box ? Array.from(box.querySelectorAll('input')).map((i) => i.value).filter(Boolean)[0] : null;
  return {
    url: location.href.slice(0, 200),
    在表单: /publish\.htm/.test(location.href),
    catId: (location.search.match(/catId=(\d+)/) || [])[1] || null,
    来自以图发品: /fromAIImage=true/.test(location.href),
    当前类目: (t.match(/当前类目\s*\*?\s*([^\n]{0,70})/) || [])[1] || null,
    品牌值: brand || null,
    红框报错: (t.match(/请发布前修改以下出错项[^\n]{0,80}/) || [])[0] || null,
  };
};

const catPageState = () => {
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
    下一步disabled: nb ? !!nb.disabled : null,
    底部路径: (t.match(/类目[:：]?\s*([^\n]{0,80})/) || [])[0] || (t.match(/[\u4e00-\u9fa5]{2,}[^\n]{0,60}确认，下一步/) || [])[0] || null,
  };
};

// 点级联里的某一级（mousedown+mouseup+click —— el.click() 无效）
async function clickLevel(page, want) {
  return page.evaluate((lv) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const el = Array.from(document.querySelectorAll('li.category-item')).filter((e) => vis(e) && clean(e.innerText) === lv)[0];
    if (!el) return { ok: false, why: 'no_item', want: lv, 可见项: Array.from(document.querySelectorAll('li.category-item')).filter(vis).map((e) => clean(e.innerText)).slice(0, 12) };
    for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
    return { ok: true };
  }, want);
}

// 类目页选品牌：下拉自带的搜索框过滤 → 点 div.options-item
async function pickBrand(page, want) {
  return page.evaluate(async (b) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    // ⚠️ 不能只按 placeholder='请输入' 取**第一个**：类目页上「品牌」和「货号」用的是同一个 placeholder，
    //   取到第一个可能是货号框 → 品牌被写成货号的值（PE-001 实测：品牌变成 PE木纹50cm，用户三次指出）
    //   → 先限定在**品牌字段的容器**里找（#sell-field-p-20000，或文本以「品牌」开头且很短的容器）
    const outside = () => {
      const pop = document.querySelector('.sell-o-select-options');
      // ⚠️ 排除**子字段**：货号的 name 是 `p-20000~1`（与品牌同容器），品牌 name 为空
      const ok = (i) => (i.getAttribute('placeholder') || '') === '请输入' && !/~/.test(i.getAttribute('name') || '') && !(pop && pop.contains(i));
      const inBox = document.querySelector('#sell-field-p-20000');
      if (inBox) { const i2 = Array.from(inBox.querySelectorAll('input')).filter(vis).find(ok); if (i2) return i2; }
      const cands = Array.from(document.querySelectorAll('div,label')).filter(vis)
        .filter((e) => /^\*?\s*品牌(\s|$)/.test(clean(e.innerText)) && clean(e.innerText).length < 200);   // 品牌容器内含长提示语，放宽到 200
      cands.sort((a, b) => a.innerText.length - b.innerText.length);
      for (const c of cands) {
        let p = c;
        for (let k = 0; k < 3 && p; k++) {
          const i3 = Array.from(p.querySelectorAll('input')).filter(vis).find(ok);
          if (i3) return i3;
          p = p.parentElement;
        }
      }
      // 兜底：退回"第一个『请输入』"（可能取到货号框 → 品牌会写错；待现场 dump 类目页品牌框的真实 DOM 结构后再收紧）
      return Array.from(document.querySelectorAll('input')).filter(vis).find(ok) || null;
    };
    let inp = outside();
    if (!inp) return { ok: false, why: 'no_brand_input' };
    if (inp.value === b) return { ok: true, already: true, 品牌值: inp.value };
    if (inp.getAttribute('aria-expanded') !== 'true') {
      inp.focus();
      for (const ev of ['mousedown', 'mouseup', 'click']) inp.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      await new Promise((r) => setTimeout(r, 2500));
    }
    const pop = document.querySelector('.sell-o-select-options');
    if (!pop) return { ok: false, why: 'no_popup' };
    const search = Array.from(pop.querySelectorAll('input')).filter(vis)[0];
    if (!search) return { ok: false, why: 'no_search_input' };
    search.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(search, b);
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 2500));
    const items = Array.from(pop.querySelectorAll('.options-item')).filter(vis);
    const hit = items.find((e) => clean(e.innerText) === b) || items.find((e) => clean(e.innerText).includes(b));
    if (!hit) return { ok: false, why: 'option_not_found', 过滤后: items.map((e) => clean(e.innerText)).slice(0, 20) };
    for (const ev of ['mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
    await new Promise((r) => setTimeout(r, 1800));
    const after = outside();
    return { ok: true, 选中: clean(hit.innerText), 品牌值: after ? after.value : null };
  }, want);
}

async function nextStep(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const nb = Array.from(document.querySelectorAll('button')).filter(vis).find((b) => clean(b.innerText).includes('确认，下一步'));
    if (!nb) return { ok: false, why: 'no_next_btn' };
    if (nb.disabled) return { ok: false, why: 'still_disabled' };
    for (const ev of ['mousedown', 'mouseup', 'click']) nb.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
    return { ok: true };
  });
}

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const ctx = browser.contexts()[0];
    const pages = ctx.pages();

    // ① 手上已有的 publish.htm 页（顺便给用户看草稿）
    const forms = [];
    for (const p of pages) {
      if (!/publish\.htm/.test(p.url())) continue;
      const st = await p.evaluate(formState).catch(() => null);
      if (st) forms.push({ page: p, ...st });
    }
    say('手上的 publish.htm 页:', forms.length, '张');
    forms.forEach((f, i) => say(`  [${i}] catId=${f.catId} 品牌=${f.品牌值} ${f.来自以图发品 ? '(以图发品)' : '(搜索发品)'} ${f.url.slice(0, 60)}`));
    if (LIST_ONLY) { out({ ok: true, list: true, 表单页数: forms.length, 详情: forms.map(({ page, ...r }) => r) }); return; }

    // ② 幂等：已有「目标 catId 且不是以图发品来的」→ 直接读回
    if (!FORCE) {
      const hit = forms.find((f) => (!CATID || f.catId === CATID) && !f.来自以图发品);
      if (hit) {
        say('已有可用表单页 → 直接读回，不重开');
        const ok = (!CATID || hit.catId === CATID) && (!hit.品牌值 || hit.品牌值 === BRAND);
        const { page, ...st } = hit;
        out({ ok, reused: true, 步骤: 'reuse', 状态: st });
        if (!ok) say('⚠️ 品牌与目标不符（' + hit.品牌值 + ' vs ' + BRAND + '）→ 需要 --force 重走或手工改');
        process.exitCode = ok ? 0 : 1;
        return;
      }
    }

    // ③ 新开入口页走流程
    const page = await ctx.newPage();
    await page.goto('https://item.upload.taobao.com/sell/ai/category.htm', { waitUntil: 'load', timeout: 90000 });
    await sleep(20000);   // 冷启动/换机器后首次加载很慢（实测 8s 不够，级联树还没渲染）
    const enter = await page.evaluate(catPageState);
    say('① 入口页:', enter.在类目页 ? '在类目页 ✓' : '不在类目页 ✗', '| 下一步disabled =', enter.下一步disabled);

    for (const lv of LEVELS) {
      const r = await clickLevel(page, lv);
      say(`② 点级联「${lv}」:`, r.ok ? 'ok' : JSON.stringify(r));
      if (!r.ok) { out({ ok: false, 步骤: '类目级联', 层级: lv, ...r }); process.exitCode = 1; return; }
      await sleep(2500);
    }
    const afterCat = await page.evaluate(catPageState);
    say('③ 类目已选:', afterCat.底部路径, '| 下一步disabled =', afterCat.下一步disabled);

    let brandSkipped = false;   // 类目页无品牌字段时置 true → 落地判断不再要求表单页品牌值
    const brandRes = await pickBrand(page, BRAND);
    say('④ 选品牌:', JSON.stringify(brandRes));
    if (!brandRes.ok) {
      // ★ 不是所有类目都在类目页要品牌：实测**地毯类目（50000582）类目页根本没有品牌字段**
      //   （只有 3 个搜索框），且选完类目后「确认，下一步」就已点亮 —— 与墙纸类目
      //   （必须选品牌才亮，门禁 20）不同。这种情况不算失败：品牌留到表单页（#sell-field-p-20000）填。
      const st = brandRes.why === 'no_brand_input' ? await page.evaluate(catPageState) : null;
      if (st && st.下一步disabled === false) {
        brandSkipped = true;
        say('   类目页无品牌字段，但「确认，下一步」已点亮 → 本类目品牌非必选，跳过（品牌到表单页处理）');
      } else {
        out({ ok: false, 步骤: '品牌', ...brandRes, ...(st || {}) });
        process.exitCode = 1;
        return;
      }
    }
    await sleep(2000);

    // ④b ★ 有些类目这一步还有**别的必填字段**（实测：墙纸类目要求「★货号」，
    //     只填品牌时「确认，下一步」永远是灰的）→ 把 product.json 里的属性逐个填进空必填框
    if (PRODUCT_PATH) {
      const attrs = JSON.parse(require('fs').readFileSync(path.resolve(String(PRODUCT_PATH)), 'utf8')).attributes || {};
      const filled = await page.evaluate(async (want) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const sl = (ms) => new Promise((r) => setTimeout(r, ms));
        const out = [];
        const setVal = async (inp, val) => {
          inp.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(inp, String(val));
          for (const ev of ['input', 'change', 'blur']) inp.dispatchEvent(new Event(ev, { bubbles: true }));
          await sl(450);
        };
        for (const [label, val] of Object.entries(want)) {
          if (label === '品牌') continue;                            // 品牌要选下拉，单独处理
          // 容器定位：① 表单式 `#sell-field-p-*`；②（类目页）文本以「* <属性名>」开头的最近容器
          let box = Array.from(document.querySelectorAll('[id^="sell-field-p-"]')).find((b) => clean(b.innerText).includes(label));
          if (!box) {
            const cands = Array.from(document.querySelectorAll('div')).filter(vis)
              .filter((e) => new RegExp('^\\*?\\s*' + label).test(clean(e.innerText)) && clean(e.innerText).length < 20);
            cands.sort((a, b) => a.innerText.length - b.innerText.length);
            box = cands[0] || null;
          }
          if (!box) { out.push({ label, 跳过: '找不到容器' }); continue; }
          let inp = Array.from(box.querySelectorAll('input')).filter(vis)[0];
          if (!inp) {
            // label 与 input 常是**兄弟节点**（容器里只有 label 文本）→ 往上找几层
            let p = box.parentElement;
            for (let k = 0; k < 4 && p && !inp; k++) {
              inp = Array.from(p.querySelectorAll('input')).filter(vis)[0];
              if (!inp) p = p.parentElement;
            }
          }
          if (!inp) { out.push({ label, 跳过: '无输入框' }); continue; }
          if (inp.value === String(val)) { out.push({ label, 已是: val }); continue; }
          await setVal(inp, val);
          out.push({ label, 填入: String(val), 读回: inp.value });
        }
        return out;
      }, attrs);
      say('④b 类目页其它必填:', JSON.stringify(filled));
      // ④c ★ 类目页的这些框是**受控组件**，setter+event 会被清掉（实测货号 `0/42` 一直是空）
      //     → 用**真实鼠标点击 + 真实键盘输入**再填一遍
      for (const [label, val] of Object.entries(attrs)) {
        if (label === '品牌') continue;
        const c = await page.evaluate((lb) => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const cands = Array.from(document.querySelectorAll('div')).filter(vis)
            .filter((e) => new RegExp('^\\*?\\s*' + lb).test(clean(e.innerText)) && clean(e.innerText).length < 20);
          cands.sort((a, b) => a.innerText.length - b.innerText.length);
          let p = cands[0];
          for (let k = 0; k < 4 && p; k++) {
            const i = Array.from(p.querySelectorAll('input')).filter(vis)[0];
            if (i) { const r = i.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 现: i.value }; }
            p = p.parentElement;
          }
          return null;
        }, label);
        if (!c) continue;
        await page.mouse.click(c.x, c.y);
        await sleep(300);
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.type(String(val));
        await sleep(700);
        // ★ 用户指路：填完必须**点一下空白处**触发 blur/校验，否则「确认，下一步」不会变亮
        await page.keyboard.press('Tab').catch(() => {});
        await sleep(300);
        const blank = await page.evaluate(() => {
          for (const c of [{ x: 1250, y: 60 }, { x: 300, y: 62 }, { x: 1250, y: 950 }, { x: 260, y: 620 }]) {
            const el = document.elementFromPoint(c.x, c.y);
            if (el && !el.closest('input,textarea,select,button,a,label')) return c;
          }
          return { x: 1250, y: 60 };
        });
        await page.mouse.click(blank.x, blank.y);
        await sleep(1000);
        const back = await page.evaluate((lb) => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const t = clean(document.body.innerText);
          const m = t.match(new RegExp(lb + '\\s*(\\d+)/(\\d+)'));
          return m ? m[0] : null;
        }, label);
        say(`④c 真实输入「${label}」= ${val} → 页面计数 ${back}`);
      }
      await sleep(1200);
    }
    const afterBrand = await page.evaluate(catPageState);
    say('⑤ 品牌后: 品牌值 =', afterBrand.品牌值, '| 下一步disabled =', afterBrand.下一步disabled);

    if (afterBrand.下一步disabled) {
      out({ ok: false, 步骤: '下一步', why: 'still_disabled', 状态: afterBrand });
      process.exitCode = 1;
      return;
    }
    const nx = await nextStep(page);
    say('⑥ 点「确认，下一步」:', JSON.stringify(nx));
    await sleep(15000);
    // ★ 收尾：关掉**其它** publish.htm 页 —— 多个发布页并存时，后续脚本"取第一个页面"会拿到错的商品
    //   （实测踩到：PE-001 的 SKU 导进了猫抓板的页面）
    try {
      const others = browser.contexts()[0].pages().filter((x) => x !== page && /publish\.htm/.test(x.url()));
      for (const o of others) await o.close().catch(() => {});
      if (others.length) say('8) 关闭其它发布页: ' + others.length);
    } catch (e) { /* 忽略 */ }
    const st = await page.evaluate(formState);
    say('⑦ 落地:', st.url.slice(0, 90));
    const ok = st.在表单 && (!CATID || st.catId === CATID) && (brandSkipped || st.品牌值 === BRAND) && !st.红框报错;
    out({ ok, 步骤: 'done', 状态: st, 期望: { catId: CATID || 'any', 品牌: brandSkipped ? '（类目页无此字段，表单页处理）' : BRAND } });
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { out({ ok: false, 步骤: 'exception', why: e.message }); process.exit(1); });
