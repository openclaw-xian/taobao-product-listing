#!/usr/bin/env node
/**
 * 点「保存草稿」并读回 —— 防丢（⚠️ 见 references/ops-notes.md 第五节：刷新会丢未保存内容）。
 *
 * ⚠️ 本技能**只禁「提交宝贝信息」**（门禁 2）；**「保存草稿」是安全的**，自动化跑完就该点一下。
 *
 * 用法：node scripts/tb_save_draft.js [--port 9120]
 * 退出码：0 = 已保存（读到「最后保存于」或成功提示）/ 1 = 失败
 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, 'pwresolver.js'));
const { guardCheck } = require(path.join(__dirname, 'guard.js'));
const PORT = String(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : (process.env.TB_PORT || '9120'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

const readState = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const t = clean(document.body.innerText);
  return {
    最后保存: (t.match(/最后保存于[^\n]{0,26}/) || [])[0] || null,
    保存提示: (t.match(/草稿保存成功|保存成功[^\n]{0,20}/) || [])[0] || null,
    标题: (() => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const i = Array.from(document.querySelectorAll('input')).filter(vis).find((x) => (x.getAttribute('placeholder') || '').includes('30个汉字'));
      return i ? i.value : null;
    })(),
    有SKU表: (() => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return Array.from(document.querySelectorAll('table')).filter(vis).length > 0;
    })(),
  };
};

(async () => {
  const { chromium } = resolvePlaywrightCore().pw;
  await guardCheck(PORT);   // ★ 开工前守卫：连不上/没登录 → 人话诊断并退出（见 scripts/guard.js）
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => /publish\.htm/.test(p.url()) && !/fromAIImage=true/.test(p.url()));
    if (!page) { say('★ 找不到发布页'); process.exitCode = 1; return; }
    say('保存前:', await page.evaluate(readState));

    // ⓪ 先关掉残留的弹窗（实measure：「草稿箱最大保存 10 条草稿…」会叠好几个，挡住保存按钮）
    let closed = 0;
    for (let i = 0; i < 6; i++) {
      const c = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const dlgs = Array.from(document.querySelectorAll('.next-dialog,.next-overlay-inner,[class*=dialog],[class*=Dialog]')).filter(vis);
        for (const d of dlgs) {
          const b = Array.from(d.querySelectorAll('button')).filter(vis).find((x) => /^(确定|知道了|关闭|好的)/.test(clean(x.innerText)));
          if (b) {
            const r = b.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 按钮: clean(b.innerText), 弹窗: clean(d.innerText).slice(0, 44) };
          }
        }
        return null;
      });
      if (!c) break;
      await page.mouse.move(c.x, c.y);
      await sleep(200);
      await page.mouse.click(c.x, c.y);
      closed++;
      say('   关掉弹窗:', c.按钮, '|', c.弹窗);
      await sleep(1500);
    }
    say('⓪ 关掉的弹窗数 =', closed);

    // ★ 点「保存草稿」：**坐标会因页面懒加载回流而过期**（实测整链里点空过一次 —— 同一个坐标
    //   我手动再点却成功了），所以不能"取一次坐标点一次就算完"。
    //   改成：重取坐标 → 点 → **轮询等「最后保存于…」出现** → 没等到就换元素点击再试，最多 4 轮。
    const findSaveBtn = () => page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /保存草稿/.test(clean(x.innerText)));
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文本: clean(b.innerText), disabled: !!b.disabled };
    });
    const readSaved = () => page.evaluate(() => {
      const t = (document.body.innerText || '').replace(/\s+/g, ' ');
      return (t.match(/最后保存于[^\n]{0,20}/) || [])[0] || null;
    });
    let clicked = { ok: false };
    for (let k = 0; k < 4; k++) {
      const b = await findSaveBtn();
      if (!b) break;
      if (b.disabled) { say('   保存按钮是灰的（页面还在校验）→ 等 3s 重试'); await sleep(3000); continue; }
      await page.mouse.move(b.x, b.y);
      await sleep(300);
      await page.mouse.click(b.x, b.y);
      clicked = { ok: true, 文本: b.文本, x: b.x, y: b.y };
      say(`点「保存草稿」(${k + 1}/4) @ ${b.x},${b.y}`);
      let got = null;
      for (let w = 0; w < 8 && !got; w++) { await sleep(1500); got = await readSaved(); }
      if (got) { say('   已存:', got); break; }
      say('   没等到「最后保存于…」→ 换元素点击再试');
      await page.evaluate(() => {
        const b2 = Array.from(document.querySelectorAll('button')).find((x) => /保存草稿/.test(x.innerText || ''));
        if (b2) b2.click();
      }).catch(() => {});
      await sleep(3000);
      if (await readSaved()) break;
    }
    // 点击后立刻抓**提示/toast/报错**（保存被校验拦住时会在这里露出来）
    await sleep(2000);
    const toast = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const t = clean(document.body.innerText);
      const nodes = Array.from(document.querySelectorAll('.next-message,.next-toast,[class*=message],[class*=Message],[class*=toast]')).map((e) => clean(e.innerText)).filter(Boolean).slice(0, 6);
      return {
        提示节点: nodes,
        出错项: (t.match(/请发布前修改以下出错项[^\n]{0,90}/) || [])[0] || null,
        错误数: (t.match(/错误\s*[（(]?\d+/) || [])[0] || null,
        页面尾部文本: t.slice(-160),
      };
    });
    say('点击后提示:', toast);
    await page.screenshot({ path: path.join(__dirname, '..', 'output', 'recon_save.png') }).catch(() => {});
    say('点「保存草稿」:', clicked);
    await sleep(8000);
    const after = await page.evaluate(readState);
    say('保存后:', after);
    const ok = !!(after.最后保存 || after.保存提示);
    // 二次确认：再点一次（草稿保存按钮有时第一次只触发校验）
    if (!ok) {
      const again = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /保存草稿/.test(clean(x.innerText)));
        if (!b) return { ok: false };
        for (const ev of ['mousedown', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
        return { ok: true };
      });
      say('再点一次:', again);
      await sleep(8000);
      say('再确认:', await page.evaluate(readState));
    }
    console.log('\n' + JSON.stringify({ ok, 状态: await page.evaluate(readState) }, null, 1));
    process.exitCode = ok ? 0 : 1;
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
