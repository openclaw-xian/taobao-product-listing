#!/usr/bin/env node
/**
 * 按 playbook §4 笔记试主图上传：
 *   · `realTimeSelect` / `max=1` → **一次选一张填一个槽**（点图即回填，没有确认按钮）
 *   · 选图要**认 CDN id**（`O1CN…`），不要靠列表顺序/搜索框
 *
 * 做法：本地上传这一张 → 读缩略图列表里的 `t=` 时间戳，**取最新的那张**（= 刚上传的）
 *      → 用**真实鼠标坐标**点它（元素点击在这个 iframe 里不生效）→ 校验空槽数 -1。
 *
 * 用法：node tests/upload_by_note.js [--skip 1] [--limit 1]
 * 日志：tests/_upload_note.log
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
const PORT = process.env.TB_PORT || '9120';
const DIR = path.resolve(String(arg('dir', 'output/MZB-001/img/1x1')));
const SKIP = parseInt(String(arg('skip', '0')), 10);
const LIMIT = parseInt(String(arg('limit', '1')), 10);
const LOG = path.join(__dirname, '_upload_note.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== upload_by_note ${new Date().toISOString()} skip=${SKIP} limit=${LIMIT} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

const files = fs.readdirSync(DIR).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
const picked = files.slice(SKIP, SKIP + LIMIT);
log('候选:', files.join(', '), '| 本次处理:', picked.join(', '));

const findPanel = (page) => page.frames().find((f) => /sucai-selector-ng/.test(f.url()));
const panelOpen = (page) => !!findPanel(page);
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

// iframe 内：大缩略图的 t 值分布 + 指定 t 的那张的坐标
const thumbs = (fr, wantT) => fr.evaluate((wt) => {
  const big = Array.from(document.querySelectorAll('img')).filter((e) => { const r = e.getBoundingClientRect(); return r.width >= 100 && r.height >= 100; });
  const rows = big.map((e) => {
    const r = e.getBoundingClientRect();
    return { t: Number((String(e.src).match(/[?&]t=(\d+)/) || [])[1] || 0), cx: r.left + r.width / 2, cy: r.top + r.height / 2, src: String(e.src).slice(-40) };
  });
  rows.sort((a, b) => b.t - a.t);
  const target = wt ? rows.find((r) => r.t === wt) : rows[0];
  return { 数量: rows.length, 最大t: rows[0] ? rows[0].t : 0, 最新3: rows.slice(0, 3).map((r) => ({ t: r.t, src: r.src })), 目标: target || null };
}, wantT || 0);

async function clickUploadBtn(page, fr) {
  const p1 = page.waitForEvent('filechooser', { timeout: 12000 }).catch(() => null);
  await fr.locator('button:has-text("本地上传")').first().click({ force: true, timeout: 8000 }).catch(() => {});
  let ch = await p1;
  if (ch) return { chooser: ch, 方式: '元素点击' };
  // 兜底：真实鼠标点按钮坐标（元素点击可能因命中检查失败而白点）
  const c = await fr.evaluate(() => {
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /本地上传/.test(x.innerText || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const g = await iframeGeom(page);
  if (!c || !g) return { chooser: null, 方式: 'no_btn_or_geom', c, g };
  const p2 = page.waitForEvent('filechooser', { timeout: 12000 }).catch(() => null);
  await page.mouse.click(Math.round(g.left + c.x), Math.round(g.top + c.y));
  ch = await p2;
  return { chooser: ch, 方式: '鼠标坐标点击' };
}

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('★ 找不到发布页'); process.exitCode = 1; return; }
    log('工作页:', page.url().slice(0, 90));
    log('起始空槽:', await slots(page));

    for (const f of picked) {
      log(`\n=== ${f} ===`);
      let fr = findPanel(page);
      if (!fr) {
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
        if (!c) { log('★ 没有空槽'); break; }
        await page.mouse.click(c.x, c.y);
        await sleep(4500);
        fr = findPanel(page);
        if (!fr) { log('★ 面板没开'); break; }
      }

      const before = await thumbs(fr);
      const emptyBefore = await slots(page);
      log('上传前: 缩略图', before.数量, '| 最大 t =', before.最大t, '| 空槽', emptyBefore);

      const up = await clickUploadBtn(page, fr);
      log('点「本地上传」:', { 方式: up.方式, 拿到filechooser: !!up.chooser });
      let used = up.方式;
      if (up.chooser) {
        await up.chooser.setFiles(path.join(DIR, f));
      } else {
        // 面板停在「图片列表」视图时，点「本地上传」只是切回上传视图 ——
        // 真正的入口是随后出现的 `input[type=file]`，直接喂文件（不依赖 filechooser 事件）
        await sleep(2500);
        const n = await fr.locator('input[type=file]').count().catch(() => 0);
        if (!n) { log('★ 既没 filechooser、也没有 input[type=file]'); break; }
        await fr.locator('input[type=file]').first().setInputFiles(path.join(DIR, f));
        used = 'input[type=file]（点「本地上传」后出现，' + n + ' 个）';
      }
      log('上传方式:', used);
      await sleep(9000);

      const fr2 = findPanel(page) || fr;
      const after = await thumbs(fr2);
      log('上传后: 缩略图', after.数量, '| 最大 t =', after.最大t, '| 最新3:', after.最新3);
      if (after.最大t <= before.最大t) log('⚠ 上传可能没进列表（最大 t 未变）—— 仍尝试点最新的那张');

      const g = await iframeGeom(page);
      const tgt = after.目标 || (await thumbs(fr2)).目标;
      if (!g || !tgt) { log('★ 拿不到目标坐标', { g, tgt }); break; }
      const abs = { x: Math.round(g.left + tgt.cx), y: Math.round(g.top + tgt.cy) };
      log('点最新缩略图（t=' + tgt.t + '）绝对坐标:', abs);
      await page.mouse.move(abs.x, abs.y);
      await sleep(300);
      await page.mouse.click(abs.x, abs.y);
      await sleep(3000);

      const emptyAfter = await slots(page);
      log(`→ 空槽 ${emptyBefore} → ${emptyAfter}`, emptyAfter === emptyBefore - 1 ? '✓ 填上一个' : '✗ 没填上');
      if (emptyAfter === emptyBefore) break;
    }

    log('\n终态空槽:', await slots(page), '| 面板仍开:', panelOpen(page));
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
