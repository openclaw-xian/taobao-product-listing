#!/usr/bin/env node
/**
 * 侦察步工具：**按可见文本点一下 + 读回页面状态**（只用于摸结构，不写业务逻辑）。
 *
 * 为什么单独写它而不是直接写进 tb_flow.js：tb_flow 的每一步都要有「幂等 + 读回 + 失败原因」，
 * 而侦察阶段只想知道「点了会去哪、页面上有什么」。等结构摸清了，再把结论固化成 tb_flow 的函数。
 *
 * 用法：
 *   node tests/recon_step.js --port 9120 --click "开启" --nth 0 --wait 6000
 *   node tests/recon_step.js --port 9120 --click "确认，下一步"
 *   node tests/recon_step.js --port 9120 --dump                  # 只读当前页
 *   node tests/recon_step.js --port 9120 --type "input[placeholder*=关键词]" --value "猫抓板" --wait 5000
 *   node tests/recon_step.js --port 9120 --focus 'input[placeholder*="条码"]' --key Enter --wait 6000
 *      ↑ 搜索框要**按回车**才触发搜索（点「搜索」按钮无效 —— 用户 2026-10-10 指出）
 *
 * 注意：
 *   · 点击用**原生 el.click()**（拼多多/抖店的实测：合成事件对 React 无效，Playwright click 常被浮层拦）
 *   · 每次动作后自动 dump 一次（url / title / 关键文本 / 输入框 / 按钮）
 */
const path = require('path');
const http = require('http');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const CLICK = arg('click', null);
const NTH = Number(arg('nth', 0));
const WAIT = Number(arg('wait', 5000));
const URL_RE = String(arg('url-re', 'taobao\\.com'));
const TYPE_SEL = arg('type', null);
const VALUE = arg('value', null);
const SEL_CLICK = arg('sel-click', null);
const REAL_CLICK = arg('real-click', null);
const FOCUS = arg('focus', null);
const KEY = arg('key', null);
const SHOT = arg('shot', null);
const NO_DUMP = arg('no-dump', false);

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

const DUMP = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const inputs = Array.from(document.querySelectorAll('input,textarea,select')).filter(vis).map((e) => ({
    tag: e.tagName.toLowerCase(), type: e.getAttribute('type') || null, id: e.id || null,
    name: e.getAttribute('name') || null, ph: e.getAttribute('placeholder') || null,
    cls: (typeof e.className === 'string' ? e.className : '').split(/\\s+/).slice(0, 3).join(' '),
    val: 'value' in e ? String(e.value).slice(0, 30) : null,
  }));
  const buttons = Array.from(document.querySelectorAll('button,[role=button],a')).filter(vis)
    .map((e) => clean(e.innerText).slice(0, 24)).filter(Boolean);
  const iframes = Array.from(document.querySelectorAll('iframe')).map((f) => ({ src: (f.getAttribute('src') || '').slice(0, 90), name: f.getAttribute('name') || null, id: f.id || null }));
  const fileInputs = document.querySelectorAll('input[type=file]').length;
  return {
    url: location.href, title: document.title,
    lines: document.body.innerText.split('\\n').map(clean).filter(Boolean).slice(0, 60),
    inputs: inputs.slice(0, 25), buttons: Array.from(new Set(buttons)).slice(0, 40),
    iframes, fileInputs,
  };
})()`;

(async () => {
  const list = await getJSON('/json/list').catch((e) => { console.error('端口不可达:', e.message); process.exit(2); });
  const pages = list.filter((t) => t.type === 'page' && new RegExp(URL_RE).test(t.url || ''));
  if (!pages.length) { console.error('没有匹配 --url-re 的页面'); process.exit(2); }
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (!new RegExp(URL_RE).test(page.url())) continue;
        console.log('页面:', page.url().slice(0, 110));

        if (CLICK) {
          const r = await page.evaluate(({ t, n }) => {
            const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
            const all = Array.from(document.querySelectorAll('button,[role=button],a,span,div,label'))
              .filter((e) => vis(e) && clean(e.innerText) === t);
            if (!all.length) return { ok: false, why: 'no_match', tried: t };
            // ★ 优先真正的按钮，再取「不包含其它同名候选」的最内层 ——
            //   否则会点到外层包裹 div（点了没反应，实测踩过）
            const btns = all.filter((e) => /^(button|a)$/i.test(e.tagName) || e.getAttribute('role') === 'button');
            const pool = btns.length ? btns : all;
            const inner = pool.filter((e) => !pool.some((o) => o !== e && e.contains(o)));
            const el = inner[Math.min(n, inner.length - 1)];
            const chain = [];
            let cur = el;
            for (let i = 0; i < 4 && cur; i++) { chain.push(cur.tagName.toLowerCase() + (typeof cur.className === 'string' && cur.className ? '.' + cur.className.split(/\s+/)[0] : '')); cur = cur.parentElement; }
            // ★ 有些 React 组件只认 mousedown/mouseup（实测：类目级联的叶子 el.click() 无效）
            for (const ev of ['mousedown', 'mouseup', 'click']) {
              el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
            }
            return { ok: true, clicked: clean(el.innerText).slice(0, 30), matched: all.length, usedButtons: btns.length, chain };
          }, { t: String(CLICK), n: NTH });
          console.log('点击结果:', JSON.stringify(r));
          await new Promise((res) => setTimeout(res, WAIT));
        }

        if (TYPE_SEL && VALUE !== null) {
          const r = await page.evaluate(({ sel, v }) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, why: 'not_found', sel };
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, val: el.value };
          }, { sel: String(TYPE_SEL), v: String(VALUE) });
          console.log('输入结果:', JSON.stringify(r));
          await new Promise((res) => setTimeout(res, WAIT));
        }

        // 按选择器点（同一套鼠标事件序列）——用于文本匹配不稳的元素（空格、跨元素拼接）
        if (SEL_CLICK) {
          const r = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, why: 'not_found', sel };
            for (const ev of ['mousedown', 'mouseup', 'click']) {
              el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
            }
            return { ok: true, tag: el.tagName.toLowerCase(), cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70) };
          }, String(SEL_CLICK));
          console.log('选择器点击:', JSON.stringify(r));
          await new Promise((res) => setTimeout(res, WAIT));
        }

        // 真实点击（Playwright / CDP Input 域）——**下载类按钮必须用它**：
        // 合成 MouseEvent 不算「用户手势」，Chrome 会静默拦掉下载（实测：点「下载模版」毫无反应、Downloads 里没有文件）
        if (REAL_CLICK) {
          try {
            await page.click(String(REAL_CLICK), { timeout: 15000 });
            console.log('真实点击:', REAL_CLICK);
          } catch (e) {
            console.log('真实点击失败:', e.message.split('\n')[0]);
          }
          await new Promise((res) => setTimeout(res, WAIT));
        }

        // 聚焦某个元素 + 按真实按键（搜索框要按回车才触发搜索 —— 点按钮无效）
        if (FOCUS || KEY) {
          if (FOCUS) {
            const f = await page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (!el) return { ok: false, why: 'not_found', sel };
              el.focus();
              return { ok: true, active: document.activeElement === el };
            }, String(FOCUS));
            console.log('聚焦:', JSON.stringify(f));
            await new Promise((res) => setTimeout(res, 400));
          }
          if (KEY) {
            await page.keyboard.press(String(KEY));   // 真实键盘事件（不是 dispatchEvent）
            console.log('按键:', KEY);
            await new Promise((res) => setTimeout(res, WAIT));
          }
        }

        if (!NO_DUMP) {
          const info = await Promise.race([page.evaluate(DUMP), new Promise((res) => setTimeout(() => res({ timeout: true }), 20000))]);
          console.log(JSON.stringify(info, null, 1));
        }
        if (SHOT) { await page.screenshot({ path: SHOT }); console.log('截图:', SHOT); }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
