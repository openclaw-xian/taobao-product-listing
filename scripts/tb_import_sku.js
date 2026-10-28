#!/usr/bin/env node
/**
 * 销售信息段：**批量导入（AI识别导入）官方模板 → 72 行 SKU 表 → 一口价 → 总库存核对**。
 *
 * 已验通的链路（2026-10-10，见 references/RECON.md）：
 *   官方模板表头是**单列规格** `颜色分类 | 价格 | 数量 | 商家编码 | 商品条形码`；
 *   两维合成一列填（`米白-宽30cm长1米`）→ 上传 → 「确认识别」→ **「在当前规格后添加」** → SKU 表就齐。
 * ⚠️ 「在当前规格后添加」是**追加**：同一页重复跑会把行数翻倍 → 所以本脚本先扫表，已是期望行数就跳过导入。
 *
 * 一口价：平台硬约束「必须等于某个**有库存** SKU 的价格」（门禁 6），值取 product.json 的 list_price。
 * 总库存：页面提示「此处是商品所有销售规格总库存数量，若需修改请在销售规格表格内修改」→ 只读汇总，核对即可。
 *
 * 用法：
 *   node scripts/tb_import_sku.js --product output/MZB-001/product.json \
 *        [--file output/MZB-001/sku_import_官方模板.xlsx] [--expect 72] [--skip-price]
 * 退出码：0 = SKU 行数与期望一致 + 一口价到位 / 1 = 有问题（详见输出）
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
const PRODUCT_PATH = path.resolve(String(arg('product', 'output/MZB-001/product.json')));
// 默认路径写在源码里（含中文的文件名经 CLI 传参会乱码）
// 官方模板默认放在**该商品自己的输出目录**（别写死 MZB-001，换商品会拿错模板）
const FILE_PATH = path.resolve(String(arg('file', path.join(path.dirname(PRODUCT_PATH), 'sku_import_官方模板.xlsx'))));
const SKIP_PRICE = !!arg('skip-price', false);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

const PRODUCT = JSON.parse(fs.readFileSync(PRODUCT_PATH, 'utf8'));
const EXPECT = parseInt(String(arg('expect', (PRODUCT.skus || []).length || 0)), 10);
const LIST_PRICE = PRODUCT.list_price;
const EXPECT_SET = new Set((PRODUCT.skus || []).map((s) => `${s.color}-${s.style}`));
say('期望 SKU 行 =', EXPECT, '| 一口价 =', LIST_PRICE, '| 模板文件 =', FILE_PATH);
if (!fs.existsSync(FILE_PATH)) { say('★ 模板文件不存在：', FILE_PATH); process.exit(2); }

// —— 跨窗口扫 SKU 表（虚拟滚动 → 取并集）—— //
// ★ 统一走 `sku_table.js`（原来这里那份只认「颜色-尺寸挤在一列」的老格式，
//   换两层规格后颜色/尺寸各占一格、都不含 `-` → 读到 0 行）。
const { scanSkuTable } = require(path.join(__dirname, 'sku_table.js'));
async function scanTable(page, step = 400) {
  return scanSkuTable(page, step);
}

// —— 按页面上「同一行左侧的文案」找字段（一口价 / 总库存没有 id 也没有可识别 placeholder）—— //
async function readLabelled(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const all = Array.from(document.querySelectorAll('div,span,label,p')).filter(vis);
    const out = {};
    for (const i of Array.from(document.querySelectorAll('input')).filter(vis)) {
      const r = i.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      let lbl = null, best = 1e9;
      for (const e of all) {
        if (e.contains(i)) continue;
        const b = e.getBoundingClientRect();
        if (b.top + b.height / 2 < cy - 10 || b.top + b.height / 2 > cy + 10) continue;
        if (b.left + b.width > r.left + 4) continue;
        const t = clean(e.innerText);
        if (!t || t.length > 24) continue;
        const d = r.left - (b.left + b.width);
        if (d < best) { best = d; lbl = t; }
      }
      if (!lbl) continue;
      const key = lbl.replace(/\s*\*\s*$/, '').trim();
      if (['一口价', '总库存', '购买须知', '商家编码'].includes(key)) out[key] = { value: String(i.value || ''), y: Math.round(r.top) };
    }
    return out;
  });
}

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const pages = browser.contexts()[0].pages().filter((p) => /publish\.htm/.test(p.url()));
    const page = pages.find((p) => !/fromAIImage=true/.test(p.url())) || pages[0];
    if (!page) { say('★ 没有 publish.htm 页'); process.exitCode = 1; return; }
    say('工作页:', page.url().slice(0, 96));

    // ① 先扫表：已经是期望行数就不重复导入（「在当前规格后添加」是**追加**！）
    let scan = await scanTable(page);
    say('① 当前 SKU 表:', scan.ok ? `读到 ${scan.unique} 行` : scan.why);
    // ★ 复扫一次：虚拟滚动偶尔少读 1 行（实测同一张 99 行的表读到过 98 / 93 / 69）
    if (scan.ok && scan.unique !== EXPECT) {
      const again = await scanTable(page);
      say('①b 复扫:', again.ok ? `读到 ${again.unique} 行` : again.why);
      if (again.ok && again.unique > scan.unique) scan = again;
    }
    // ★★ 追加**不可逆**（「在当前规格后添加」会累加）→ 读数接近期望时**绝不自动追加**：
    //    否则"少读 1 行"会被当成"缺行"，再导一次就变成 198 行（实测这坑差点踩到）。
    //    只有明确**表基本是空的**才导入；确实缺行要人工确认后加 `--force-import`。
    const FORCE_IMPORT = !!arg('force-import', false);
    if (scan.ok && scan.unique !== EXPECT && scan.unique >= Math.floor(EXPECT * 0.6) && !FORCE_IMPORT) {
      say(`★★ 读到 ${scan.unique} / 期望 ${EXPECT}，**接近但不等于** → 不自动追加（追加不可逆）`);
      say('   先人工确认到底缺不缺行；确认要重导再加 --force-import');
      console.log(JSON.stringify({ ok: false, SKU行数: scan.unique, 期望: EXPECT, 原因: '读数接近期望，未自动追加' }, null, 1));
      process.exitCode = 1;
      return;
    }

    if (!scan.ok || scan.unique !== EXPECT) {
      // ② 打开「批量导入」
      const open = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        if (document.querySelector('.next-dialog')) return { ok: true, already: '弹窗已开' };
        const wrap = document.querySelector('.sell-component-sku-excel-upload') || document;
        const btn = Array.from(wrap.querySelectorAll('button')).filter(vis).find((b) => clean(b.innerText).includes('批量导入'));
        if (!btn) return { ok: false, why: 'no_import_btn' };
        btn.scrollIntoView({ block: 'center' });
        for (const ev of ['mousedown', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        return { ok: true, 点了: clean(btn.innerText) };
      });
      say('② 打开批量导入:', open);
      await sleep(3000);

      // ③ 上传模板
      const fi = await page.$('input[type=file]');
      if (!fi) { say('★ 弹窗里没有 input[type=file]'); console.log(JSON.stringify({ ok: false, why: 'no_file_input' })); process.exitCode = 1; return; }
      await fi.setInputFiles(FILE_PATH);
      say('③ 已上传:', path.basename(FILE_PATH));
      await sleep(3500);

      // ④ 确认识别（先合成点击；没反应再真实点击一次）
      const confirm = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
        if (!dlg) return { ok: false, why: 'no_dialog' };
        const btn = Array.from(dlg.querySelectorAll('button')).filter(vis).find((b) => clean(b.innerText).includes('确认识别'));
        if (!btn) return { ok: false, why: 'no_confirm_btn', 弹窗文本: clean(dlg.innerText).slice(0, 120) };
        if (btn.disabled) return { ok: false, why: 'disabled' };
        for (const ev of ['mousedown', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        return { ok: true };
      });
      say('④ 确认识别（合成点击）:', confirm);
      await sleep(6000);
      let dialogText = await page.evaluate(() => {
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
        return dlg ? (dlg.innerText || '').replace(/\s+/g, ' ').slice(0, 260) : null;
      });
      say('   识别结果:', dialogText);
      if (dialogText && !/识别|添加|属性/.test(dialogText)) {
        // 换真实点击再试一次
        const real = await page.locator('.next-dialog button:has-text("确认识别")').first().click({ timeout: 6000 }).then(() => true).catch((e) => e.message);
        say('④b 真实点击确认识别:', real);
        await sleep(6000);
        dialogText = await page.evaluate(() => {
          const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
          return dlg ? (dlg.innerText || '').replace(/\s+/g, ' ').slice(0, 260) : null;
        });
        say('   识别结果(2):', dialogText);
      }

      // ⑤ 「在当前规格后添加」
      const accept = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
        const scope = dlg || document;
        const btn = Array.from(scope.querySelectorAll('button')).filter(vis).find((b) => /在当前规格后添加|添加/.test(clean(b.innerText)));
        if (!btn) return { ok: false, why: 'no_accept_btn', 弹窗文本: dlg ? clean(dlg.innerText).slice(0, 160) : null };
        for (const ev of ['mousedown', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        return { ok: true, 点了: clean(btn.innerText) };
      });
      say('⑤ 在当前规格后添加:', accept);
      await sleep(8000);
      scan = await scanTable(page);
      say('⑥ 导入后 SKU 表:', scan.ok ? `读到 ${scan.unique} 行` : scan.why);
    } else {
      say('   → 已是期望行数，跳过导入（避免重复追加）');
    }

    // ⑦ 对账
    const got = new Set((scan.all || []).map((r) => r.spec));
    const missing = [...EXPECT_SET].filter((k) => !got.has(k));
    const extra = [...got].filter((k) => !EXPECT_SET.has(k));
    say(`⑦ 对账：期望 ${EXPECT_SET.size} | 读到 ${got.size} | 缺 ${missing.length} | 多 ${extra.length}`);
    if (missing.length) say('   缺:', missing.slice(0, 8));
    if (extra.length) say('   多:', extra.slice(0, 8));

    // ⑧ 一口价 + 总库存
    let price = null;
    if (!SKIP_PRICE && LIST_PRICE != null) {
      const before = await readLabelled(page);
      say('⑧ 一口价/总库存（填之前）:', before);
      const set = await page.evaluate((v) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const all = Array.from(document.querySelectorAll('div,span,label,p')).filter(vis);
        let target = null;
        for (const i of Array.from(document.querySelectorAll('input')).filter(vis)) {
          const r = i.getBoundingClientRect();
          const cy = r.top + r.height / 2;
          let lbl = null, best = 1e9;
          for (const e of all) {
            if (e.contains(i)) continue;
            const b = e.getBoundingClientRect();
            if (b.top + b.height / 2 < cy - 10 || b.top + b.height / 2 > cy + 10) continue;
            if (b.left + b.width > r.left + 4) continue;
            const t = clean(e.innerText);
            if (!t || t.length > 24) continue;
            const d = r.left - (b.left + b.width);
            if (d < best) { best = d; lbl = t; }
          }
          if (lbl && lbl.replace(/\s*\*\s*$/, '').trim() === '一口价') { target = i; break; }
        }
        if (!target) return { ok: false, why: 'no_price_input' };
        if (String(target.value) === String(v)) return { ok: true, already: true, 读回: target.value };
        target.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(target, String(v));
        for (const ev of ['input', 'change', 'blur']) target.dispatchEvent(new Event(ev, { bubbles: true }));
        return { ok: true, 读回: target.value };
      }, LIST_PRICE);
      say('   → 填一口价:', set);
      await sleep(2500);
      const after = await readLabelled(page);
      say('   读回:', after);
      const err = await page.evaluate(() => {
        const t = (document.body.innerText || '').replace(/\s+/g, ' ');
        return (t.match(/一口价[^。\n]{0,40}(错误|必须|大于)[^。\n]{0,40}/) || [])[0] || null;
      });
      price = { set, after, 报错: err };
      if (err) say('   ⚠ 页面报错:', err);
    }

    const ok = scan.ok && missing.length === 0 && extra.length === 0 && (!price || price.set.ok) && !(price && price.报错);
    console.log('\n' + JSON.stringify({ ok, SKU行数: scan.unique, 期望: EXPECT, 缺: missing.length, 多: extra.length, 一口价: price ? price.after['一口价'] : null, 总库存: price ? price.after['总库存'] : null }, null, 1));
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
