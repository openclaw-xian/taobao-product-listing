#!/usr/bin/env node
/**
 * 侦察（阶段 4 · 关键实验）：把自造的 `sku_import.xlsx` 喂给**批量导入 → AI识别导入**，
 * 看它能不能识别、识别成什么样的规格/SKU。**只识别，不提交**。
 *
 * 用法：node tests/recon_ai_import.js --file "<...>\sku_import.xlsx" [--port 9120]
 *
 * 实测要点（写死在这里，避免下次又踩）：
 *   · 「下载模版」按钮文本是**模版**（不是模板），类名 `download-template-btn`；下载要用真实点击（合成事件不算用户手势）
 *   · 上传用 Playwright 的 setInputFiles（真实文件选择），别自己造 File 对象
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { resolvePlaywrightCore } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = String(arg('port', process.env.TB_PORT || '9120'));
const FILE = arg('file', null);
if (!FILE || !fs.existsSync(String(FILE))) { console.error('需要 --file 指向存在的 xlsx'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

const STATE = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
  const btns = dlg ? Array.from(dlg.querySelectorAll('button')).filter(vis).map((e) => ({ t: clean(e.innerText), disabled: !!e.disabled })) : [];
  // 规格组：找「添加规格图/规格名」类的区块；SKU 表：表格行
  const tables = Array.from(document.querySelectorAll('table')).filter(vis).map((t) => ({
    head: Array.from(t.querySelectorAll('th')).map((th) => clean(th.innerText).slice(0, 14)).filter(Boolean).slice(0, 12),
    rows: t.querySelectorAll('tbody tr').length,
  }));
  const specLabels = Array.from(document.querySelectorAll('[class*=sku] label, [class*=spec] label')).filter(vis).map((e) => clean(e.innerText).slice(0, 20)).filter(Boolean).slice(0, 20);
  const inputsN = Array.from(document.querySelectorAll('input')).filter(vis).length;
  const fileInputs = Array.from(document.querySelectorAll('input[type=file]')).length;
  const toasts = Array.from(document.querySelectorAll('[class*=toast],[class*=message],[class*=notice]')).filter(vis).map((e) => clean(e.innerText).slice(0, 80)).filter(Boolean);
  return { dialogOpen: !!dlg, dialogText: dlg ? clean(dlg.innerText).slice(0, 400) : null, btns, tables, specLabels, inputsN, fileInputs, toasts };
})()`;

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (!/publish\.htm/.test(page.url())) continue;
        const show = async (tag) => { const s = await page.evaluate(STATE); console.log(`\n== ${tag} ==\n` + JSON.stringify(s, null, 1)); };

        // ① 打开「批量导入」弹窗（真实点击）
        try { await page.click('button:has-text("批量导入")', { timeout: 10000 }); console.log('① 已点「批量导入」'); }
        catch (e) { console.log('① 点「批量导入」失败:', e.message.split('\n')[0]); }
        await sleep(3000);
        await show('① 弹窗状态');

        // ② 上传文件（真实文件选择）
        const inputs = await page.$$('input[type=file]');
        console.log('② 页面上的 file input 数:', inputs.length);
        if (!inputs.length) { console.log('   没有 file input → 停'); continue; }
        const target = inputs[inputs.length - 1];
        await target.setInputFiles(String(FILE));
        console.log('   已 setInputFiles:', path.basename(String(FILE)));
        await sleep(4000);
        await show('② 上传后');

        // ③ 点「确认识别」（真实点击）
        try { await page.click('button:has-text("确认识别")', { timeout: 10000 }); console.log('③ 已点「确认识别」'); }
        catch (e) { console.log('③ 点「确认识别」失败（可能仍禁用）:', e.message.split('\n')[0]); }
        for (const w of [5000, 8000, 10000]) { await sleep(w); await show(`③ 识别中/后（+${w}ms）`); }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
