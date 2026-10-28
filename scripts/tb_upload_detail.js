#!/usr/bin/env node
/**
 * 上传「宝贝详情」图（20 张）。
 *
 * 链路（= 主图那套 + 详情特有的一步，2026-10-10 实测）：
 *   ① 图文描述区「添加」→「图片」→ 打开图片空间面板（同一个 `sucai-selector-ng`）
 *   ② 「本地上传」一次喂多张（filechooser 支持数组）
 *   ③ **关掉「上传结果」对话框**（点它右下角「完成」）—— 不关会盖住列表、认错卡片
 *   ④ 列表里**按文件名逐张**真实鼠标点击（**多选累加**，底部「确定」按钮会变成「确定(N)」）
 *   ⑤ 点底部 **`Footer…` 的「确定(N)」** → 详情图铺上
 *   ⑥ 读回 `lite-decoration-editor` 里的 img 数
 *
 * ⚠️ 一律用真实鼠标坐标点击（`page.mouse.click`）；Playwright 元素点击在这个 iframe 里无效。
 *
 * 用法：node scripts/tb_upload_detail.js --dir output/MZB-001/img/detail [--limit 20]
 * 退出码：0 = 详情 img 数达到预期 / 1 = 有问题
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
const DIR = path.resolve(String(arg('dir', 'output/MZB-001/img/detail')));
const LIMIT = parseInt(String(arg('limit', '20')), 10);
const FORCE_UPLOAD = !!arg('force-upload', false);   // 空间里可能已有部分图 → 默认探测，可强制全传
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

// ★ `--skip N`：跳过前 N 张。用途 = **分批做完整闭环**：一次喂太多会被截断（实测 26 张只进 18 张），
//   而正确的做法是「每批上传→自动全选→点确定」各自走完，再跑下一批（skip 掉已传的）。
const SKIP = parseInt(String(arg('skip', '0')), 10);
const ALLFILES = fs.readdirSync(DIR).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
const files = ALLFILES.slice(SKIP, SKIP + LIMIT);
say(`目录共 ${ALLFILES.length} 张，本次取第 ${SKIP + 1}~${SKIP + files.length} 张`);
if (!files.length) process.exit(2);

// ⚠️ 排除主图那组面板（name = `mainImagesGroup`）：它是 max=1 模式、底部**没有「确定」**。
//   ★ 这里**绝不兜底取它** —— 原来找不到别的就退回到第一个 sucai iframe，于是主图面板残留时
//   详情步会挂到它上面（footer 读不到、上传入口不可用）→ 整步全崩。找不到就返回 null，
//   由 ⓪b 先把残留面板关掉再开正确的那一个。
const findPanel = (page) => {
  const cands = page.frames().filter((f) => /sucai-selector-ng/.test(f.url())).filter((f) => f.name() !== 'mainImagesGroup');
  return cands.length ? cands[cands.length - 1] : null;
};
const iframeGeom = (page) => page.evaluate(() => {
  const f = Array.from(document.querySelectorAll('iframe')).filter((x) => /sucai-selector-ng/.test(x.src || '')).pop();
  if (!f) return null;
  const r = f.getBoundingClientRect();
  return { left: r.left, top: r.top };
});
const editorImgs = (page) => page.evaluate(() => {
  const ed = document.querySelector('[class*="lite-decoration-editor"]');
  return ed ? ed.querySelectorAll('img').length : null;
});
// 面板底部：确定按钮文本 + 已选数
const footer = (fr) => fr.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /^确定/.test(clean(x.innerText)));
  return b ? { 文本: clean(b.innerText), disabled: !!b.disabled } : { 文本: null, disabled: null };
});
// 底部「确定（N）」里的已选数 —— **N 是权威判据**（别用 class 猜已选，见下）
const selCount = async (fr) => {
  const t = (await footer(fr)).文本 || '';
  const m = String(t).match(/[（(](\d+)[)）]/);
  return m ? parseInt(m[1], 10) : 0;
};
// ★ 面板 iframe 会被**重建**（长跑实测抛 `Frame was detached`）→ 这两个读取口**每次按 page 重新解析**，
//   解析不到就短暂重试；绝不复用可能已 detach 的 frame 句柄。
async function panelFooter(page) {
  for (let k = 0; k < 3; k++) {
    const fr = findPanel(page);
    if (!fr) { await sleep(1000); continue; }
    try { return await footer(fr); } catch (e) { await sleep(1000); }
  }
  return { 文本: null, disabled: null };
}
async function panelSelCount(page) {
  const t = (await panelFooter(page)).文本 || '';
  const m = String(t).match(/[（(](\d+)[)）]/);
  return m ? parseInt(m[1], 10) : 0;
}
// ★ 等面板 iframe **真正就绪**：刚打开的一瞬间句柄会失效（抛 `Frame was detached`），
//   判据 = **连续两次**能读到底部按钮文本（读不到或抛错就重新计时）。实测不等待会连崩三轮。
// ★ 关掉**任何**残留素材面板（含主图那组 `mainImagesGroup`：它 max=1、底部没有「确定」，
//   残留下来会让详情步挂错面板）。实测这一条是「详情图整步崩」的根因。
async function closeStalePanel(page) {
  const anyPanel = () => page.frames().filter((f) => /sucai-selector-ng/.test(f.url()));
  if (!anyPanel().length) return false;
  say('⓪b 有残留素材面板（' + anyPanel().map((f) => f.name() || '(无名)').join(',') + '）→ 先关掉');
  for (let i = 0; i < 3; i++) {
    const c = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /^(取消|关闭)/.test(clean(x.innerText)));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }).catch(() => null);
    if (!c) break;
    await page.mouse.click(c.x, c.y).catch(() => {});
    await sleep(2000);
    if (!anyPanel().length) { say('   已关掉 ✓'); return true; }
  }
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(1800);
  say(anyPanel().length ? '   ★ 面板仍关不掉（继续尝试开正确面板）' : '   已关掉 ✓');
  return !anyPanel().length;
}

async function waitPanelReady(page, timeoutMs = 90000) {
  const t0 = Date.now();
  let stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    const fr = findPanel(page);
    if (fr) {
      try {
        const st = await footer(fr);
        if (st && st.文本 !== null) { stable++; if (stable >= 2) return true; } else stable = 0;
      } catch (e) { stable = 0; }
    } else stable = 0;
    await sleep(2500);
  }
  return false;
}
// 找目标卡片 → **在 iframe 内给它打 id**（精确定位：只含这一个文件名的最近祖先）→ Playwright 元素点击
// （笔记 §7/门禁 10 记的就是"Playwright 点 img"——元素点击在这套图片空间里是可行的；
//   而"鼠标坐标点击"在面板已有选中项时会失效，实测）
async function pickCard(page, fr, fname) {
  const marked = await fr.evaluate(async (n) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const sl = (ms) => new Promise((r) => setTimeout(r, ms));
    const mark = () => {
      const imgs = Array.from(document.querySelectorAll('img')).filter(vis).filter((e) => { const r = e.getBoundingClientRect(); return r.width >= 60 && r.height >= 60; });
      for (const img of imgs) {
        let p = img;
        for (let k = 0; k < 6 && p; k++) {
          p = p.parentElement;
          if (!p) break;
          const t = clean(p.innerText);
          if (!t.includes(n)) continue;
          // 这层只含**一个**文件名 ⇒ 就是卡片本体（避免匹配到含多张的网格容器）
          const names = Array.from(new Set((t.match(/[\w\u4e00-\u9fa5.-]+\.(jpg|jpeg|png)/gi) || []).map((x) => x.toLowerCase())));
          if (names.length === 1) {
            const old = document.getElementById('tb-pick');
            if (old) old.removeAttribute('id');
            p.id = 'tb-pick';
            return { ok: true, 卡片: t.slice(0, 26), 层: k };
          }
        }
      }
      return null;
    };
    let r = mark();
    if (!r) {
      const list = document.querySelector('[class*="PicturesShow_main"]') || document.scrollingElement;
      list.scrollTop = 0; await sl(300); r = mark();
      for (let y = 0; !r && y <= list.scrollHeight; y += 400) { list.scrollTop = y; await sl(250); r = mark(); }
    }
    return r || { ok: false, why: 'no_card' };
  }, fname);
  if (!marked.ok) return { ok: false, ...marked };
  const clicked = await fr.locator('#tb-pick').first().click({ force: true, timeout: 8000 }).then(() => true).catch((e) => e.message.slice(0, 80));
  return { ok: clicked === true, 卡片: marked.卡片, 元素点击: clicked };
}

// ★ 用面板搜索框定位一张图：输入文件名 + 回车 → 返回卡片在 iframe 内的坐标。
//   为什么这么做：① 逐张滚动找卡片会为每张滚完整个列表（几千张）→ 极慢；
//   ② 搜索能把目标图顶到第一行（实测 placeholder = 「搜索图片名称」）。
async function findCardBySearch(page, frIn, fname) {
  // ⚠️ 面板 iframe 会被**重建**：刚打开那一下 iframe 还在初始化，句柄随即失效
  //   （实测抛 `Frame was detached`；而"上一轮遗留、已就绪"的面板就不会）→ 每次重新解析 + 重试 3 轮。
  for (let attempt = 0; attempt < 3; attempt++) {
    const fr = findPanel(page) || frIn;
    if (!fr) { await sleep(1500); continue; }
    try {
      const searched = await fr.evaluate((n) => {
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const i = Array.from(document.querySelectorAll('input')).filter(vis)
          .find((x) => /搜索图片名称|请输入文件名称|搜索/.test(x.getAttribute('placeholder') || ''));
        if (!i) return { ok: false, why: 'no_search_input' };
        i.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(i, n);
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true };
      }, fname);
      if (!searched.ok) return searched;
      await page.keyboard.press('Enter').catch(() => {});
      await sleep(4500);
      const fr2 = findPanel(page) || fr;
      const found = await fr2.evaluate((n) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const cands = Array.from(document.querySelectorAll('div,li')).filter(vis).filter((e) => {
          const t = clean(e.innerText);
          if (!t.includes(n)) return false;
          const names = Array.from(new Set((t.match(/[\w\u4e00-\u9fa5.-]+\.(jpe?g|png|gif|webp)/gi) || []).map((x) => x.toLowerCase())));
          return names.length === 1;                       // 这一层只含一个文件名 ⇒ 卡片本体
        });
        cands.sort((a, b) => a.innerText.length - b.innerText.length);
        const e = cands[0];
        if (!e) return { ok: false, why: 'no_card' };
        // ★ 真正可点的是卡片**右上角的勾选框** `.next-checkbox`（与规格图面板「点右上角小框」同一套路）。
        //   实测：点文件名标题那层**选不中**（底部「确定」一直 disabled，白点 26 次），点勾选框才有效。
        const box = e.querySelector('.next-checkbox') || (e.parentElement && e.parentElement.querySelector('.next-checkbox')) || null;
        const target = box || e.querySelector('img') || e;
        const r = target.getBoundingClientRect();
        return { ok: true, 卡片: clean(e.innerText).slice(0, 30), 勾选框: !!box, t: { x: r.left + r.width / 2, y: r.top + r.height / 2 } };
      }, fname);
      // 第一次没找到 → 再等一会儿重搜一次（搜索是异步的，3~4s 有时不够 → 假阴性）
      if (found.ok) return found;
      await sleep(3500);
      const fr3 = findPanel(page) || fr2;
      const again = await fr3.evaluate((n) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const cands = Array.from(document.querySelectorAll('div,li')).filter(vis).filter((e) => {
          const t = clean(e.innerText);
          if (!t.includes(n)) return false;
          const names = Array.from(new Set((t.match(/[\w\u4e00-\u9fa5.-]+\.(jpe?g|png|gif|webp)/gi) || []).map((x) => x.toLowerCase())));
          return names.length === 1;
        });
        cands.sort((a, b) => a.innerText.length - b.innerText.length);
        const e = cands[0];
        if (!e) return { ok: false, why: 'no_card_retry' };
        const box = e.querySelector('.next-checkbox') || (e.parentElement && e.parentElement.querySelector('.next-checkbox')) || null;
        const target = box || e.querySelector('img') || e;
        const r = target.getBoundingClientRect();
        return { ok: true, 卡片: clean(e.innerText).slice(0, 30), 勾选框: !!box, t: { x: r.left + r.width / 2, y: r.top + r.height / 2 } };
      }, fname).catch(() => ({ ok: false, why: 'no_card_retry' }));
      return again.ok ? again : found;
    } catch (e) {
      say(`   （第 ${attempt + 1} 次遇到 frame 重建，重试）`);
      await sleep(2500);
    }
  }
  return { ok: false, why: 'frame_detached_x3' };
}

const existsBySearch = async (page, fr, fname) => (await findCardBySearch(page, fr, fname)).ok;

// ★★ 勾选的主力路径：**不用搜索框**，扫当前可见的卡片 → 点它右上角的勾选框 → 需要时往下滚一屏。
//   为什么放弃搜索：实测「输入文件名 + 回车」会让素材选择器的 iframe **重载**（第一个文件之后每张都抛
//   `Frame was detached`，26 张全崩）。而刚上传的图本来就在列表最前面，扫一两屏就够。
//   `已选` 用底部「确定（N）」的数字兜底判定（见调用处）。
async function selectByVisibleScan(page, wantSet, maxScrolls = 14) {
  const picked = new Set();
  for (let s = 0; s <= maxScrolls && picked.size < wantSet.size; s++) {
    let fr = findPanel(page);
    if (!fr) { await sleep(1500); continue; }
    let cards = null;
    try {
      cards = await fr.evaluate(() => {
        const clean = (x) => (x || '').replace(/\s+/g, ' ').trim();
        const out = [];
        document.querySelectorAll('[class*="PicList_PicturesShow_main-show"]').forEach((card) => {
          const t = clean(card.innerText);
          const m = t.match(/[\w\u4e00-\u9fa5.-]+\.(jpe?g|png|gif|webp)/i);
          if (!m) return;
          const box = card.querySelector('.next-checkbox');
          const inp = card.querySelector('.next-checkbox input');
          const checked = inp ? !!inp.checked : /checked/i.test(String(box && box.className));
          const img = card.querySelector('img');
          const el = box || img || card;
          const r = el.getBoundingClientRect();
          const ir = img ? img.getBoundingClientRect() : r;
          if (r.width === 0 && ir.width === 0) return;      // 完全没渲染
          out.push({ name: m[0], box: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, imgTop: ir.top, 已选: checked });
        });
        const list = document.querySelector('[class*="PicturesShow_main"]');
        return { cards: out, 滚动: list ? { top: list.scrollTop, ch: list.clientHeight, sh: list.scrollHeight } : null };
      });
    } catch (e) {
      await sleep(1800);
      continue;                                          // frame 被重建 → 下一轮重扫
    }
    if (!cards) continue;
    for (const c of cards.cards) {
      if (!wantSet.has(c.name) || picked.has(c.name)) continue;
      // ★★ 已经勾上的**绝不点** —— 点一下就是「取消勾选」。
      //    实测教训：上传后面板会自动全选，脚本却抢在计数生效前以为「已选 0」，
      //    于是逐张去点，把自动全选**一张张取消掉**（用户在屏幕上看到的就是这个）。
      if (c.已选) { picked.add(c.name); continue; }
      if (c.box.x < 0 || c.box.y < 0 || c.box.y > 2000) continue;   // 不在可视区就不点
      const g = await iframeGeom(page);
      if (!g) break;
      await page.mouse.click(Math.round(g.left + c.box.x), Math.round(g.top + c.box.y));
      picked.add(c.name);
      await sleep(350);
    }
    if (picked.size >= wantSet.size) break;
    try {
      await (findPanel(page) || fr).evaluate(() => {
        const l = document.querySelector('[class*="PicturesShow_main"]');
        if (l) l.scrollTop += Math.max(200, l.clientHeight - 140);
      });
    } catch (e) { /* ignore */ }
    await sleep(1200);
  }
  return picked;
}

// ★ 勾选一张图：搜索定位 + **真实鼠标坐标点**。判定用底部「确定（N）」的数字（它才是权威）。
async function selectBySearch(page, fr, fname) {
  const card = await findCardBySearch(page, fr, fname);
  if (!card.ok) return card;
  const hit = await mouseClickIn(page, card.t.x, card.t.y);
  return { ok: !!hit, 卡片: card.卡片, 坐标: hit.abs };
}

// 面板内：按文件名找缩略图（必要时滚动列表），返回 iframe 内坐标
async function findCard(fr, fname) {
  return fr.evaluate(async (n) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const sl = (ms) => new Promise((r) => setTimeout(r, ms));
    const list = document.querySelector('[class*="PicturesShow_main"]') || document.scrollingElement;
    // ★ 认图必须**从大 img 往上找祖先**：文件名文本与 img 是**兄弟节点**，
    //   早先"从文本往下找 img"会点到错元素（点了却没选中）—— 2026-10-10 实测修正
    const pick = () => {
      const imgs = Array.from(document.querySelectorAll('img')).filter(vis).filter((e) => { const r = e.getBoundingClientRect(); return r.width >= 60 && r.height >= 60; });
      for (const img of imgs) {
        let p = img;
        for (let k = 0; k < 5 && p; k++) {
          p = p.parentElement;
          if (!p) break;
          if (clean(p.innerText).includes(n)) {
            const r = img.getBoundingClientRect();
            // 已选中？→ 主循环要**跳过**（再点一次会取消选中）
            const sel = /select|checked|active/i.test(String(p.className)) || !!p.querySelector('[class*=selected],[class*=checked]');
            return { ok: true, cx: r.left + r.width / 2, cy: r.top + r.height / 2, 卡片: clean(p.innerText).slice(0, 30), 已选: sel };
          }
        }
      }
      return null;
    };
    let hit = pick();
    if (!hit && list) {
      list.scrollTop = 0; await sl(300); hit = pick();
      for (let y = 0; !hit && y <= list.scrollHeight; y += 400) { list.scrollTop = y; await sl(250); hit = pick(); }
      if (!hit) { list.scrollTop = 0; await sl(200); }
    }
    return hit || { ok: false, why: 'no_card' };
  }, fname);
}
// 鼠标坐标点 iframe 内某点（顺带回读"该坐标实际命中了哪个元素"——若被遮挡就能看出来）
async function mouseClickIn(page, x, y) {
  const g = await iframeGeom(page);
  if (!g) return { ok: false, why: 'no_geom' };
  const abs = { x: Math.round(g.left + x), y: Math.round(g.top + y) };
  const hit = await page.evaluate((p) => {
    const e = document.elementFromPoint(p.x, p.y);
    return e ? e.tagName.toLowerCase() + '.' + String(e.className).slice(0, 46) : null;
  }, abs).catch(() => null);
  await page.mouse.move(abs.x, abs.y);
  await sleep(250);
  await page.mouse.click(abs.x, abs.y);
  return { ok: true, abs, geom: { left: Math.round(g.left), top: Math.round(g.top) }, 命中: hit };
}

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { say('★ 找不到发布页'); process.exitCode = 1; return; }
    say('工作页:', page.url().slice(0, 90), '| 起始详情 img =', await editorImgs(page));

    // ⓪b ★ 先关掉**任何**残留素材面板（含主图那组 `mainImagesGroup`：max=1、底部没有「确定」）。
    //   实测这是「详情图整步崩」的根因：主图步失败后面板留在页面上，详情步挂到它上面，
    //   footer 读不到、上传入口不可用 → 26 张全崩。
    await closeStalePanel(page);

    // ⓪ 面板若停在「已选中待确定」状态（底部「确定（N）」）→ 这种状态下点击会被吞。
    //   ⚠️ 原来这里**刷新页面**复位，注释还写着「淘宝会自动存草稿，刷新后恢复」—— **实测是错的**：
    //   2026-10-13 一次 reload 后标题 / 属性 / 99 行 SKU / 主图 / 26 张详情图**全部不见了**，
    //   页面变成一张全新的空表单（草稿虽然在箱里，但**不会被自动回填**）→ 白干一小时。
    //   所以这里**绝不刷新**：能点「确定(N)」就点（把已选的提交掉），否则直接停手让用户处理。
    {
      const fr0 = findPanel(page);
      if (fr0) {
        const st = await footer(fr0);
        if (/[（(]\d+[)）]/.test(String(st.文本 || ''))) {
          say('⓪ 面板停在「' + st.文本 + '」（待确定）→ 点「确定」把它提交掉');
          const c = await fr0.evaluate(() => {
            const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /^确定/.test(clean(x.innerText)));
            if (!b || b.disabled) return null;
            const r = b.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }).catch(() => null);
          if (c) { await mouseClickIn(page, c.x, c.y); await sleep(5000); say('   已提交，详情 img =', await editorImgs(page)); }
          else { say('★ 面板停在待确定状态且点不动「确定」→ 不刷新（刷新会丢全部内容），请人工关掉面板后重跑'); process.exitCode = 1; return; }
        }
      }
    }

    // ① 打开面板：添加 → 图片
    const opened = await page.evaluate(`(async () => {
      const clean=(s)=>(s||'').replace(/\\s+/g,' ').trim();
      const vis=(e)=>{if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
      const sl=(ms)=>new Promise(r=>setTimeout(r,ms));
      if (document.querySelectorAll('iframe').length && Array.from(document.querySelectorAll('iframe')).some(f=>/sucai-selector-ng/.test(f.src||''))) return {ok:true,already:true};
      const add=[...document.querySelectorAll('div,span,button,a')].filter(vis).filter(e=>clean(e.innerText)==='添加');
      const a=add.filter(e=>!add.some(o=>o!==e&&e.contains(o)))[0];
      if(!a) return {ok:false,why:'no_add'};
      a.scrollIntoView({block:'center'});
      for(const ev of ['mousedown','mouseup','click']) a.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window}));
      await sl(2000);
      const pics=[...document.querySelectorAll('[class*="add_item"],[class*="add-item"],div,span,li')].filter(vis).filter(e=>clean(e.innerText)==='图片');
      const p=pics.filter(e=>!pics.some(o=>o!==e&&e.contains(o)))[0];
      if(!p) return {ok:false,why:'no_pic_item'};
      for(const ev of ['mousedown','mouseup','click']) p.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window}));
      return {ok:true,点了:['添加','图片']};
    })()`);
    say('① 打开详情图面板:', opened);
    // ★ 刚打开的 iframe 还在初始化，句柄会随即失效 → **轮询到它就绪**再往下做
    const ready = await waitPanelReady(page, 90000);
    say('   面板就绪:', ready);
    let fr = findPanel(page);
    if (!fr) { say('★ 面板没开'); process.exitCode = 1; return; }
    say('   面板:', fr.name() || '(无名)', '| 底部:', await footer(fr));

    // ② 决定传哪些。
    // ★ 默认**直接传**：原来默认走「逐张按文件名搜索」查存在性 —— 实测那条路极脆
    //   （搜索会让 iframe 重载 → `Frame was detached`），而且它省下的只是"图片空间里多个副本"这点小事。
    //   要省副本才加 `--check-exists`；`--force-upload` 也直接传（语义更明确）。
    const CHECK_EXISTS = !!arg('check-exists', false);
    let toUpload = files.slice();
    if (FORCE_UPLOAD || !CHECK_EXISTS) {
      say(`② 直接上传 ${files.length} 张${FORCE_UPLOAD ? '（--force-upload）' : ''}`);
    } else {
      const missing = [];
      for (const f of files) {
        fr = findPanel(page) || fr;
        if (!(await existsBySearch(page, fr, f))) missing.push(f);
      }
      toUpload = missing;
      say(`② 图片空间里已有 ${files.length - missing.length} 张，待上传 ${missing.length} 张` +
        (missing.length ? `：${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}` : ''));
    }
    if (toUpload.length) {
      // ★ 分批上传：一次喂 26 张（15.5MB）会被**中途打断** —— 实测只进了 18 张、
      //   剩下 8 张静默丢失（面板不报错、底部也不提示）。所以按批喂，并按张数给上传时间。
      const BATCH = parseInt(String(arg('batch', '12')), 10);
      for (let i = 0; i < toUpload.length; i += BATCH) {
        const chunk = toUpload.slice(i, i + BATCH);
        const paths = chunk.map((f) => path.join(DIR, f));
        // ★★ 每批最多试 3 次：**触发"自动全选"的是"上传动作"本身** —— 实测有时不触发
        //   （底部停在「确定」灰着、已选 0），这时**把同一批再传一次**通常就触发了。
        //   不拿"逐张点勾选框"当主力：点已勾选的框 = 取消勾选（实测就是这么把全选一张张取消掉的）。
        let 选中 = 0;
        for (let attempt = 1; attempt <= 3; attempt++) {
          const p1 = page.waitForEvent('filechooser', { timeout: 12000 }).catch(() => null);
          await fr.locator('button:has-text("本地上传")').first().click({ force: true, timeout: 8000 }).catch(() => {});
          const ch = await p1;
          let how = 'filechooser';
          if (ch) {
            await ch.setFiles(paths);
          } else {
            await sleep(2000);
            const n = await fr.locator('input[type=file]').count().catch(() => 0);
            if (!n) {
              // ★ 不要在这里中止：图很可能**本来就在**图片空间（存在性判断是搜索式的，会有假阴性）。
              say('⚠ 上传入口不可用（面板可能停在"已选中待确定"状态）→ 跳过上传，直接进入勾选环节');
              break;
            }
            await fr.locator('input[type=file]').first().setInputFiles(paths);
            how = 'input[type=file]×' + n;
          }
          say(`② 批次 ${Math.floor(i / BATCH) + 1}/${Math.ceil(toUpload.length / BATCH)} · 第 ${attempt} 次：上传 ${chunk.length} 张（${how}）`);
          await sleep(6000 + chunk.length * 1500);   // 按张数等（12 张 ≈ 24s）

          // ③ 关掉「上传结果」（点右下角「完成」）
          const done = await fr.evaluate(() => {
            const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /^完成$/.test(clean(x.innerText)));
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }).catch(() => null);
          if (done) await mouseClickIn(page, done.x, done.y);
          else say('   （没看到「上传结果」的完成按钮，可能已自动关）');
          await sleep(3000);

          say('   批次后底部:', await panelFooter(page));
          选中 = await panelSelCount(page);
          if (选中 > 0) break;
          say('   ⚠ 这一批没触发自动全选（已选 0）→ 重传同一批（第 ' + (attempt + 1) + ' 次）');
        }
        // ★ 一旦自动全选已经齐了，**立刻收工去点确定**，别再做任何多余动作
        if (选中 >= files.length) {
          say('   ✓ 自动全选已齐，停止上传，直接去点「确定」');
          break;
        }
      }
    }

    // ④ 逐张勾选：**以底部「确定（N）」的数字变化为准**
    //    （早先 `[class*=selected]` 判"已选"会命中左侧文件夹树的 `next-selected` → 每张都误判成已选）
    // ★ 上传后面板**有时**会自动全选（那就直接点确定）；但实测 2026-10-13 这单没有（已选 0），
    //   所以**不再赌它**：数量不够就逐张勾，用「搜索框定位 + 真实鼠标点」而不是滚动找卡片（后者极慢）。
    //   `--no-select` 可跳过这一步（只上传不勾选）。
    let selN = await panelSelCount(page);
    // ★★ 上传完成后**先等底部计数稳定**再决定要不要逐张勾：自动全选是**延迟生效**的，
    //    抢在它生效前把「已选 26」误读成 0，就会去逐张点 → 把自动全选一张张取消掉（实测踩到）。
    if (selN < files.length) {
      let last = -1; let same = 0;
      for (let k = 0; k < 12 && same < 3; k++) {
        await sleep(1500);
        const n = await panelSelCount(page);
        if (n === last) same++; else { same = 0; last = n; }
        if (n > selN) selN = n;
      }
    }
    say(`④ 上传后底部: 已选 ${selN} / 期望 ${files.length}（已等自动全选稳定）`);
    let okCount = selN; const rec = [];
    const NO_SELECT = !!arg('no-select', false);
    const SEARCH_FALLBACK = !!arg('search-fallback', false);   // 搜索兜底默认关：它会触发 iframe 重载
    if (!NO_SELECT && selN < files.length) {
      // ① 主力路径：**不用搜索框**，扫可见卡片 + 点勾选框（快且稳；已勾选的会跳过）
      const picked = await selectByVisibleScan(page, new Set(files));
      await sleep(1200);
      okCount = Math.max(okCount, await panelSelCount(page));
      say('④a 扫可见卡片勾选', picked.size, '张 → 底部已选', okCount, '/', files.length);
      // ② 兜底：仍没勾上的才用「搜索定位 + 点勾选框」（慢，且可能触发 iframe 重载）→ 默认关
      const 还差 = SEARCH_FALLBACK ? files.filter((f) => !picked.has(f)) : [];
      if (还差.length) say('④b 还有', 还差.length, '张走搜索兜底:', 还差.slice(0, 6).join(', '));
      for (const f of 还差) {
        if (okCount >= files.length) break;
        let n0 = await panelSelCount(page);
        let pick = await selectBySearch(page, findPanel(page) || fr, f);
        if (!pick.ok) {
          await sleep(1500);                              // frame 被重建时重试一次
          n0 = await panelSelCount(page);
          pick = await selectBySearch(page, findPanel(page) || fr, f);
        }
        if (!pick.ok) { rec.push({ f, r: pick.why || '没找到卡片' }); continue; }
        await sleep(1500);
        let n1 = await panelSelCount(page);
        if (n1 === n0 - 1) {
          // 点下去把原有的选中取消了 ⇒ 这张本来就已选 → 补点回来
          await selectBySearch(page, findPanel(page) || fr, f);
          await sleep(1500);
          n1 = await panelSelCount(page);
          rec.push({ f, r: '本就已选(已补回)', n: n1 });
        } else if (n1 > n0) {
          rec.push({ f, r: '新选中', n: n1 });
        } else {
          rec.push({ f, r: '计数未变', n: n1 });
        }
        okCount = n1;
        if (rec.length % 6 === 0) say('   进度', rec.length, '| 已选', n1, '|', JSON.stringify(rec.slice(-1)[0]));
      }
    }
    const beforeConfirm = await panelFooter(page);
    say('④ 底部:', beforeConfirm, '（已选', okCount, '/ 期望', files.length, '）');
    const 没勾上的 = rec.filter((x) => x.r !== '新选中' && x.r !== '本就已选(已补回)');
    if (没勾上的.length) say('   ⚠ 没勾上的:', JSON.stringify(没勾上的.slice(0, 10)));

    // ⑤ 点「确定(N)」
    const confirm = await (async () => {
      for (let k = 0; k < 3; k++) {
        const f2 = findPanel(page);
        if (!f2) { await sleep(1000); continue; }
        try { return await f2.evaluate(() => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /^确定/.test(clean(x.innerText)));
          if (!b) return { ok: false, why: 'no_confirm' };
          if (b.disabled) return { ok: false, why: 'disabled', 文本: clean(b.innerText) };
          const r = b.getBoundingClientRect();
          return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, 文本: clean(b.innerText) };
        }); } catch (e) { await sleep(1200); }
      }
      return { ok: false, why: 'no_panel' };
    })();
    say('⑤ 底部确定按钮:', confirm);
    if (confirm.ok) {
      await mouseClickIn(page, confirm.x, confirm.y);
      await sleep(6000);
    }

    const finalImgs = await editorImgs(page);
    say('⑥ 详情编辑器 img =', finalImgs, '（起始 +', files.length, ' 张 → 期望', finalImgs, '）');
    console.log('\n' + JSON.stringify({ ok: !!confirm.ok, 点了: okCount, 期望: files.length, 详情img: finalImgs }, null, 1));
    process.exitCode = confirm.ok ? 0 : 1;
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
