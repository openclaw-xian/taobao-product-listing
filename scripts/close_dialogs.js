#!/usr/bin/env node
/**
 * 清残留**模态弹窗**（`门禁 4`：操作前先关弹窗）。
 *
 * 为什么要有这一步：`tb_download_template.js` 会打开「批量导入」弹窗去点「下载模版」，
 * 但**下完不会关** —— 那个弹窗停在页面正中，会**盖住中间那排属性控件**（实测地毯类目：
 * 品牌 p-20000 / 主图案类型 p-20603 / 适用空间 p-1626518 正好被压住，真实鼠标点全部点不中，
 * 表现为「无选项 / 读回为空」）。周围的属性不受影响 → 容易误判成"控件类型不认识"。
 *
 * 用法：
 *   node scripts/close_dialogs.js                        # 关掉文本含「批量导入」的可见弹窗（默认）
 *   node scripts/close_dialogs.js --match "上传结果"      # 关别的弹窗
 *   node scripts/close_dialogs.js --list                  # 只列可见弹窗，不动手
 * 退出码：0 = 没有残留 / 已关掉；1 = 有弹窗但没找到关闭按钮
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
const MATCH = String(arg('match', '批量导入'));
const ALL = !!arg('all', false);          // ★ 关掉**任何**可见弹窗（整链每步之间用这个兜底）
const LIST_ONLY = !!arg('list', false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

// ⚠️ Playwright 的 evaluate 只传**一个** arg → 用一个对象把 match/all 一起带进去（两个参数会被丢掉）。
const scan = (opts) => {
  const match = (opts && opts.match) || '';
  const all = !!(opts && opts.all);
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // --all 模式下**不关**正在使用的面板：误关会让正在做的那一步全崩
  const KEEP = ['批量填充规格主图', '本地上传', '批量导入'];
  const dlgs = Array.from(document.querySelectorAll('.next-dialog')).filter(vis);
  return dlgs.map((d) => {
    const txt = clean(d.innerText);
    const keep = all && KEEP.some((k) => txt.includes(k));
    const btns = Array.from(d.querySelectorAll('button')).filter(vis).map((b) => {
      const r = b.getBoundingClientRect();
      return { 文案: clean(b.innerText).slice(0, 12), 中: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } };
    });
    const rect = d.getBoundingClientRect();
    return {
      匹配: all ? !keep : (match !== '' && txt.includes(match)),
      文本: txt.slice(0, 90),
      位置: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      按钮: btns,
    };
  });
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const cands = browser.contexts()[0].pages().filter((p) => /publish\.htm/.test(p.url()));
    const page = cands[cands.length - 1];
    if (!page) { say('没有 publish.htm 页'); process.exitCode = 1; return; }
    const before = await page.evaluate(scan, { match: MATCH, all: ALL });
    say(`可见弹窗 ${before.length} 个（模式：${ALL ? '--all 全关' : '匹配「' + MATCH + '」'}）：`);
    before.forEach((d, i) => say(`  [${i}] 匹配=${d.匹配} 位置=${JSON.stringify(d.位置)} 文本=${d.文本}`));
    if (LIST_ONLY) { process.exitCode = 0; return; }
    const hits = before.filter((d) => d.匹配);
    if (!hits.length) { say('没有需要关的弹窗 ✓'); process.exitCode = 0; return; }

    for (const h of hits) {
      // 优先「取消」/「关闭」/「完成」/「知道了」；兜底点这个弹窗自己的**右上角 ✕**
      const b = h.按钮.find((x) => /^(取消|关闭|完成|知道了|好的)/.test(x.文案));
      if (b) {
        await page.mouse.click(b.中.x, b.中.y);
        say(`点「${b.文案}」关闭`);
      } else {
        // ★ 用这个弹窗自己的位置算右上角（原来写死找「批量导入」那个弹窗，--all 模式下会点错对象）
        const x = h.位置.x + h.位置.w - 14;
        const y = h.位置.y + 14;
        await page.mouse.click(x, y);
        say(`点右上角 ✕ 关闭 @ ${x},${y}`);
      }
      await sleep(1200);
    }
    const after = await page.evaluate(scan, { match: MATCH, all: ALL });
    const left = after.filter((d) => d.匹配).length;
    say('关完后仍匹配的弹窗:', left);
    process.exitCode = left ? 1 : 0;
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
