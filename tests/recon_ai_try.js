#!/usr/bin/env node
/**
 * 侦察（阶段 4b）：**多维度识别实验** —— 重置弹窗 → 上传指定文件 → 确认识别 → 读回结果。
 *
 * 用法：node tests/recon_ai_try.js --file "<...>.xlsx" [--port 9120] [--keep]
 *   --keep = 识别完不点「取消」（默认识别后关掉弹窗，保持页面干净）
 *
 * 为什么要单独写：AI识别导入 是**一维一维**给结果的，试不同列名/列组合时要能快速重置重来。
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
const KEEP = !!arg('keep', false);
const ACCEPT = !!arg('accept', false);
if (!FILE || !fs.existsSync(String(FILE))) { console.error('需要 --file'); process.exit(2); }
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

const DIALOG = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
  if (!dlg) return { open: false };
  return {
    open: true,
    text: clean(dlg.innerText).slice(0, 500),
    btns: Array.from(dlg.querySelectorAll('button')).filter(vis).map((e) => ({ t: clean(e.innerText).slice(0, 16), disabled: !!e.disabled })),
  };
})()`;

// 弹窗按钮用**合成事件**点：Playwright 的真实 click 在这些 next-dialog 按钮上会超时
//（可交互性检查过不去：被 overlay 拦）；合成 mousedown+mouseup+click 实测有效。
// ⚠️ 例外：**下载**类按钮必须用真实点击（合成事件不算用户手势，Chrome 会静默拦下载）。
async function clickText(page, text, how) {
  const r = await page.evaluate((t) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const all = Array.from(document.querySelectorAll('button,a,span,div')).filter((e) => vis(e) && clean(e.innerText) === t);
    if (!all.length) return { ok: false, why: 'no_match' };
    const inner = all.filter((e) => !all.some((o) => o !== e && e.contains(o)));
    const el = inner[0];
    for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
    return { ok: true, tag: el.tagName.toLowerCase() };
  }, text);
  return `${how} ${r.ok ? '✓ ' + r.tag : '✗ ' + r.why}`;
}

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (!/publish\.htm/.test(page.url())) continue;
        const state = () => page.evaluate(DIALOG);
        console.log('文件:', path.basename(String(FILE)));

        // ① 若弹窗已开（可能停在「已识别 1 个属性」那一屏），先取消重置
        let s = await state();
        if (s.open) {
          console.log('① 弹窗已开 → 先点「取消」重置:', await clickText(page, '取消', '取消'));
          await sleep(2500);
          s = await state();
          console.log('   重置后弹窗开启状态:', s.open);
        }

        // ② 开弹窗（真实点击）
        let entry = '（没找到入口）';
        for (const label of ['批量导入', '批量填写', 'SKU助手', '更多批量', '批量']) {
          const r = await clickText(page, label, label);
          if (/✓/.test(r)) { entry = r; break; }
        }
        console.log('② 打开导入入口:', entry);
        await sleep(3000);
        s = await state();
        console.log('   弹窗:', JSON.stringify(s.btns || []));

        // ③ 上传
        const inputs = await page.$$('.next-dialog input[type=file]');
        if (!inputs.length) { console.log('③ 弹窗里没有 file input → 停（可能弹窗没打开）'); continue; }
        await inputs[inputs.length - 1].setInputFiles(String(FILE));
        console.log('③ 已上传:', path.basename(String(FILE)));
        await sleep(3500);
        s = await state();
        console.log('   上传后:', JSON.stringify(s.btns || []));

        // ④ 确认识别
        console.log('④ 点「确认识别」:', await clickText(page, '确认识别', '确认识别'));
        for (const w of [6000, 8000, 10000]) {
          await sleep(w);
          s = await state();
          console.log(`\n== 识别 ${w}ms 后 ==`);
          console.log(JSON.stringify(s, null, 1));
          if (s.open && /已成功识别/.test(s.text || '')) break;   // 出结果就停
        }

        // ⑤ 接受识别结果（会往草稿写一个规格维度）或取消
        if (ACCEPT) {
          console.log('\n⑤ 点「在当前规格后添加」:', await clickText(page, '在当前规格后添加', '接受'));
          for (const w of [5000, 8000, 10000]) {
            await sleep(w);
            const s2 = await page.evaluate(() => {
              const clean = (x) => (x || '').replace(/\s+/g, ' ').trim();
              const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
              const tables = Array.from(document.querySelectorAll('table')).filter(vis).map((t) => ({
                head: Array.from(t.querySelectorAll('th')).map((th) => clean(th.innerText).slice(0, 12)).filter(Boolean).slice(0, 12),
                rows: t.querySelectorAll('tbody tr').length,
                first: t.querySelector('tbody tr') ? clean(t.querySelector('tbody tr').innerText).slice(0, 90) : null,
              }));
              const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0];
              return { dialogOpen: !!dlg, dialogText: dlg ? clean(dlg.innerText).slice(0, 260) : null, tables,
                       hit: (clean(document.body.innerText).match(/(销售规格|规格名|颜色分类|尺寸|款式)[^\n]{0,40}/g) || []).slice(0, 6) };
            });
            console.log(`\n== 接受后 ${w}ms ==\n` + JSON.stringify(s2, null, 1));
            if (s2.tables.length && s2.tables[0].rows > 0) break;
          }
        } else if (!KEEP) {
          console.log('\n⑤ 点「取消」关弹窗:', await clickText(page, '取消', '取消'));
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
