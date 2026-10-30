#!/usr/bin/env node
/**
 * **填充「规格图」**（= 编辑规格抽屉里每个规格值旁的图片位；与 playbook §7.5「批量填充规格主图」一致）。
 *
 * 链路（2026-10-10 实测）：
 *   ① 勾过「编辑规格 → 颜色分类 → ☑添加图片」并「确认创建」后，抽屉里每个规格值旁出现
 *      `sell-color-option-image-upload`（32px 图位，空态 `sell-color-option-image-empty`）
 *   ② 点图位 → 打开「批量填充规格主图」：右侧规格值可多选、左侧素材区、底部确定
 *   ③ 逐个颜色：右侧选中该颜色 12 个规格值 → 左侧点「猫抓布规格图-<颜色>.jpg」→ 填充
 *   ④ 点「确定」→ 抽屉里点「确认创建」
 *
 * 用法：
 *   $env:TB_COLOR="米白"; node scripts/tb_fill_spec_images.js --dir output/MZB-001/img/spec     # 单色试
 *   node scripts/tb_fill_spec_images.js --dir output/MZB-001/img/spec --confirm                  # 全量 + 确认创建
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
const DIR = path.resolve(String(arg('dir', 'output/MZB-001/img/spec')));
const ONLY = arg('color', process.env.TB_COLOR || null);
const CONFIRM = !!arg('confirm', false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

// 颜色顺序**从 product.json 读**（面板里的规格值顺序 = product.json 的 colors 顺序）；
// 没有 --product 或读不到时才退回到 MZB-001 的默认顺序
const PRODUCT_PATH = path.resolve(String(arg('product', 'output/MZB-001/product.json')));
let PRODUCT = {};
try { PRODUCT = JSON.parse(fs.readFileSync(PRODUCT_PATH, 'utf8')); } catch (e) { /* 用默认 */ }
let COLORS = ['米白', '卡其', '黑色', '浅灰', '深蓝', '深棕'];
if (Array.isArray(PRODUCT.colors) && PRODUCT.colors.length) COLORS = PRODUCT.colors.map(String);
// ★ 显式映射：素材包 Excel 的「规格图片文件名」列（tb_build.py 带进 product.json 的 spec_images）。
//   比下面的「文件名包含颜色名」可靠 —— 实测颜色值是长营销文案（含 emoji / `/` / 空格）时，
//   按子串永远猜不中，而且这种值也做不了文件名。
const SPEC_MAP = PRODUCT.spec_images || {};
const picked = ONLY ? [String(ONLY)] : COLORS;
// ★ 判据放宽（2026-10-14 同事实测踩到）：原来只认 `/规格图-.*\.(jpe?g|png)$/` ——
//   ① 文件名里必须带「规格图-」，同事素材包按自己习惯命名（`卡其色.jpg`）就被**整批过滤掉**；
//   ② 扩展名漏了 webp/bmp/gif。
//   现在：**任何图片文件都收**；只是「带规格图-、或命中 product.json 映射」的排在前面优先用。
const IMG_EXT = /\.(jpe?g|png|webp|bmp|gif)$/i;
const allImgs = fs.readdirSync(DIR).filter((f) => IMG_EXT.test(f));
const specFiles = allImgs.slice().sort((a, b) => {
  const sa = /规格图-/.test(a) ? 0 : 1;
  const sb = /规格图-/.test(b) ? 0 : 1;
  return sa - sb || a.localeCompare(b);
});
if (!allImgs.length) {
  console.log(`  ★ 规格图片目录里没有图片（${DIR}）→ 这一步会空转`);
} else if (!specFiles.some((f) => /规格图-/.test(f))) {
  console.log(`  ⚠ 规格图片目录里 ${allImgs.length} 张图**都不含「规格图-」字样**：将按颜色名匹配 / product.json 映射来找图。`);
  console.log(`     更稳的做法：文件名写成 \`<商品号>规格图-<颜色>.jpg\`，或在素材包 Excel 的「规格图片文件名」列里逐 SKU 写明。`);
}
const fileOf = (c) => {
  const m = SPEC_MAP[c];
  if (m) {
    if (allImgs.includes(m)) return m;
    const mBase = String(m).toLowerCase();
    const hit = allImgs.find((f) => f.toLowerCase() === mBase || f.toLowerCase().includes(mBase) || mBase.includes(f.toLowerCase()));
    if (hit) return hit;
    console.log(`  ⚠ product.json 指定的规格图不在目录里：${m}（回退按颜色名匹配）`);
  }
  // 颜色名匹配：先找带「规格图-」的，再退到任意文件名
  const byColor = allImgs.filter((f) => f.includes(c));
  return byColor.find((f) => /规格图-/.test(f)) || byColor[0] || (allImgs.length === 1 ? allImgs[0] : undefined);
};
if (Object.keys(SPEC_MAP).length) console.log(`  规格图映射：product.json 指定了 ${Object.keys(SPEC_MAP).length} 个颜色`);

const drawerState = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const d = Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis)[0];
  const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
  const slots = d ? Array.from(d.querySelectorAll('.sell-color-option-image-upload')).filter(vis) : [];
  return {
    抽屉在: !!d,
    图位总数: slots.length,
    已有图: slots.filter((e) => e.querySelector('img')).length,
    空图位: slots.filter((e) => !e.querySelector('img')).length,
    面板: dlg ? clean(dlg.innerText).slice(0, 200) : null,
    面板计数: dlg ? ((clean(dlg.innerText).match(/(\d+)\s*\/\s*(\d+)/) || []).slice(1).join('/') || null) : null,
    面板SKU项: dlg ? dlg.querySelectorAll('li.sku-item').length : 0,
  };
};

// 打开编辑规格抽屉
async function openDrawer(page) {
  const c = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    if (Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis).length) return { already: true };
    const pool = Array.from(document.querySelectorAll('button,a,span,div')).filter(vis).filter((e) => clean(e.innerText) === '编辑规格');
    const el = pool.filter((e) => !pool.some((o) => o !== e && e.contains(o)))[0];
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  if (!c) return { ok: false, why: 'no_btn' };
  if (c.already) return { ok: true, already: true };
  await page.mouse.move(c.x, c.y);
  await sleep(250);
  await page.mouse.click(c.x, c.y);
  await sleep(5000);
  return { ok: true };
}

// 点**第一个空图位** → 打开「批量填充规格主图」
// （不按文本找图位：规格值文本与图位不在同一条祖先链上，实测 `no_slot`）
async function openFillPanel(page) {
  const c = await page.evaluate(() => {
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const d = Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis)[0];
    if (!d) return null;
    const slot = Array.from(d.querySelectorAll('.sell-color-option-image-upload')).filter(vis).find((e) => !e.querySelector('img'));
    if (!slot) return null;
    slot.scrollIntoView({ block: 'center' });
    const r = slot.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  if (!c) return { ok: false, why: 'no_empty_slot' };
  await page.mouse.move(c.x, c.y);
  await sleep(250);
  await page.mouse.click(c.x, c.y);
  await sleep(5000);
  return { ok: true, 点: c };
}

const materialFrame = (page) => page.frames().filter((f) => /sucai-selector-ng|handleId=/.test(f.url())).pop();

// ★ 先把**本商品**的规格图传进图片空间 —— 不然搜索会命中**别的商品的同名图**
//   （实测踩到：MZB-003 的图没上传，搜「猫抓布规格图-米白」命中的是 MZB-001 那张）
async function uploadSpecs(page) {
  const fr = materialFrame(page);
  if (!fr) return { ok: false, why: 'no_frame' };
  // ★ 只上传**这一步实际要用到**的那些图（不要整个目录全传：目录里可能有几十张，
  //   全传既慢又会在图片空间里堆无用图）。
  const need = Array.from(new Set(picked.map((c) => fileOf(c)).filter(Boolean)));
  const paths = need.map((f) => path.join(DIR, f));
  const [ch] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 12000 }).catch(() => null),
    fr.locator('button:has-text("本地上传")').first().click({ force: true, timeout: 8000 }).catch(() => {}),
  ]);
  if (ch) await ch.setFiles(paths);
  else {
    await sleep(2000);
    const n = await fr.locator('input[type=file]').count().catch(() => 0);
    if (!n) return { ok: false, why: 'no_upload_entry' };
    await fr.locator('input[type=file]').first().setInputFiles(paths);
  }
  await sleep(11000);
  // 关掉「上传结果」对话框（它会盖住列表）
  const g = await page.evaluate(() => {
    const f = Array.from(document.querySelectorAll('iframe')).filter((x) => /handleId=|sucai-selector-ng/.test(x.src || '')).pop();
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  const done = await fr.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /^完成$/.test(clean(x.innerText)));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }).catch(() => null);
  if (done && g) { await page.mouse.click(Math.round(g.left + done.x), Math.round(g.top + done.y)); await sleep(3500); }
  return { ok: true, 上传: paths.length };
}

// ★ 用户指路：**在搜索框里输入文件名 + 回车** → 列表立刻过滤出那一张（完整可见、小框好点）
//   这比滚动找图靠谱得多（列表 144 张，规格图在最底部）
async function searchInPanel(page, kw) {
  const fr = materialFrame(page);
  if (!fr) return { ok: false, why: 'no_frame' };
  const r = await fr.evaluate((k) => {
    const vis = (e) => { if (!e) return false; const rect = e.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const inp = Array.from(document.querySelectorAll('input')).filter(vis)
      .find((i) => /搜索图片名称|请输入文件名称|搜索/.test(i.getAttribute('placeholder') || ''));
    if (!inp) return { ok: false, why: 'no_search_input' };
    inp.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, k);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    for (const ev of ['keydown', 'keyup', 'keypress']) inp.dispatchEvent(new KeyboardEvent(ev, { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return { ok: true, 输入框值: inp.value };
  }, kw);
  // 双保险：在页面层再按一次回车（焦点已在 iframe 的搜索框上）
  await page.keyboard.press('Enter').catch(() => {});
  await sleep(3000);
  return r;
}

// 面板右侧"已填上图的条目数" —— 用它判断"这一下点进去没有"（自适应节奏的判据）
const filledCount = async (page) => page.evaluate(() => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
  if (!dlg) return -1;
  const items = Array.from(dlg.querySelectorAll('li.sku-item')).filter(vis);
  return items.filter((e) => { const c = e.querySelector('.sku-image-container'); return c && c.querySelector('img'); }).length;
});

// ★ 用户指路的正确点法：点**图片右上角的小框**（不是图片本体）。
//   · 点一下 = 填入「当前规格值」并**自动跳到下一个值**；
//   · 同一张图要继续给下一个值用时，必须**先点一次取消、再点一次选中**（实测怪癖）。
async function clickImageBox(page, name, times) {
  const g = await page.evaluate(() => {
    const f = Array.from(document.querySelectorAll('iframe')).filter((x) => /handleId=|sucai-selector-ng/.test(x.src || '')).pop();
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  const fr = materialFrame(page);
  if (!g || !fr) return { ok: false, why: 'no_frame' };
  const pos = await fr.evaluate(async (n) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const sl = (ms) => new Promise((r) => setTimeout(r, ms));
    // ⚠️ 判"可见"必须用**在 iframe 视口内**（宽高>0 不够：元素可以在滚动容器可视区之外仍满足，
    //    实测拿到 y=956 这种视口外坐标 → 点空）
    const inView = (r) => r.top > 6 && r.bottom < innerHeight - 6 && r.left > 0 && r.right < innerWidth;
    const find = () => {
      const imgs = Array.from(document.querySelectorAll('img')).filter(vis).filter((e) => { const r = e.getBoundingClientRect(); return r.width >= 50 && r.height >= 50; });
      for (const img of imgs) {
        let p = img;
        for (let k = 0; k < 6 && p; k++) {
          p = p.parentElement;
          if (!p) break;
          const txt = clean(p.innerText);
          if (!txt.includes(n)) continue;
          // ⚠️ 必须"这一层**只含这一个文件名**" —— 否则会命中「包含整个列表」的容器，
          //    结果点到列表第一张（实测点成了主图 main_0x，用户当场发现）
          const names = Array.from(new Set((txt.match(/[\w\u4e00-\u9fa5.-]+\.(jpg|jpeg|png)/gi) || []).map((x) => x.toLowerCase())));
          if (names.length !== 1) continue;
          const r = img.getBoundingClientRect();
          if (!inView(r)) continue;
          return { ok: true, x: Math.round(r.right - 9), y: Math.round(r.top + 9), 卡片文件名: names[0], 顶部: Math.round(r.top) };
        }
      }
      return null;
    };
    // ⚠️ 规格图排在**列表最底部**（144 张图里规格图最早上传）→ 直接滚到底再往上找最快。
    //    步长必须**远小于视口高**（这里 120 < 383）：步长太大时图总是"跨在视口边界上"、
    //    永远不满足"完整可见" → 大量点击落空（实测 72 次只落 24 个的真因）。
    const list = document.querySelector('[class*="PicturesShow_main"]') || document.scrollingElement;
    let r = find();
    if (!r && list) {
      list.scrollTop = list.scrollHeight; await sl(500); r = find();
      for (let y = list.scrollHeight; !r && y >= 0; y -= 120) { list.scrollTop = y; await sl(200); r = find(); }
    }
    return r || { ok: false };
  }, name);
  if (!pos.ok) return { ok: false, why: 'no_img' };
  for (let i = 0; i < times; i++) {
    await page.mouse.move(Math.round(g.left + pos.x), Math.round(g.top + pos.y));
    await sleep(200);
    await page.mouse.click(Math.round(g.left + pos.x), Math.round(g.top + pos.y));
    await sleep(900);
  }
  return { ok: true, 点了几次: times, 小框: { x: pos.x, y: pos.y } };
}

// 列出面板里某颜色的规格值文本（顺序 = 抽屉里图位顺序）
async function listValues(page, color) {
  return page.evaluate((col) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
    if (!dlg) return [];
    return Array.from(dlg.querySelectorAll('li.sku-item')).map((e) => clean(e.innerText)).filter((t) => t.startsWith(col + '-'));
  }, color);
}

// 点**某一项**（点项内那个 36px 图区 → 单选选中；这是实测能生效的点法）
async function clickItem(page, val) {
  const c = await page.evaluate((v) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
    if (!dlg) return { ok: false, why: 'no_dialog' };
    const el = Array.from(dlg.querySelectorAll('li.sku-item')).find((e) => clean(e.innerText) === v);
    if (!el) return { ok: false, why: 'no_item' };
    const box = el.querySelector('.sku-image-container') || el;
    box.scrollIntoView({ block: 'center' });
    const r = box.getBoundingClientRect();
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 点前已选: /selected/i.test(String(box.className)) };
  }, val);
  if (!c.ok) return c;
  await page.mouse.move(c.x, c.y);
  await sleep(140);
  await page.mouse.click(c.x, c.y);
  return { ok: true, 点前已选: c.点前已选 };
}

// ★ 面板自己写着口径：**「选中右侧销售属性值后，点击左侧图片可完成批量填充/删除」**。
//   两层规格下右侧列的是**独立的颜色值**（没有 `-尺寸` 后缀），而且**默认只选中第 1 项** ——
//   原脚本用 `startsWith(颜色 + '-')` 一个都匹配不上，于是从没点过右侧，
//   每次点图都填到了「默认选中的那 1 个值」上 → 9 个图位被同一张图覆盖（实测唯一 src 只有 2 个）。
//   所以要：① 读右侧当前选中态；② 只保留目标那一项被选中（多选就先把别的取消）；③ 再点左侧图片。
async function readRightState(page, color) {
  return page.evaluate((col) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const cls = (e) => String((e && e.getAttribute && e.getAttribute('class')) || '');
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const dlgs = Array.from(document.querySelectorAll('.next-dialog')).filter(vis);
    const dlg = dlgs[dlgs.length - 1];
    if (!dlg) return { ok: false, why: 'no_dialog' };
    const items = Array.from(dlg.querySelectorAll('li.sku-item')).filter(vis);
    const info = items.map((e) => {
      const box = e.querySelector('.sku-image-container') || e;
      const r = e.getBoundingClientRect();
      return { 文本: clean(e.innerText), 已选: /selected/i.test(cls(box)) || /selected/i.test(cls(e)), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    const target = info.find((x) => x.文本 === col) || info.find((x) => x.文本.startsWith(col));
    if (!target) return { ok: false, why: 'no_item', 候选: info.map((x) => x.文本.slice(0, 14)).slice(0, 10) };
    return { ok: true, 项数: info.length, 已选: info.filter((x) => x.已选), 目标: target };
  }, color);
}

async function clickAt(page, x, y) {
  await page.mouse.move(x, y);
  await sleep(140);
  await page.mouse.click(x, y);
  await sleep(800);
}

async function selectRightValue(page, color) {
  for (let k = 0; k < 5; k++) {
    const st = await readRightState(page, color);
    if (!st.ok) return st;
    const 目标已选 = st.目标.已选;
    const 别的 = st.已选.filter((x) => x.文本 !== st.目标.文本);
    if (目标已选 && 别的.length === 0) return { ok: true, 单选: st.目标.文本.slice(0, 20) };
    if (别的.length) { await clickAt(page, 别的[0].x, 别的[0].y); continue; }   // 先取消别的（多选情形）
    if (!目标已选) { await clickAt(page, st.目标.x, st.目标.y); continue; }       // 再选中目标
  }
  return { ok: false, why: 'cannot_single_select' };
}

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { say('★ 找不到发布页'); process.exitCode = 1; return; }
    say('工作页:', page.url().slice(0, 90));

    say('① 打开编辑规格抽屉:', await openDrawer(page));
    await sleep(2000);
    const st0 = await page.evaluate(drawerState);
    say('   抽屉状态:', { 图位总数: st0.图位总数, 空图位: st0.空图位, 已有图: st0.已有图 });

    // ★ 只打开**一次**面板：面板的"当前规格值"随点图**自动前进**（列表顺序 = 72 个规格值）。
    //   ⚠️ 千万别每种颜色都重开面板 —— 重开会把"当前值"重置回**列表第 1 项**，
    //      于是第二色起会把图填到第一色的值上（实测踩到：卡其轮把米白的值覆盖了）。
    const op = await openFillPanel(page);
    say('② 打开填充面板:', op);
    if (!op.ok) { say('   ✗ 面板打不开'); process.exitCode = 1; return; }
    await sleep(2500);
    if (!materialFrame(page)) { say('   ✗ 左侧素材区没出现（没有 iframe）'); process.exitCode = 1; return; }
    // ★ 先把本商品的规格图传进图片空间（否则搜索会命中别的商品的同名图 —— 实测踩到）
    say('②b 上传本商品规格图:', await uploadSpecs(page));
    await sleep(1500);

    for (const color of picked) {
      const f = fileOf(color);
      if (!f) { say(`   ✗ 没有「${color}」的图`); continue; }
      const nm = path.basename(f, '.jpg');
      // ① 先把这张图**搜索**到列表最前面（否则它在最底部，滚过去又容易只露一半 → 小框点不中）
      const s = await searchInPanel(page, nm);
      await sleep(1200);
      // ② 再把右侧「这个颜色」选成**唯一选中**（面板口径：选中右侧值 → 点左侧图片）
      //    放在搜索之后，免得搜索把右侧的选中态冲掉。
      const sel = await selectRightValue(page, color);
      say(`   [${color.slice(0, 12)}] 搜图「${nm}」:${s.ok ? 'ok' : JSON.stringify(s)} | 右侧选中:`, sel);
      if (!sel.ok) { say(`   ✗ 右侧选不中这个颜色，跳过（不留错误映射）`); continue; }
      // ③ 点一次那张图 → 只填到已选中的这个值上
      const before = await filledCount(page);
      await clickImageBox(page, nm, 1);
      await sleep(1000);
      let after = await filledCount(page);
      if (after <= before) { await clickImageBox(page, nm, 1); await sleep(1100); after = await filledCount(page); }
      say(`     点图后 面板已填 ${before} → ${after}`);
      const st = await page.evaluate(drawerState);
      say(`   ${color.slice(0, 12)} 填完:`, { 已有图: st.已有图, 空图位: st.空图位 });
    }

    // 点面板「确定」
    const okb = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
      if (!dlg) return { ok: false, why: 'no_dialog' };
      const b = Array.from(dlg.querySelectorAll('button')).filter(vis).find((x) => /^确定/.test(clean(x.innerText)));
      if (!b || b.disabled) return { ok: false, 文本: b ? clean(b.innerText) : null };
      const r = b.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文本: clean(b.innerText) };
    });
    if (okb.ok) { await page.mouse.click(okb.x, okb.y); say('③ 点面板「确定」:', okb.文本); await sleep(4000); }
    else say('③ 确定按钮:', okb);

    const fin = await page.evaluate(drawerState);
    say('③ 结束状态:', { 图位总数: fin.图位总数, 已有图: fin.已有图, 空图位: fin.空图位 });
    if (CONFIRM) {
      const cb = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const pool = Array.from(document.querySelectorAll('button,span,div,a')).filter(vis).filter((e) => clean(e.innerText) === '确认创建');
        const el = pool.filter((e) => !pool.some((o) => o !== e && e.contains(o)))[0];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (cb) { await page.mouse.click(cb.x, cb.y); await sleep(7000); say('④ 点「确认创建」→ 抽屉在?', (await page.evaluate(drawerState)).抽屉在); }
      else say('④ 没找到「确认创建」');
    } else say('④ （未加 --confirm，没点「确认创建」）');
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
