#!/usr/bin/env node
/**
 * 按笔记攻 1:1 主图：
 *  · §4：点空位 → iframe `sucai-selector-ng` → 「本地上传」上传 → `max=1` 一次选一张填一个槽
 *  · §9（详情图同款面板）：「在『全部图片』列表里**按文件名搜索、逐张点击**」
 *  → 所以「认图」要**按文件名**（不是靠列表顺序、也不是靠 `t=` 时间戳 —— 那两个我都试错了）
 *
 * 做法：上传这张 → 在 iframe 列表里**按文件名找到那张卡片**（必要时滚动列表）→ 取它 img 的中心
 *      → **真实鼠标坐标点击**（元素点击在这个 iframe 里无效）→ 校验空槽数 -1。
 *
 * 用法：node tests/upload_by_name.js [--skip 1] [--limit 1]
 * 日志：tests/_upload_name.log
 */
const path = require('path');
const fs = require('fs');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));
const { guardCheck } = require(path.join(__dirname, '..', 'scripts', 'guard.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = process.env.TB_PORT || '9120';
const DIR = path.resolve(String(arg('dir', 'output/MZB-001/img/1x1')));
const SKIP = parseInt(String(arg('skip', '0')), 10);
const LIMIT = parseInt(String(arg('limit', '1')), 10);
const LOG = path.join(__dirname, '_upload_name.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== upload_by_name ${new Date().toISOString()} skip=${SKIP} limit=${LIMIT} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

const files = fs.readdirSync(DIR).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
const picked = files.slice(SKIP, SKIP + LIMIT);
log('全部:', files.join(', '), '| 本次:', picked.join(', '));

const findPanel = (page) => page.frames().find((f) => /sucai-selector-ng/.test(f.url()));

// ★ 失败退出前**必做**：把残留的素材面板关掉。否则下一步脚本检测到"已有素材 iframe"会误判
//   "面板已开"，拿到的是**上一步那个面板**（实测：详情步拿到主图面板 mainImagesGroup，
//   底部没有「确定」→ 上传入口不可用 → 详情图整步全崩）。
async function closeResidualPanel(page) {
  const panels = () => page.frames().filter((f) => /sucai-selector-ng/.test(f.url()));
  if (!panels().length) return;
  log('   ⚠ 有残留面板，先关掉再退出');
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
    await new Promise((r) => setTimeout(r, 2000));
    if (!panels().length) { log('   已关掉 ✓'); return; }
  }
  await page.keyboard.press('Escape').catch(() => {});
  await new Promise((r) => setTimeout(r, 1800));
  log(panels().length ? '   ★ 面板仍关不掉' : '   已关掉 ✓');
}
const iframeGeom = (page) => page.evaluate(() => {
  const f = Array.from(document.querySelectorAll('iframe')).find((x) => /sucai-selector-ng/.test(x.src || ''));
  if (!f) return null;
  const r = f.getBoundingClientRect();
  return { left: r.left, top: r.top };
});
const slots = (page) => page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const raw = Array.from(document.querySelectorAll('div,span,li,p')).filter(vis).filter((e) => clean(e.innerText) === '上传图片');
  return raw.filter((e) => !raw.some((o) => o !== e && e.contains(o))).length;
});

// ★ 按文件名在列表里找卡片（必要时滚动），返回 img 中心坐标（iframe 内坐标）
async function findCardByName(fr, fname) {
  return fr.evaluate(async (n) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const sl = (ms) => new Promise((r) => setTimeout(r, ms));
    const list = document.querySelector('[class*="PicturesShow_main"]') || document.scrollingElement;
    const pick = () => {
      const cards = Array.from(document.querySelectorAll('div,li')).filter(vis).filter((e) => clean(e.innerText).includes(n));
      if (!cards.length) return null;
      cards.sort((a, b) => a.innerText.length - b.innerText.length);
      for (const c of cards) {
        const img = c.querySelector('img') || (c.parentElement ? c.parentElement.querySelector('img') : null);
        if (!img) continue;
        const r = img.getBoundingClientRect();
        if (r.width < 60 || r.height < 60) continue;
        return { ok: true, cx: r.left + r.width / 2, cy: r.top + r.height / 2, 卡片: clean(c.innerText).slice(0, 36) };
      }
      return null;
    };
    let hit = pick();
    const 滚动起点 = list ? list.scrollTop : null;
    if (!hit && list) {
      list.scrollTop = 0; await sl(400); hit = pick();
      for (let y = 0; !hit && y <= list.scrollHeight; y += 400) { list.scrollTop = y; await sl(280); hit = pick(); }
    }
    if (!hit) {
      const names = Array.from(document.querySelectorAll('div')).filter(vis).map((e) => clean(e.innerText)).filter((t) => /\.(jpg|jpeg|png)$/i.test(t) && t.length < 26).slice(0, 14);
      return { ok: false, why: 'no_card', 可见文件名样本: names, 是否找到列表容器: !!list };
    }
    return hit;
  }, fname);
}

// 上传：面板停在哪一屏都能走 —— 先点「本地上传」，再喂 iframe 里的 input[type=file]（或接 filechooser）
async function upload(page, fr, file) {
  const p1 = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
  await fr.locator('button:has-text("本地上传")').first().click({ force: true, timeout: 8000 }).catch(() => {});
  const ch = await p1;
  if (ch) { await ch.setFiles(file); return 'filechooser'; }
  await sleep(2000);
  const n = await fr.locator('input[type=file]').count().catch(() => 0);
  if (n) { await fr.locator('input[type=file]').first().setInputFiles(file); return 'input[type=file]×' + n; }
  return null;
}

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('★ 找不到发布页'); process.exitCode = 1; return; }
    log('工作页:', page.url().slice(0, 90), '| 起始空槽:', await slots(page));

    for (const f of picked) {
      log(`\n=== ${f} ===`);
      let fr = findPanel(page);
      if (!fr) {
        // 面板没开 → 用**真实鼠标**点第一个空槽把它打开（元素点击在这个页面常常无效）
        const c = await page.evaluate(() => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const raw = Array.from(document.querySelectorAll('div,span,li,p')).filter(vis).filter((e) => clean(e.innerText) === '上传图片');
          const el = raw.filter((e) => !raw.some((o) => o !== e && e.contains(o)))[0];
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        });
        if (!c) { log('★ 没有空槽可点'); break; }
        await page.mouse.click(c.x, c.y);
        // ★ 面板是**异步**出现的：原来固定等 4.5s 就判定，实测会误判 `打开面板: false`；
        //   更糟的是误判后**主图面板仍留在页面上**，下一步（详情图）会挂到它上面
        //   （`mainImagesGroup` 底部没有「确定」→ upload 入口不可用 → 整链崩，实测踩到）→ 改成轮询等待。
        for (let k = 0; k < 12 && !fr; k++) { await sleep(2000); fr = findPanel(page); }
        log('打开面板:', !!fr);
        if (!fr) { await closeResidualPanel(page); break; }
      }
      const emptyBefore = await slots(page);

      const how = await upload(page, fr, path.join(DIR, f));
      log('上传方式:', how);
      if (!how) { log('★ 上传入口不可用'); break; }
      await sleep(9000);

      // ★ 上传完会弹「上传结果」对话框（右下角蓝色「完成」）—— 它**盖住了图片列表**，
      //   不关掉的话「按文件名找到的卡片」其实是弹窗里那条文件记录，点它不会回填。
      //   这个按钮同样必须用**真实鼠标坐标**点。
      const frD = findPanel(page) || fr;
      const done = await frD.evaluate(() => {
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /^完成$/.test((x.innerText || '').trim()));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
      }).catch(() => null);
      if (done) {
        const g0 = await iframeGeom(page);
        if (g0) {
          await page.mouse.click(Math.round(g0.left + done.x), Math.round(g0.top + done.y));
          log('点「完成」关闭「上传结果」:', done);
          await sleep(3000);
        }
      } else {
        log('（没看到「上传结果」的「完成」—— 可能已自动关闭）');
      }

      const fr2 = findPanel(page) || fr;
      const card = await findCardByName(fr2, f);
      log('按文件名找卡片:', card.ok ? { 卡片: card.卡片, 坐标: { x: Math.round(card.cx), y: Math.round(card.cy) } } : card);
      if (!card.ok) {
        log('✗ 列表里没找到「' + f + '」');
        break;
      }

      const g = await iframeGeom(page);
      if (!g) { log('★ 拿不到 iframe 位置'); break; }
      const abs = { x: Math.round(g.left + card.cx), y: Math.round(g.top + card.cy) };
      await page.mouse.move(abs.x, abs.y);
      await sleep(300);
      await page.mouse.click(abs.x, abs.y);
      await sleep(3000);

      const emptyAfter = await slots(page);
      log(`→ 空槽 ${emptyBefore} → ${emptyAfter}`, emptyAfter === emptyBefore - 1 ? '✓ 填上一个' : '✗ 没填上');
      if (emptyAfter === emptyBefore) break;
    }
    log('\n终态空槽:', await slots(page));
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
