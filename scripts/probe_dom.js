#!/usr/bin/env node
/**
 * 只读 DOM 侦察器（**不改页面、不点东西**）。
 *
 * 用途：淘宝发布页改版频繁，摸结构时要反复「看一眼页面长什么样」。
 * 这个工具把这件事变成一条命令，避免每次现写脚本（也避免把临时脚本丢进临时目录被清掉）。
 *
 * 用法（先 . scripts\resolve_env.ps1 拿到 $TbEnv，或直接指定端口）：
 *   node scripts/probe_dom.js --port 9120                       # 列出页面 + 标题
 *   node scripts/probe_dom.js --port 9120 --text 60             # 打印页面正文前 60 行
 *   node scripts/probe_dom.js --port 9120 --find "一口价" --ctx 3
 *   node scripts/probe_dom.js --port 9120 --sel "input[type=file]"
 *   node scripts/probe_dom.js --port 9120 --url-re "publish\\.htm" --sel "[class*=add_title]"
 *
 * 铁律：**只读**。不要在这里加点击/输入 —— 那些属于 tb_flow.js（要配套读回与幂等）。
 */
const path = require('path');
const http = require('http');
const { resolvePlaywrightCore } = require(path.join(__dirname, 'pwresolver.js'));
const { guardCheck } = require(path.join(__dirname, 'guard.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const URL_RE = String(arg('url-re', 'taobao\\.com'));
const SEL = arg('sel', null);
const FIND = arg('find', null);
const CTX = Number(arg('ctx', 2));
const TEXT = arg('text', null);
const LIMIT = Number(arg('limit', 20));

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  const list = await getJSON('/json/list').catch((e) => { console.error('端口不可达:', e.message); process.exit(2); });
  const pages = list.filter((t) => t.type === 'page');
  const targets = pages.filter((t) => new RegExp(URL_RE).test(t.url || ''));
  console.log(`端口 ${PORT}：页面 ${pages.length} 个，匹配 --url-re "${URL_RE}" 的 ${targets.length} 个`);
  targets.forEach((t, i) => console.log(`  [${i}] ${(t.title || '').slice(0, 40)} | ${(t.url || '').slice(0, 100)}`));
  if (!targets.length) return;

  // 注意：pwresolver 的 resolvePlaywrightCore() 返回 { pw, how, spec }（不是模块本身）
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (!new RegExp(URL_RE).test(page.url())) continue;
        console.log('\n===== ' + page.url().slice(0, 110));
        const out = await Promise.race([
          page.evaluate(({ sel, find, ctxN, textN, limit }) => {
            const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const cls = (e) => (e && typeof e.className === 'string' ? e.className : '');
            const res = {};
            if (textN) {
              res.lines = document.body.innerText.split('\n').map(clean).filter(Boolean).slice(0, Number(textN));
            }
            if (find) {
              const lines = document.body.innerText.split('\n').map(clean);
              res.found = [];
              lines.forEach((l, i) => { if (l.includes(find)) res.found.push({ i, around: lines.slice(Math.max(0, i - ctxN), i + ctxN + 1) }); });
            }
            if (sel) {
              res.nodes = Array.from(document.querySelectorAll(sel)).slice(0, limit).map((e) => ({
                tag: e.tagName.toLowerCase(),
                cls: cls(e).split(/\s+/).slice(0, 3).join(' '),
                id: e.id || null,
                name: e.getAttribute('name') || null,
                ph: e.getAttribute('placeholder') || null,
                text: clean(e.innerText).slice(0, 60) || null,
                box: (() => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; })(),
                html: e.outerHTML.slice(0, 240),
              }));
              res.nodeCount = document.querySelectorAll(sel).length;
            }
            return res;
          }, { sel: SEL, find: FIND, ctxN: CTX, textN: TEXT, limit: LIMIT }),
          new Promise((r) => setTimeout(() => r({ timeout: true }), 20000)),
        ]);
        if (out.timeout) { console.log('  （evaluate 超时，跳过这个页）'); continue; }
        if (out.lines) { console.log(`-- 正文前 ${out.lines.length} 行 --`); out.lines.forEach((l, i) => console.log(`  ${i}: ${l.slice(0, 120)}`)); }
        if (out.found) {
          console.log(`-- 含「${FIND}」的行 ${out.found.length} 处 --`);
          out.found.slice(0, 8).forEach((f) => console.log(`  [行 ${f.i}] ` + JSON.stringify(f.around)));
        }
        if (out.nodes) {
          console.log(`-- 选择器 "${SEL}" 命中 ${out.nodeCount} 个（显示前 ${out.nodes.length}）--`);
          out.nodes.forEach((n) => console.log('  ' + JSON.stringify(n)));
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
