#!/usr/bin/env node
/**
 * 核对：**编辑规格抽屉里 9 个图位到底挂的是哪张图**（防颜色串位）。
 * 背景：`tb_fill_spec_images.js` 的读回只有「图位总数/已有图/空图位」三个计数 —— 计数全绿也可能
 *   把 9 张图挂错颜色（规格图头号废品原因）。这里额外做两件事：
 *   ① 图位挂的 img src 必须**与颜色一一对应**（相同 src 挂到不同颜色 = 串位）；
 *   ② 把每个图位**相邻的规格值文本**和它的 img src 一起打出来，人工/程序都能核对配对。
 *
 * ★ 2026-10-30 实测踩到的假阳性：抽屉是**虚拟滚动 + 图片懒加载**。不滚到底就读，
 *   第 37–54 格 img 会是 `complete=false / naturalWidth=0`，看起来像「规格图没上传完成」，
 *   实际滚到位停 2 秒就全部加载。所以这里**先滚到底等加载**再读数，判定用 naturalWidth>0，
 *   不只看有没有 <img>。
 *
 * 用法：node tests/verify_spec_images.js [--port 9120] [--wait 4000]
 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const WAIT = Number(arg('wait', 4000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 逐个把图位滚进视区触发懒加载。
// 不依赖「抽屉内部有没有滚动条」：实测抽屉有时有内滚（高 915px），有时被撑成全高（3678px），
// 那时只能靠滚动窗口让图位经过视区 —— 两种都要能触发，否则后半段永远是假坏图。
const countSlots = () => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const d = Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis)[0];
  if (!d) return 0;
  return Array.from(d.querySelectorAll('.sell-color-option-image-upload')).filter(vis).length;
};

async function primeImages(page) {
  const n = await page.evaluate(countSlots);
  if (!n) return { 图位: 0 };
  const before = await page.evaluate(() => window.scrollY);
  const step = Math.max(1, Math.ceil(n / 8));
  for (let i = 0; i < n; i += step) {
    await page.evaluate((i) => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const d = Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis)[0];
      if (!d) return;
      const slots = Array.from(d.querySelectorAll('.sell-color-option-image-upload')).filter(vis);
      const s = slots[Math.min(i, slots.length - 1)];
      if (s) s.scrollIntoView({ block: 'center' });
    }, i);
    await sleep(600);
  }
  await page.evaluate((y) => window.scrollTo(0, y), before);
  await sleep(500);
  return { 图位: n };
}

const READ = () => {
  const cls = (e) => String((e && e.getAttribute && e.getAttribute('class')) || '');
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const d = Array.from(document.querySelectorAll('.sku-decouple-drawer-container')).filter(vis)[0];
  if (!d) return { 抽屉不在: true };
  const slots = Array.from(d.querySelectorAll('.sell-color-option-image-upload')).filter(vis);
  const rows = slots.map((s, i) => {
    const img = s.querySelector('img');
    const rect = s.getBoundingClientRect();
    // 图位**左边**那一列通常是规格值文本；取其祖先行里的文字
    let row = s.parentElement;
    for (let k = 0; k < 4 && row; k++) { if (clean(row.innerText).length > 1) break; row = row.parentElement; }
    // 规格值 = 抽屉里同一 y 附近的文本
    const all = Array.from(d.querySelectorAll('*')).filter(vis)
      .filter((e) => e.children.length === 0 && clean(e.innerText))
      .map((e) => { const rr = e.getBoundingClientRect(); return { t: clean(e.innerText), y: Math.round(rr.top + rr.height / 2), x: Math.round(rr.right) }; })
      .filter((x) => Math.abs(x.y - Math.round(rect.top + rect.height / 2)) < 14 && x.x < rect.left)
      .sort((a, b) => b.x - a.x);
    return {
      序: i + 1,
      图位: { x: Math.round(rect.left), y: Math.round(rect.top) },
      有图: !!img,
      加载成功: !!(img && img.complete && img.naturalWidth > 0),
      尺寸: img ? `${img.naturalWidth}x${img.naturalHeight}` : null,
      src: img ? String(img.src).slice(-60) : null,
      左侧文本: all.slice(0, 2).map((x) => x.t),
    };
  });
  const srcs = rows.map((x) => x.src).filter(Boolean);
  return {
    图位数: slots.length,
    有图: srcs.length,
    加载成功: rows.filter((x) => x.加载成功).length,
    唯一src数: new Set(srcs).size,
    src分布: Object.fromEntries([...new Set(srcs)].map((s) => [s, srcs.filter((x) => x === s).length])),
    行: rows,
  };
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const p = browser.contexts()[0].pages().filter((x) => /publish\.htm/.test(x.url())).pop();
    if (!p) throw new Error('找不到发布页（publish.htm）');
    // ① 逐个图位滚进视区，把懒加载全部触发，再读数
    const primed = await primeImages(p);
    if (!primed.图位) {
      console.error('抽屉没打开：先在发布页点「编辑规格」把抽屉打开，再跑本脚本');
      process.exit(3);
    }
    let r = await p.evaluate(READ);
    // 仍有没加载出来的，等一轮再读一次（图片空间转码偶尔慢）
    if ((r.行 || []).some((x) => x.有图 && !x.加载成功)) {
      await sleep(WAIT);
      r = await p.evaluate(READ);
    }
    console.log(JSON.stringify({ 图位数: r.图位数, 有图: r.有图, 加载成功: r.加载成功, 加载失败: (r.图位数 || 0) - (r.加载成功 || 0), 唯一src数: r.唯一src数, src分布: r.src分布 }, null, 1));
    console.log('--- 逐格 ---');
    for (const x of (r.行 || [])) console.log(`  ${x.序}\t${x.加载成功 ? 'OK ' : (x.有图 ? 'NG ' : '空 ')}\t${x.尺寸 || '-'}\t${x.src ? String(x.src).split('/').pop().split('_')[0] : ''}\t${(x.左侧文本 || []).join(' ')}`);

    // 判定「到底传上没有」。触发懒加载 + 等一轮之后仍然空 / 取不到图的，就是没传上，
    // 不能再拿「可能是懒加载」放过 —— 实测 MZB-001 报过 18 格 naturalWidth=0，用户看到的就是真空白。
    const rows = r.行 || [];
    const empty = rows.filter((x) => !x.有图);
    const bad = rows.filter((x) => x.有图 && !x.加载成功);
    if (empty.length || bad.length) {
      console.error('\n✗ 规格图没传上：');
      if (empty.length) console.error(`   空图位 ${empty.length} 个（格号 ${empty.map((x) => x.序).join(',')}）`);
      if (bad.length) console.error(`   有 img 但取不到图 ${bad.length} 个（格号 ${bad.map((x) => x.序).join(',')}）`);
      console.error('   重跑上传：node scripts/tb_fill_spec_images.js --dir <img/spec> --product <product.json>');
      process.exitCode = 4;
    }
    const n = new Set(rows.map((x) => x.src).filter(Boolean));
    const filled = rows.filter((x) => x.src).length;
    if (n.size !== filled) console.log('\n（同一张图挂到了多个图位。若规格是「单列 N 色 × M 尺寸」，同色各行共用一张是正常语义；不同颜色共用才是串位）');
  } finally { await browser.close().catch(() => {}); }
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
