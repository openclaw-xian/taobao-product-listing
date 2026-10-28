#!/usr/bin/env node
/**
 * 表单标签探针（**只读，不打开任何下拉**）：把「一口价 / 总库存 / 货号 / 商品参考价」这类
 * 没有 id、没有可识别 placeholder 的字段，用**同一行的左侧文案**认出来。
 *
 * 背景：`tests/probe_form_fields.js` 显示这些字段是 `placeholder=""` 的裸 input
 * （实测 y=2616 一口价候选、y=2697 值=1 像总库存），光看 placeholder 认不出来。
 *
 * 页面的定位：**不按索引**（页数会变、索引会漂），按 URL 特征：
 *   publish.htm + catId=50003280；`--skip-aiimage`（默认）时排除 `fromAIImage=true` 的页。
 *
 * 用法：node tests/probe_labels.js [--all]      # --all 则列出所有 publish.htm 页
 * 日志：tests/_probe_labels.log
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
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const ALL = !!arg('all', false);
const LOG = path.join(__dirname, '_probe_labels.log');
fs.writeFileSync(LOG, `== probe_labels ${new Date().toISOString()} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

// 只读：给每个可见 input 找「同一行左侧最近的文案」当 label
const labels = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const all = Array.from(document.querySelectorAll('div,span,label,p')).filter(vis);
  const inputs = Array.from(document.querySelectorAll('input,textarea')).filter(vis);
  const out = [];
  for (const i of inputs) {
    const r = i.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    // 同一行、x 在它左边、离得最近的那个短文案
    let lbl = null, best = 1e9;
    for (const e of all) {
      if (e.contains(i)) continue;
      const b = e.getBoundingClientRect();
      if (b.top + b.height / 2 < cy - 10 || b.top + b.height / 2 > cy + 10) continue;
      if (b.left + b.width > r.left + 4) continue;
      const txt = clean(e.innerText);
      if (!txt || txt.length > 24) continue;
      const d = r.left - (b.left + b.width);
      if (d < best) { best = d; lbl = txt; }
    }
    const row = i.closest('[class*="row"],[class*="item"],[class*="field"],[class*="group"]');
    out.push({
      y: Math.round(r.top),
      ph: (i.getAttribute('placeholder') || '').slice(0, 26),
      name: i.getAttribute('name') || null,
      type: i.type,
      value: String(i.value || '').slice(0, 24),
      左侧文案: lbl,
      行容器class: row ? String(row.className).slice(0, 60) : null,
      行文本: row ? clean(row.innerText).slice(0, 40) : null,
    });
  }
  return out;
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const pages = browser.contexts()[0].pages().filter((p) => /publish\.htm/.test(p.url()));
    log(`publish.htm 页数 = ${pages.length}`);
    for (let i = 0; i < pages.length; i++) {
      const url = pages[i].url();
      const isAI = /fromAIImage=true/.test(url);
      if (!ALL && isAI) { log(`[${i}] 跳过（以图发品）`); continue; }
      const catId = (url.match(/catId=(\d+)/) || [])[1];
      log(`\n===== [${i}] catId=${catId} ${isAI ? '(以图发品)' : '(搜索发品)'} =====`);
      const rows = await pages[i].evaluate(labels).catch((e) => ({ err: e.message }));
      if (!Array.isArray(rows)) { log('读取失败:', rows); continue; }
      // 只打印「有名字」的那些（左侧文案非空），这些才是业务字段
      rows.filter((r) => r.左侧文案).forEach((r) => log('  ', r));
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
