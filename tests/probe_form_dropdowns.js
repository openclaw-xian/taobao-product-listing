#!/usr/bin/env node
/**
 * 侦察：**表单页**三个填不上的属性 —— 品牌 p-20000 / 主图案类型 p-20603 / 适用空间 p-1626518。
 * 背景（地毯 catId 50000582 实测）：
 *   · 品牌 → pickAutoComplete「打字+点空白」读回为空（on the form page it's a 1180-item list）
 *   · 主图案类型 → pickOption 报 option_not_found，弹层文本「无选项 未找到合适的值，点击申请」
 *   · 适用空间 → pickOption 报 option_not_found，弹层文本「无选项」
 * 要弄清：控件真实结构 / 打开后有没有选项 / 有没有自带搜索框 / 是不是多选（多值要怎么给）。
 *
 * 用法：node tests/probe_form_dropdowns.js [--port 9120]
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGETS = [
  { pid: '20000', name: '品牌', kw: '无品牌' },
  { pid: '20603', name: '主图案类型', kw: '条纹' },
  { pid: '1626518', name: '适用空间', kw: '阳台' },
];

const boxDump = (pid) => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const box = document.querySelector('#sell-field-p-' + pid);
  if (!box) return { 无容器: true };
  box.scrollIntoView({ block: 'center' });
  const inputs = Array.from(box.querySelectorAll('input')).filter(vis).map((i) => {
    const r = i.getBoundingClientRect();
    return {
      placeholder: i.getAttribute('placeholder'), name: i.getAttribute('name'), role: i.getAttribute('role'),
      aria: i.getAttribute('aria-expanded'), readonly: i.readOnly, 值: i.value,
      中: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      cls: clean(i.className).slice(0, 40),
    };
  });
  const trig = Array.from(box.querySelectorAll('.next-select-trigger,.next-select,[class*=trigger],[role=combobox]')).filter(vis)[0];
  let trigPos = null;
  if (trig) { const r = trig.getBoundingClientRect(); trigPos = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), cls: clean(trig.className).slice(0, 50) }; }
  const inlineOpts = Array.from(box.querySelectorAll('.next-checkbox,.next-radio,[class*=option-item]')).filter(vis).length;
  return {
    容器class: clean(box.className).slice(0, 70),
    容器文本: clean(box.innerText).slice(0, 120),
    inputs, trigger: trigPos, 容器内联选项数: inlineOpts,
  };
};

const popupDump = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const pops = Array.from(document.querySelectorAll('.next-overlay-wrapper,.next-select-menu-wrapper,[class*=overlay]')).filter(vis);
  const p = pops[pops.length - 1];
  if (!p) return { 无弹层: true };
  const items = Array.from(p.querySelectorAll('.options-item,.next-menu-item,[class*=option-item]')).filter(vis);
  const inputs = Array.from(p.querySelectorAll('input')).filter(vis).map((i) => ({
    placeholder: i.getAttribute('placeholder'), name: i.getAttribute('name'), 值: i.value,
  }));
  return {
    弹层class: clean(p.className).slice(0, 60),
    弹层文本: clean(p.innerText).slice(0, 200),
    选项数: items.length,
    选项前20: items.slice(0, 20).map((e) => clean(e.innerText)),
    弹层内输入框: inputs,
    可滚容器: !!p.querySelector('.options-content,.next-menu-content,[class*=content]'),
  };
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const cands = browser.contexts()[0].pages().filter((p) => /publish\.htm/.test(p.url()));
    const page = cands[cands.length - 1];
    if (!page) { console.log('没有 publish.htm 页'); process.exit(1); }
    console.log('工作页:', page.url().slice(0, 90));

    for (const t of TARGETS) {
      console.log('\n========== ' + t.name + ' (p-' + t.pid + ') 期望值: ' + t.kw + ' ==========');
      const before = await page.evaluate(boxDump, t.pid);
      console.log('容器:', JSON.stringify(before));
      if (before.无容器) continue;

      // 真实鼠标点打开
      const clickPos = before.trigger || (before.inputs[0] && before.inputs[0].中);
      if (!clickPos) { console.log('没有可点位置'); continue; }
      await page.mouse.click(clickPos.x, clickPos.y);
      await sleep(1800);
      console.log('打开后弹层:', JSON.stringify(await page.evaluate(popupDump)));

      // 有搜索框就打字过滤
      const typed = await page.evaluate(({ pid, kw }) => {
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const pops = Array.from(document.querySelectorAll('.next-overlay-wrapper,.next-select-menu-wrapper,[class*=overlay]')).filter(vis);
        const p = pops[pops.length - 1];
        if (p) {
          const si = Array.from(p.querySelectorAll('input')).filter(vis)[0];
          if (si) {
            si.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(si, kw);
            si.dispatchEvent(new Event('input', { bubbles: true }));
            return 'typed-in-popup';
          }
        }
        const box = document.querySelector('#sell-field-p-' + pid);
        const si2 = box ? Array.from(box.querySelectorAll('input')).filter(vis).find((i) => !i.readOnly) : null;
        if (si2) {
          si2.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(si2, kw);
          si2.dispatchEvent(new Event('input', { bubbles: true }));
          return 'typed-in-box';
        }
        return 'no-search-input';
      }, t);
      await sleep(1800);
      console.log('过滤(' + t.kw + '):', typed, JSON.stringify(await page.evaluate(popupDump)));

      // 关掉：点右上空白
      await page.mouse.click(1260, 40).catch(() => {});
      await sleep(900);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
