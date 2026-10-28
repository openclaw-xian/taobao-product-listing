#!/usr/bin/env node
/**
 * 侦察（阶段 5）：**真正把「下载模版」拿下来** + 报告文件路径。
 *
 * 上次失败的原因：**没给浏览器指定下载目录** —— Chrome 若配成「询问保存位置」，
 * 自动化点击会弹一个没人点的对话框，文件等于没下。
 * 修法：连上 CDP 后先发 `Browser.setDownloadBehavior`（allow + 明确 downloadPath），再真实点击。
 *
 * 用法：node tests/recon_download.js [--port 9120] [--dir <下载目录>] [--url-re <页面正则>]
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
const DIR = String(arg('dir', path.join(process.env.USERPROFILE || 'C:\\Users\\<你>', 'Downloads')));
const URL_RE = String(arg('url-re', 'publish\\.htm|category\\.htm'));
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
const snap = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []);

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const before = new Set(snap(DIR));
  const { chromium } = resolvePlaywrightCore().pw;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  let cdp = null;
  try {
    // ★ 关键：先明确下载行为（否则「询问位置」的 Chrome 会把下载卡住）
    cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DIR });
    console.log('已设置下载目录:', DIR);
  } catch (e) {
    console.log('newBrowserCDPSession 失败（改用 page 级）:', e.message.split('\n')[0]);
  }

  try {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (!new RegExp(URL_RE).test(page.url())) continue;
        console.log('页面:', page.url().slice(0, 100));

        // 若弹窗没开，先想办法打开（点「批量导入」等入口）
        const opened = await page.evaluate(() => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          if (Array.from(document.querySelectorAll('.next-dialog')).filter(vis).length) return '已开着';
          for (const label of ['批量导入', '批量填写', '以图发品', '开启']) {
            const all = Array.from(document.querySelectorAll('button,a,span,div')).filter((e) => vis(e) && clean(e.innerText) === label);
            if (all.length) {
              const inner = all.filter((e) => !all.some((o) => o !== e && e.contains(o)))[0];
              for (const ev of ['mousedown', 'mouseup', 'click']) inner.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
              return '点了「' + label + '」';
            }
          }
          return '没找到入口';
        });
        console.log('弹窗入口:', opened);
        await sleep(3500);

        // 真实点击「下载模版」（文本是 模版 不是 模板；类名 download-template-btn）
        try {
          await page.click('button.download-template-btn', { timeout: 12000 });
          console.log('已真实点击 button.download-template-btn');
        } catch (e) {
          console.log('点下载按钮失败:', e.message.split('\n')[0]);
        }
        for (const w of [4000, 6000, 8000]) {
          await sleep(w);
          const added = snap(DIR).filter((f) => !before.has(f));
          console.log(`  +${w}ms 新增: ${JSON.stringify(added)}`);
          if (added.length) break;
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
