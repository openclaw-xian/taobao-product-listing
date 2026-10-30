#!/usr/bin/env node
/**
 * **提交前核对清单**（SKILL 门禁 16 / playbook §11）：把该核的项**一次读回**，与 `product.json` 对照。
 *
 * 用法：node scripts/tb_checklist.js [--product output/MZB-001/product.json]
 * 退出码：0 = 全部 ✓ / 1 = 有 ✗（逐条列出）
 * 说明：只读，不点任何业务按钮（尤其不点提交）。
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
const PRODUCT = JSON.parse(fs.readFileSync(path.resolve(String(arg('product', 'output/MZB-001/product.json'))), 'utf8'));
const ATTRS = PRODUCT.attributes || {};
const EXPECT_N = (PRODUCT.skus || []).length;
// ★ 期望值**从 product.json 来**，别再写死 MZB-001（换商品会满屏误报 —— PE-001 实测）
const CATSRC = String(PRODUCT.category_source || '');
const EXP_CATID = (CATSRC.match(/cate(?:gory)?[Ii]d=(\d+)/) || [])[1] || null;
const EXP_CAT_LEAF = (CATSRC.match(/>\s*([^>|]+?)\s*(?:\||$)/) || [])[1] || null;
function clampTitle(s) {   // 与 tb_fill_basic 同一套规则：30 汉字 = 60 字符（汉字算 2）
  let n = 0, out = '';
  for (const ch of String(s || '')) {
    const w = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (n + w > 60) break;
    n += w; out += ch;
  }
  return out.trim();
}
const EXP_TITLE = clampTitle(PRODUCT.title || '');
const PRICES = new Set((PRODUCT.price_set || []).map((p) => Number(p)));
// 期望总库存 = **Σ 各 SKU 库存**（不能写死 N×100：不同商品每行库存不同）
const EXP_STOCK = (PRODUCT.skus || []).reduce((s, x) => s + (Number(x.stock) || 0), 0);
// 期望详情张数 = 该商品 img/detail 目录里的图片数（别写死 20）
let DETAIL_N = 0;
try {
  const dd = path.join(path.dirname(PRODUCT_PATH), 'img', 'detail');
  DETAIL_N = fs.readdirSync(dd).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length;
} catch (e) { /* 没有目录就不校验张数 */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

// 跨窗口扫 SKU 表（虚拟滚动 → 取并集）
// SKU 表读取统一走 `sku_table.js`（原来这份把「第 2 个单元格」当规格值 —— 两层规格下
// 第 2 格只有颜色分类 → 99 行被读成 9 行，造成假失败）。
const { scanSkuTable } = require(path.join(__dirname, 'sku_table.js'));
async function scanTable(page, step = 300) {
  const r = await scanSkuTable(page, step);
  return r.ok ? { ok: true, n: r.unique, all: (r.all || []).map((x) => x.spec), 价格们: Array.from(new Set((r.all || []).map((x) => x.price))).slice(0, 20), 滚动高: r.滚动高 } : r;
}

const pageRead = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const t = clean(document.body.innerText);
  // 属性区
  const props = {};
  Array.from(document.querySelectorAll('[id^="sell-field-p-"]')).forEach((box) => {
    const label = ((clean(box.innerText).replace(/^\*+/, '').split('重要')[0].trim().match(/^[^\s0-9/]+/) || [''])[0] || '').trim();
    const vals = Array.from(box.querySelectorAll('input')).map((i) => String(i.value || '')).filter(Boolean);
    const tags = Array.from(box.querySelectorAll('[class*=next-tag]')).map((e) => clean(e.innerText)).filter(Boolean);
    if (label) props[label] = vals[0] || tags[0] || null;
  });
  // 一口价 / 总库存：按同一行左侧文案
  const all = Array.from(document.querySelectorAll('div,span,label,p')).filter(vis);
  const lab = {};
  for (const i of Array.from(document.querySelectorAll('input')).filter(vis)) {
    const r = i.getBoundingClientRect(); const cy = r.top + r.height / 2;
    let lbl = null, best = 1e9;
    for (const e of all) {
      if (e.contains(i)) continue;
      const b = e.getBoundingClientRect();
      if (b.top + b.height / 2 < cy - 10 || b.top + b.height / 2 > cy + 10) continue;
      if (b.left + b.width > r.left + 4) continue;
      const x = clean(e.innerText); if (!x || x.length > 24) continue;
      const d = r.left - (b.left + b.width); if (d < best) { best = d; lbl = x; }
    }
    const k = (lbl || '').replace(/\s*\*\s*$/, '').trim();
    if (['一口价', '总库存', '购买须知', '商家编码'].includes(k)) lab[k] = String(i.value || '');
  }
  // 图片槽
  const raw = Array.from(document.querySelectorAll('div,span,li,p')).filter(vis).filter((e) => clean(e.innerText) === '上传图片');
  const 空槽 = raw.filter((e) => !raw.some((o) => o !== e && e.contains(o))).length;
  const ed = document.querySelector('[class*="lite-decoration-editor"]');
  return {
    catId: (location.search.match(/catId=(\d+)/) || [])[1] || null,
    当前类目: (t.match(/当前类目\s*\*?\s*([^\n]{0,60})/) || [])[1] || null,
    标题: (() => { const i = Array.from(document.querySelectorAll('input')).filter(vis).find((x) => (x.getAttribute('placeholder') || '').includes('30个汉字')); return i ? i.value : null; })(),
    属性: props,
    一口价: lab['一口价'] || null,
    总库存: lab['总库存'] || null,
    空槽总数: 空槽,
    详情img: ed ? ed.querySelectorAll('img').length : null,
    规格区: (t.match(/SKU模式[^\n]{0,40}/) || [])[0] || null,
    有提交按钮: t.includes('提交宝贝信息'),
    报错: (t.match(/请发布前修改以下出错项[^\n]{0,80}/) || [])[0] || null,
  };
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { say('★ 找不到发布页'); process.exitCode = 1; return; }
    say('工作页:', page.url().slice(0, 90));
    const st = await page.evaluate(pageRead);
    const sku = await scanTable(page);

    const rows = [];
    const chk = (name, got, exp, ok) => rows.push({ 项: name, 读回: got, 期望: exp, ok });

    chk('类目 catId', st.catId, EXP_CATID || '（素材包未给，跳过）', !EXP_CATID || st.catId === EXP_CATID);
    chk('当前类目', st.当前类目 ? st.当前类目.slice(0, 34) : null, EXP_CAT_LEAF || '（跳过）',
      !EXP_CAT_LEAF || String(st.当前类目).includes(EXP_CAT_LEAF));
    chk('宝贝标题', st.标题, EXP_TITLE, st.标题 === EXP_TITLE);
    // 品牌 = `#sell-field-p-20000` 里 **name 不含 `~`** 的那个 input
    //   （⚠️ 品牌 p-20000 与货号 p-20000~1 在**同一个容器**里，取第一个 input 会读到货号 →
    //    实测这里曾把品牌读成 `6.9-雨棚防滴水-1`，造成假失败；与 tb_fill_basic.js 用同一套规则）
    const brandVal = await page.evaluate(() => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const box = document.querySelector('#sell-field-p-20000');
      if (!box) return null;
      const inputs = Array.from(box.querySelectorAll('input')).filter(vis);
      const inp = inputs.find((i) => !/~/.test(i.getAttribute('name') || '')) || inputs[0];
      return inp ? inp.value : null;
    });
    // ★ 文本项比较前**归一化**（2026-10-14 同事报「货号假失败」）：
    //   素材包 Excel 里的值极容易带 首尾空格 / 全角空格 / 零宽字符（\u200b-\u200d、\ufeff），
    //   而页面读回是干净的 → 严格全等就报 ✗，看着像技能填错了，其实两边是同一个值。
    const norm = (v) => String(v == null ? '' : v)
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const same = (a, b) => norm(a) === norm(b);
    chk('品牌', brandVal, ATTRS['品牌'], !ATTRS['品牌'] || same(brandVal, ATTRS['品牌']));
    chk('品牌（页面上读到的字段）', st.属性['品牌'], '（仅参考，可能读到货号）', true);
    chk('主体材质', st.属性['主体材质'], ATTRS['主体材质'], same(st.属性['主体材质'], ATTRS['主体材质']));
    chk('适用猫体型', st.属性['适用猫体型'], ATTRS['适用猫体型'], same(st.属性['适用猫体型'], ATTRS['适用猫体型']));
    chk('货号', st.属性['货号'], ATTRS['货号'], same(st.属性['货号'], ATTRS['货号']));
    const lp = Number(st.一口价);
    chk('一口价', st.一口价, String(PRODUCT.list_price) + '（∈有库存SKU价）', lp === Number(PRODUCT.list_price) && PRICES.has(lp));
    chk('总库存', st.总库存, String(EXP_STOCK) + '（= Σ各 SKU 库存）', Number(st.总库存) === EXP_STOCK);
    chk('SKU 行数', sku.ok ? sku.n : '扫描失败:' + sku.why, EXPECT_N, sku.ok && sku.n === EXPECT_N);
    chk('规格区', st.规格区, 'SKU模式 · 单层', /SKU模式/.test(String(st.规格区)));
    // 1:1 主图 5 张已填 + 3:4 按口径留空 ⇒ 空槽总数应 = 5
    // 主图槽位**按类目实际**（猫抓板 5 槽 / 墙纸 6 槽）→ 不再写死 5；全空会是 10+，所以用 ≤8 判"已填过"
    chk('主图/3:4 空槽', st.空槽总数, '≤8（1:1 已填、3:4 按口径留空）', Number(st.空槽总数) <= 8);
    chk('详情 img', st.详情img, DETAIL_N ? ('≥' + DETAIL_N + '（素材张数）') : '（无素材目录，跳过）', DETAIL_N ? Number(st.详情img) >= DETAIL_N : true);
    chk('页面报错', st.报错, '无', !st.报错);

    console.log('\n===== 提交前核对清单 =====');
    rows.forEach((r) => console.log(`  ${r.ok ? '✓' : '✗'} ${r.项.padEnd(12)} 读回=${JSON.stringify(r.读回)}  期望=${JSON.stringify(r.期望)}`));
    const bad = rows.filter((r) => !r.ok);
    console.log('\n' + JSON.stringify({ ok: bad.length === 0, 未通过: bad.map((b) => b.项), SKU价格档: sku.价格们 || null }, null, 1));
    process.exitCode = bad.length === 0 ? 0 : 1;
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
