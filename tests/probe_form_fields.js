#!/usr/bin/env node
/**
 * 表单字段探针（**只读**）：把 publisher 页上「还没摸到的字段」一次列清楚。
 *
 * 背景：入口段（类目+品牌）已固化（`scripts/tb_enter_form.js`），接下来要填标题 / 属性 / 一口价 /
 * 总库存 / 货号 / 图槽，但这些字段的**定位口径**还没登记进 `references/RECON.md`。
 *
 * 用法：
 *   node tests/probe_form_fields.js                 # 所有 publish.htm 页 → 打印**摘要**
 *   node tests/probe_form_fields.js --index 1        # 第 1 张页 → 打印**全字段详单**（含属性区、SKU、图槽）
 * 日志：tests/_probe_form.log
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
const INDEX = arg('index', null);
const LOG = path.join(__dirname, '_probe_form.log');
fs.writeFileSync(LOG, `== probe_form_fields ${new Date().toISOString()} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

// —— 摘要（轻量，每页都读） —— //
const summary = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const t = clean(document.body.innerText);
  const inputs = Array.from(document.querySelectorAll('input')).filter(vis);
  const title = inputs.find((i) => (i.getAttribute('placeholder') || '').includes('30个汉字'));
  const guide = inputs.find((i) => (i.getAttribute('placeholder') || '').includes('15个汉字'));
  const brandBox = document.querySelector('#sell-field-p-20000');
  const brand = brandBox ? Array.from(brandBox.querySelectorAll('input')).map((i) => i.value).filter(Boolean)[0] : null;
  const trs = Array.from(document.querySelectorAll('tbody tr')).filter(vis);
  const table = Array.from(document.querySelectorAll('table')).filter(vis)[0];
  const ths = table ? Array.from(table.querySelectorAll('thead th')).map((e) => clean(e.innerText)) : [];
  const imgs = Array.from(document.querySelectorAll('img')).filter(vis);
  const skuArea = (t.match(/SKU模式[^\n]{0,60}/) || [])[0] || null;
  return {
    url: location.href.slice(0, 70),
    catId: (location.search.match(/catId=(\d+)/) || [])[1] || null,
    来自以图发品: /fromAIImage=true/.test(location.href),
    标题: title ? title.value : null,
    导购标题: guide ? guide.value : null,
    品牌: brand,
    SKU可见行: trs.length,
    SKU表头: ths.slice(0, 10),
    规格区: skuArea,
    可见img: imgs.length,
    有提交按钮: t.includes('提交宝贝信息'),
    最后保存: (t.match(/最后保存于[^\n]{0,24}/) || [])[0] || null,
  };
};

// —— 详单（指定页） —— //
const detail = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const t = clean(document.body.innerText);

  // ① 所有可见 input：placeholder / name / id / value / y（用来认一口价·总库存·货号）
  const inputs = Array.from(document.querySelectorAll('input')).filter(vis).map((i) => ({
    ph: (i.getAttribute('placeholder') || '').slice(0, 34),
    name: i.getAttribute('name') || null,
    id: i.id || null,
    type: i.type,
    value: String(i.value || '').slice(0, 30),
    y: Math.round(i.getBoundingClientRect().top),
  }));

  // ② 属性区：每个 sell-field-p-* 的类型 + 当前值 + 是否带 *
  const props = Array.from(document.querySelectorAll('[id^="sell-field-p-"]')).map((box) => {
    const cls = String(box.className || '');
    const kind = ['combobox', 'select', 'checkbox', 'input', 'taoSirProp'].find((k) => new RegExp('(^|\\s)' + k).test(cls)) || '?';
    const vals = Array.from(box.querySelectorAll('input')).filter(vis).map((i) => String(i.value || '')).filter(Boolean);
    const picked = Array.from(box.querySelectorAll('[class*=selection-item],[class*=SelectionItem],[class*=checked],[aria-checked="true"]')).map((e) => clean(e.innerText)).filter(Boolean);
    return {
      id: box.id,
      类型: kind,
      必填: /label-required|\*/.test(clean(box.innerText).slice(0, 30)) || /required/i.test(cls),
      输入值: vals.slice(0, 3),
      已选chips: picked.slice(0, 4),
      文本: clean(box.innerText).slice(0, 40),
    };
  });

  // ③ SKU 区
  const table = Array.from(document.querySelectorAll('table')).filter(vis)[0];
  const ths = table ? Array.from(table.querySelectorAll('thead th')).map((e) => clean(e.innerText)) : [];
  const trs = Array.from(document.querySelectorAll('tbody tr')).filter(vis);

  // ④ 图槽：带「上传图片」的槽 + 每个槽里的 img 数
  const slots = Array.from(document.querySelectorAll('div,li')).filter(vis).filter((e) => {
    const txt = clean(e.innerText);
    return txt === '上传图片' || txt === '上传' || /上传图片/.test(txt) && txt.length < 14;
  }).slice(0, 16).map((e) => ({ text: clean(e.innerText).slice(0, 14), imgs: e.querySelectorAll('img').length, y: Math.round(e.getBoundingClientRect().top) }));

  const editor = document.querySelector('[class*="lite-decoration-editor"]');

  return {
    url: location.href.slice(0, 120),
    catId: (location.search.match(/catId=(\d+)/) || [])[1] || null,
    标题: inputs.find((i) => /30个汉字/.test(i.ph)) ? inputs.find((i) => /30个汉字/.test(i.ph)).value : null,
    一口价候选: inputs.filter((i) => /元|价格|一口价/.test(i.ph) || i.name === 'price' || /price/i.test(String(i.name))).slice(0, 6),
    全部input: inputs.slice(0, 46),
    属性: props,
    SKU: { 表头: ths.slice(0, 12), 可见行: trs.length, 首行: trs[0] ? Array.from(trs[0].querySelectorAll('td')).map((td) => { const i = td.querySelector('input'); return i ? String(i.value || '') : clean(td.innerText).slice(0, 20); }).slice(0, 12) : null },
    图槽: slots,
    详情编辑器img: editor ? editor.querySelectorAll('img').length : null,
    页面片段: t.slice(0, 0),
  };
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const ctx = browser.contexts()[0];
    const forms = ctx.pages().filter((p) => /publish\.htm/.test(p.url()));
    log(`publish.htm 页数 = ${forms.length}`);
    if (INDEX === null) {
      for (let i = 0; i < forms.length; i++) {
        const r = await forms[i].evaluate(summary).catch((e) => ({ 读取失败: e.message }));
        log(`\n--- [${i}] ---`, r);
      }
      return;
    }
    const n = parseInt(String(INDEX), 10);
    const p = forms[n];
    if (!p) { log(`没有第 ${n} 张页`); process.exitCode = 1; return; }
    log(`\n===== 详单 [${n}] =====`, await p.evaluate(detail));
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
