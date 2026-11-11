#!/usr/bin/env node
/**
 * 抓「类目元数据」：只凭 catId，从发布页 DOM 读出**类目属性清单**（属性名 + pid + 是否必填），
 * 再调 tb_download_template.js 下该类目的**官方 SKU 模板**（规格列就来自它的表头）。
 *
 * 为什么要走 DOM 而不是接口：实测发布页的 asyncOpt.htm 只返回表单 schema（deliverVolumn 那类），
 * 不含类目属性元数据；而 DOM 里的 `sell-field-p-<pid>` 就带着属性名和「* / 重要」标记，
 * 和素材包 Excel R2/R4 的 required 名单一致（猫抓板实测 3 个必填完全对上）。
 *
 * 输出（stdout，最后几行便于上层解析）：
 *   CAT=<类目路径>
 *   ATTRS=<attrs.json 路径>
 *   TPL=<官方模板路径>
 *
 * 用法：node scripts/pack_meta.js --catid 50003280 [--out output/_skeleton] [--port 9120]
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { resolvePlaywrightCore } = require(path.join(__dirname, 'pwresolver.js'));
const { guardCheck } = require(path.join(__dirname, 'guard.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const CATID = String(arg('catid', ''));
const OUT = path.resolve(String(arg('out', 'output/_skeleton')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READ_FIELDS = () => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const topY = (e) => Math.round(e.getBoundingClientRect().top + window.scrollY);

  // ① 带 pid 的（发布页会给部分属性 `sell-field-p-<pid>` 的 id）
  const withPid = Array.from(document.querySelectorAll('[id^="sell-field-p-"]')).map((f) => {
    const t = clean(f.innerText);
    const m = t.match(/^(\* ?)?([^ ]+)/);
    // kind 用来判「数值 + 单位」组合控件（taoSirProp，如「计价单位」= 1 + 卷）——
    // 这类属性在素材包里是**两列**（`计价单位` + `计价单位(单位)`），生成器要据此拆列。
    const cls = String(f.className || '');
    const kind = ['combobox', 'select', 'checkbox', 'input', 'taoSirProp'].find((k) => new RegExp('(^|\\s)' + k).test(cls)) || '?';
    return { pid: f.id.replace('sell-field-p-', ''), 名: (m && m[2]) || '', 必填: /^[*＊]/.test(t) || /重要/.test(t.slice(0, 40)), kind };
  });

  // ② 没有 pid 的属性（实测墙纸类目：「是否定制」「采购地」就没有这个 id）——
  //    用「类目属性」标题到「销售规格」标题这段**纵向区间**里的所有属性容器补齐。
  const findTitleY = (re) => {
    let y = null;
    for (const e of document.querySelectorAll('*')) {
      if (e.children.length) continue;
      const t = clean(e.innerText);
      if (t.length < 14 && re.test(t) && vis(e)) { y = topY(e); break; }
    }
    return y;
  };
  const y0 = findTitleY(/^类目属性/);
  const y1 = findTitleY(/^销售规格/);
  const wrappers = (y0 != null && y1 != null && y1 > y0)
    ? Array.from(document.querySelectorAll('.sell-component-info-wrapper-wrap')).filter(vis)
        .map((w) => ({ y: topY(w), t: clean(w.innerText) }))
        .filter((x) => x.y > y0 && x.y < y1)
        .map((x) => {
          const star = /\*/ .test(x.t);
          const name = x.t.replace(/^\*[ ]*/, '').split(' ')[0];
          return { pid: null, 名: name, 必填: star, 文本: x.t.slice(0, 30) };
        })
        .filter((x) => x.名 && x.名 !== '类目属性' && x.名 !== '销售规格')   // 这两个是区标题，不是属性
    : [];

  // 合并：区间顺序为准，有 pid 的补上 pid
  const byName = {};
  for (const f of withPid) if (f.名) byName[f.名] = f;
  for (const w of wrappers) if (!byName[w.名]) byName[w.名] = w;
  const fields = (wrappers.length ? wrappers.map((w) => byName[w.名]) : withPid);

  // 类目路径：那段文本通常在一个**非叶子**容器里（"A>>B>>C 切换类目 图文描述…"），
  // 所以取"包含 >> 和 切换类目 的最短文本"（最短 = 最内层）。
  let cat = null;
  let best = null;
  for (const e of document.querySelectorAll('*')) {
    const t = clean(e.innerText);
    if (!t || t.length > 200 || !/切换类目/.test(t) || !/>>/.test(t)) continue;
    if (!best || t.length < best.length) best = t;
  }
  if (best) cat = best.split('切换类目')[0].split('>>').map((x) => clean(x)).filter(Boolean).join(' > ');
  return { fields, cat, 区间: { y0, y1, 容器数: wrappers.length, 带pid: withPid.length } };
};

(async () => {
  if (!CATID) { console.error('★ 需要 --catid'); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const ctx = browser.contexts()[0];
    // ★ 不能用 newPage()：这条 CDP 连接上新建的 tab 会被立刻关掉（实测 Target closed）
    const page = ctx.pages()[0];
    if (!page) throw new Error('没有可用的页面');
    const url = `https://item.upload.taobao.com/sell/v2/publish.htm?catId=${CATID}&fromAICategory=true&keyProps=%7B%7D&fromAIPublish=true&newRouter=1`;
    console.log('① 打开该类目发布页:', CATID);
    await page.goto(url, { waitUntil: 'load', timeout: 90000 }).catch((e) => console.log('   goto:', e.message.slice(0, 60)));

    // ★ 属性区默认折叠（"展开补充更多信息"），不点开只能读到首屏那几个 ——
    //   实测墙纸类目：只读到 2 个属性，而该类目实际有 15 个。
    const expanded = await page.evaluate(async () => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const sl = (ms) => new Promise((r) => setTimeout(r, ms));
      const done = [];
      for (let pass = 0; pass < 5; pass++) {
        const cands = Array.from(document.querySelectorAll('div,span,a,button')).filter(vis)
          .filter((e) => /^(展开补充更多信息|展开|更多属性|查看更多|展开全部)$/.test(clean(e.innerText)));
        const el = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)))[0];
        if (!el) break;
        el.scrollIntoView({ block: 'center' });
        for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        done.push(clean(el.innerText));
        await sl(1500);
      }
      return done;
    }).catch(() => []);
    if (expanded.length) console.log('①b 展开了折叠区:', expanded.join(' / '));

    // 轮询等属性字段渲染出来（最多 60s）
    let got = { fields: [], cat: null };
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      got = await page.evaluate(READ_FIELDS);
      if (got.fields.length) break;
    }
    if (!got.fields.length) {
      console.error('★ 页面上没有读到属性字段：可能没登录、或该类目发布页没进表单');
      process.exit(3);
    }
    console.log(`② 读到属性 ${got.fields.length} 个（必填 ${got.fields.filter((f) => f.必填).length}）`);
    if (got.区间) console.log(`   「类目属性 → 销售规格」区间 [${got.区间.y0} → ${got.区间.y1}]：容器 ${got.区间.容器数} 个，其中带 pid 的 ${got.区间.带pid} 个`);
    for (const f of got.fields) console.log(`   ${f.必填 ? '★' : ' '} ${f.名}  (p=${f.pid}${f.kind && f.kind !== '?' ? ' | ' + f.kind : ''})`);
    if (got.cat) console.log('   类目路径:', got.cat);

    const attrsFile = path.join(OUT, `attrs_${CATID}.json`);
    fs.writeFileSync(attrsFile, JSON.stringify(got.fields, null, 1), 'utf8');

    // ③ 下官方 SKU 模板（规格列以它为准）
    console.log('③ 下载官方 SKU 模板 …');
    let tpl = null;
    try {
      const out = execFileSync(process.execPath, [path.join(__dirname, 'tb_download_template.js'), '--catid', CATID, '--out', path.join(OUT, 'downloads')], { encoding: 'utf8', timeout: 180000 });
      const m = out.split(/\r?\n/).filter((l) => /\.(xls|xlsx)/i.test(l)).pop();
      tpl = m ? m.trim().replace(/^.*?: /, '') : null;
      if (tpl && !fs.existsSync(tpl)) tpl = null;
    } catch (e) {
      console.log('   下载失败:', e.message.split('\n')[0].slice(0, 80));
    }
    if (!tpl) {
      const dir = path.join(OUT, 'downloads');
      const cands = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /SKU模板/.test(f)) : [];
      if (cands.length) {
        tpl = path.join(dir, cands.sort().pop());
      }
    }
    if (!tpl || !fs.existsSync(tpl)) {
      console.error('★ 没拿到官方 SKU 模板 → 规格列没法确定（该步骤需要点「批量导入 → 下载模版」）');
      process.exit(4);
    }
    console.log('   模板:', tpl);

    console.log('CAT=' + (got.cat || ''));
    console.log('ATTRS=' + attrsFile);
    console.log('TPL=' + tpl);
  } finally { await browser.close().catch(() => {}); }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
