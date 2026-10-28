#!/usr/bin/env node
/**
 * 单属性 DOM 探针：看清某个 `#sell-field-p-<id>` 的**控件结构**（尤其 checkbox 类的选项在哪）。
 *
 * 背景：`scripts/tb_fill_basic.js` 填「适用猫体型」时报 `option_not_found`，
 * 容器 innerText 只有 "* 适用猫体型"（选项不在容器里）→ 需要看 DOM。
 *
 * 用法：
 *   node tests/probe_prop_dom.js --pid 589717463            # 只读结构
 *   node tests/probe_prop_dom.js --pid 589717463 --click     # 顺便点一下容器，看弹出什么
 * 日志：tests/_prop_dom.log
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
const PID = String(arg('pid', '589717463'));
const CLICK = !!arg('click', false);
const LOG = path.join(__dirname, '_prop_dom.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(LOG, `== probe_prop_dom pid=${PID} click=${CLICK} ${new Date().toISOString()} ==\n`);
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

const struct = (pid) => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const box = document.querySelector('#sell-field-p-' + pid);
  if (!box) return { ok: false, why: 'no_box' };
  const kids = Array.from(box.querySelectorAll('*')).slice(0, 26).map((e) => ({
    tag: e.tagName.toLowerCase(),
    cls: String(e.className || '').slice(0, 60),
    text: clean(e.innerText).slice(0, 26),
    vis: vis(e),
  }));
  return {
    ok: true,
    容器class: String(box.className).slice(0, 140),
    容器尺寸: (() => { const r = box.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top) }; })(),
    容器innerText: clean(box.innerText).slice(0, 90),
    容器内input: Array.from(box.querySelectorAll('input')).map((i) => ({ type: i.type, checked: i.checked, value: i.value, cls: String(i.className).slice(0, 40) })),
    子元素: kids,
    下一个兄弟: box.nextElementSibling ? { tag: box.nextElementSibling.tagName.toLowerCase(), cls: String(box.nextElementSibling.className).slice(0, 80), text: clean(box.nextElementSibling.innerText).slice(0, 80), 含输入: box.nextElementSibling.querySelectorAll('input').length } : null,
    父级: box.parentElement ? { cls: String(box.parentElement.className).slice(0, 80), text: clean(box.parentElement.innerText).slice(0, 70), 有多少属性块: box.parentElement.querySelectorAll('[id^="sell-field-p-"]').length } : null,
  };
};

const afterClick = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const pick = (sel) => Array.from(document.querySelectorAll(sel)).filter(vis).map((e) => clean(e.innerText).slice(0, 24)).filter(Boolean).slice(0, 24);
  return {
    可见checkbox: pick('[class*=next-checkbox]'),
    可见checkboxItem: pick('[class*=checkbox-item],[class*=checkboxItem]'),
    可见optionsItem: pick('.options-item'),
    可见弹窗: Array.from(document.querySelectorAll('.next-dialog,.next-overlay-inner,[class*=popup],[class*=layer]')).filter(vis).map((e) => clean(e.innerText).slice(0, 120)).slice(0, 5),
    可见label: pick('label'),
  };
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { log('找不到可用发布页'); process.exitCode = 1; return; }
    log('页面:', page.url().slice(0, 90));
    log('\n--- 点击前 ---', await page.evaluate(struct, PID));

    if (CLICK) {
      const r = await page.evaluate((pid) => {
        const vis = (e) => { if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
        const box = document.querySelector('#sell-field-p-' + pid);
        if (!box) return { ok: false, why: 'no_box' };
        const target = box.querySelector('input,label,span,div') || box;
        target.scrollIntoView({ block: 'center' });
        for (const ev of ['mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        return { ok: true, 点了: target.tagName.toLowerCase() + '.' + String(target.className).slice(0, 40) };
      }, PID);
      log('\n--- 点击 ---', r);
      await sleep(2500);
      log('\n--- 点击后 ---', await page.evaluate(afterClick));
      log('\n--- 点击后容器 ---', await page.evaluate(struct, PID));
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('FAIL: ' + e.message); process.exit(1); });
