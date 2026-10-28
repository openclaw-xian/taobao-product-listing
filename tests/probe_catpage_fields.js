#!/usr/bin/env node
/**
 * 侦察：地毯类目（catId 50000582）**类目页**到底有哪些输入框 / 有没有品牌字段。
 * 背景：tb_enter_form.js 的品牌定位要求 input[placeholder === '请输入']，本次报 no_brand_input；
 *       同时「确认，下一步」在选完类目后就已点亮（墙纸类目当时必须选品牌才亮）→ 怀疑本类目品牌选填或控件变了。
 *
 * 用法：node tests/probe_catpage_fields.js [--port 9120]
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

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const target = pages.find((p) => /category\.htm/.test(p.url())) || pages.find((p) => /upload\.taobao/.test(p.url()));
  if (!target) { console.log('没有 category.htm / upload.taobao 页面'); process.exit(1); }
  console.log('目标页:', target.url().slice(0, 140));

  const r = await target.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

    const inputs = Array.from(document.querySelectorAll('input')).map((i) => ({
      可见: vis(i),
      placeholder: i.getAttribute('placeholder'),
      name: i.getAttribute('name'),
      id: i.id || null,
      aria: i.getAttribute('aria-expanded'),
      role: i.getAttribute('role'),
      值: i.value,
      外层: (i.closest('[class]') ? clean(i.closest('[class]').className).slice(0, 60) : null),
    })).filter((x) => x.可见);

    const btns = Array.from(document.querySelectorAll('button')).filter(vis)
      .map((b) => ({ 文案: clean(b.innerText).slice(0, 30), disabled: !!b.disabled }))
      .filter((b) => /下一步|确认|搜索|发品/.test(b.文案));

    // 有没有「品牌」字样的容器
    const brandish = Array.from(document.querySelectorAll('div,label,span')).filter(vis)
      .filter((e) => /品牌/.test(clean(e.innerText)) && clean(e.innerText).length < 120)
      .map((e) => ({ tag: e.tagName, cls: clean(e.className).slice(0, 50), 文本: clean(e.innerText).slice(0, 90), 内含input: e.querySelectorAll('input').length }))
      .slice(0, 12);

    // 类目页上所有「* 属性名」形态的字段标题
    const fieldLabels = Array.from(document.querySelectorAll('div,label,span')).filter(vis)
      .filter((e) => /^\*?\s*[\u4e00-\u9fa5A-Za-z]{2,8}\s*$/.test(clean(e.innerText)) && e.children.length <= 1)
      .map((e) => clean(e.innerText)).filter((s) => /^\*/.test(s))
      .slice(0, 40);

    return {
      url: location.href.slice(0, 160),
      可见输入框数: inputs.length,
      inputs,
      buttons: btns,
      品牌相关: brandish,
      带星号字段: Array.from(new Set(fieldLabels)),
    };
  });
  console.log(JSON.stringify(r, null, 1));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
