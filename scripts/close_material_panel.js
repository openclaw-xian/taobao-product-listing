#!/usr/bin/env node
/**
 * 关掉残留的「图片空间」素材面板。
 *
 * 为什么需要：主图/详情/规格图都走同一个 `sucai-selector-ng` 面板，
 * 上一步跑完如果面板没关，下一步脚本一检测到"已有素材 iframe"就会误判
 * "面板已开"，拿到的是**上一步那个面板**（实测：详情步拿到主图面板 `mainImagesGroup`，
 * 底部没有「确定」→ 上传入口不可用）。
 *
 * 用法（在图片类步骤之前调用）：node scripts/close_material_panel.js
 * 退出码：0 = 无残留或已关掉 / 1 = 关不掉（会打印面板名，便于判断）
 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, 'pwresolver.js'));
const { guardCheck } = require(path.join(__dirname, 'guard.js'));
const PORT = String(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : (process.env.TB_PORT || '9120'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
const panels = (page) => page.frames().filter((f) => /sucai-selector-ng/.test(f.url()));

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { say('没有发布页'); return; }
    const before = panels(page).map((f) => f.name() || '(无名)');
    if (!before.length) { say('无残留素材面板 ✓'); return; }

    say('残留面板:', before, '→ 关闭中');
    for (let i = 0; i < 4; i++) {
      const c = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /^(取消|关闭)/.test(clean(x.innerText)));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文本: clean(b.innerText) };
      });
      if (!c) break;
      await page.mouse.click(c.x, c.y);
      say('   点了「' + c.文本 + '」');
      await sleep(2000);
      if (!panels(page).length) break;
    }
    if (panels(page).length) { await page.keyboard.press('Escape').catch(() => {}); await sleep(1800); }

    const after = panels(page).map((f) => f.name() || '(无名)');
    if (after.length) { say('★ 仍有关不掉的面板:', after); process.exitCode = 1; }
    else say('已清空 ✓');
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
