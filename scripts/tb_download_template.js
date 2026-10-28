#!/usr/bin/env node
/**
 * 下载**当前类目**的官方 SKU 模板（发布页 →「批量导入」→「下载模版」）。
 *
 * 为什么要它：`tb_build.py --from-template` 依赖官方模板（它是**按类目**给的，表头就一列规格），
 * 换类目就得重下。这是上架流程里的正式一步（不是一次性的）。
 *
 * 关键点（都是实测踩出来的）：
 *   · 下载要先用 CDP 指定目录：`Browser.setDownloadBehavior { behavior:'allow', downloadPath }`，
 *     否则 Chrome 会卡在"询问保存位置"；
 *   · 「下载模版」必须用**真实鼠标点击**（合成事件不算用户手势，Chrome 会静默拦下载）；
 *   · 文件下来是 `.xls`，**其实是 xlsx**（文件头 50 4B）。
 *
 * 用法：node scripts/tb_download_template.js [--out output/_downloads] [--port 9120]
 * 退出码：0 = 下到文件（最后一行打印路径）/ 1 = 没下到
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
const OUT = path.resolve(String(arg('out', 'output/_downloads')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const before = new Set(fs.readdirSync(OUT));
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    // ⚠️ 别用 `.find()` 取第一页：会拿到**最旧的**发布页，下成别的类目的模板（实测踩到）
    //    → 用 `--catid` 指定；不传则取**最后打开**的那页
    const CATID = String(arg('catid', process.env.TB_CATID || ''));
    const cands = browser.contexts()[0].pages().filter((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    const page = CATID ? (cands.find((p) => p.url().includes('catId=' + CATID)) || cands[cands.length - 1]) : cands[cands.length - 1];
    if (!page) { say('★ 找不到发布页（先把类目选到 publish.htm）'); process.exitCode = 1; return; }
    say('工作页:', page.url().slice(0, 96));

    // ① CDP 指定下载目录（否则 Chrome 卡"询问保存位置"）
    let cdp = null;
    try {
      cdp = await page.context().newCDPSession(page);
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT, eventsEnabled: true });
      say('① 已设置下载目录:', OUT);
    } catch (e) { say('① setDownloadBehavior 失败（试 Page 版）:', e.message.slice(0, 60)); }

    // ② 打开「批量导入」弹窗（若没开）
    const opened = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      if (Array.from(document.querySelectorAll('.next-dialog')).filter(vis).length) return { already: true };
      const wrap = document.querySelector('.sell-component-sku-excel-upload') || document;
      const b = Array.from(wrap.querySelectorAll('button')).filter(vis).find((x) => clean(x.innerText).includes('批量导入'));
      if (!b) return { ok: false, why: 'no_import_btn' };
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    if (opened && opened.x) { await page.mouse.click(opened.x, opened.y); }
    say('② 打开批量导入:', opened);
    await sleep(3500);

    // ③ 真实鼠标点「下载模版」
    const btn = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const pool = Array.from(document.querySelectorAll('button,a,span,div')).filter(vis);
      const hit = pool.filter((e) => /下载模[版板]/.test(clean(e.innerText)));
      if (!hit.length) return { ok: false, why: 'no_download_btn' };
      const el = hit.filter((e) => !hit.some((o) => o !== e && e.contains(o)))[0];
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文本: clean(el.innerText).slice(0, 12) };
    });
    say('③ 找到「下载模版」:', btn);
    if (!btn.ok) { process.exitCode = 1; return; }
    await page.mouse.move(btn.x, btn.y);
    await sleep(300);
    await page.mouse.click(btn.x, btn.y);

    // ④ 等落盘
    let got = null;
    for (let i = 0; i < 20 && !got; i++) {
      await sleep(1500);
      const now = fs.readdirSync(OUT).filter((f) => !before.has(f) && !/\.crdownload$/i.test(f));
      if (now.length) got = now[now.length - 1];
    }
    if (!got) {
      // 兜底：目录里最新修改的模板文件
      const all = fs.readdirSync(OUT).filter((f) => /模板|SKU/i.test(f) && /\.xls[x]?$/i.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      if (all.length) say('⚠ 没等到新文件，但目录里有:', all[0].f);
    }
    const p = got ? path.join(OUT, got) : null;
    say('④ 下载结果:', p || '（没下到）');
    console.log(JSON.stringify({ ok: !!p, file: p }));
    process.exitCode = p ? 0 : 1;
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
