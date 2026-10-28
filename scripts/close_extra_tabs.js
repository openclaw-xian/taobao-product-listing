#!/usr/bin/env node
/**
 * 清理标签页：保留**一张**测试用的发布页，关掉其余「商品发布」相关页（侦察会留下一堆）。
 *
 * 默认只动 `item.upload.taobao.com` 域下的页（发布页 publish.htm / 入口页 category.htm 等）——
 * **不动**千牛工作台（`qn.taobao.com`）、生意参谋（`sycm.taobao.com`）、`chrome://` 等用户自己的页。
 *
 * 保留规则（按顺序取第一个命中的 publish.htm）：
 *   ① 非「以图发品」（URL 不含 fromAIImage=true）
 *   ② 优先**没有 SKU 表**的（干净页，便于从头跑一遍）
 * 也可用 `--keep <URL 子串>` 手工指定。
 *
 * ⚠️ 关闭标签页**不等于删草稿** —— 淘宝的草稿存在服务器草稿箱里，关了页也可能还在，需用户自行清理。
 *
 * 用法：
 *   node scripts/close_extra_tabs.js --dry        # 只列将关闭哪些，不动
 *   node scripts/close_extra_tabs.js              # 真关
 * 日志：tests/_close_tabs.log
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
const DRY = !!arg('dry', false);
const KEEP = arg('keep', null);
const ALL_TAOBAO = !!arg('all-taobao', false);
const LOG = path.join(__dirname, '..', 'tests', '_close_tabs.log');
fs.writeFileSync(LOG, `== close_extra_tabs ${new Date().toISOString()} dry=${DRY} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

const SELLER = 'item.upload.taobao.com';
const isSeller = (u) => u.includes(SELLER);
const isPublish = (u) => /publish\.htm/.test(u);
const isAIImage = (u) => /fromAIImage=true/.test(u);

const hasTable = () => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return Array.from(document.querySelectorAll('table')).filter(vis).length > 0;
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const ctx = browser.contexts()[0];
    const pages = ctx.pages();
    const rows = [];
    for (const p of pages) {
      const url = p.url();
      const title = await p.title().catch(() => '');
      rows.push({ p, url, title });
    }
    log(`当前标签页 ${rows.length} 张：`);
    rows.forEach((r, i) => log(`  [${i}] ${r.title.slice(0, 24)} | ${r.url.slice(0, 100)}`));

    // —— 选要保留的那张 —— //
    let keep = null;
    if (KEEP) {
      keep = rows.find((r) => r.url.includes(String(KEEP)));
      if (!keep) log(`⚠ --keep "${KEEP}" 没匹配到任何页`);
    } else {
      const cands = rows.filter((r) => isSeller(r.url) && isPublish(r.url) && !isAIImage(r.url));
      // 优先没有 SKU 表的（干净）
      for (const c of cands) {
        const t = await c.p.evaluate(hasTable).catch(() => null);
        c.有SKU表 = t;
      }
      keep = cands.find((c) => c.有SKU表 === false) || cands[0] || null;
      if (!keep && cands.length === 0) {
        // 没有「非以图发品」的发布页 → 退而保留任意一张发布页，避免把用户手上唯一的页也关掉
        keep = rows.find((r) => isSeller(r.url) && isPublish(r.url)) || null;
        if (keep) log('⚠ 没有「搜索发品」来源的发布页 → 保留任意一张发布页');
      }
    }
    log(`\n★ 保留：${keep ? keep.url.slice(0, 110) : '（没有可保留的发布页 → 不关任何页）'}`);
    if (!keep) { log('终止：为避免误关用户页面，本次不关闭任何标签。'); return; }

    // —— 决定关哪些 —— //
    const targets = [];
    for (const r of rows) {
      if (r === keep) continue;
      if (isSeller(r.url)) { targets.push(r); continue; }          // 发布/入口等卖家后台页 → 关
      if (ALL_TAOBAO && /taobao\.com/.test(r.url)) { targets.push(r); continue; }
    }
    log(`\n将关闭 ${targets.length} 张：`);
    targets.forEach((r) => log(`  - ${r.title.slice(0, 20)} | ${r.url.slice(0, 90)}`));
    const untouched = rows.filter((r) => r !== keep && !targets.includes(r));
    log(`\n不动 ${untouched.length} 张（用户自己的页）：`);
    untouched.forEach((r) => log(`  = ${r.title.slice(0, 20)} | ${r.url.slice(0, 70)}`));

    if (DRY) { log('\n（--dry：没有真的关）'); return; }
    let closed = 0, failed = 0;
    for (const r of targets) {
      try { await r.p.close(); closed++; } catch (e) { failed++; log(`  ✗ 关不掉：${r.url.slice(0, 60)} → ${e.message}`); }
    }
    log(`\n已关闭 ${closed} 张${failed ? '，失败 ' + failed + ' 张' : ''}`);

    const after = ctx.pages();
    const afterSeller = after.filter((p) => isSeller(p.url()));
    log(`\n现在卖家后台页 ${afterSeller.length} 张：`);
    afterSeller.forEach((p) => log(`  - ${p.url().slice(0, 110)}`));
    log(`现在总标签页 ${after.length} 张`);
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
