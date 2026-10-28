#!/usr/bin/env node
/**
 * 开工前**守卫**：连浏览器之前先探一眼环境，不通就给人话诊断并退出。
 *
 * 为什么要有它：原来只有 `preflight.ps1` 会做这套判断，而 **`preflight` 只在"你记得先跑它"时才有用**。
 * 实测踩到：调试口的 Chrome 没开，直接跑 `run_listing.ps1` → 16 个步骤逐个抛
 * `connect ECONNREFUSED 127.0.0.1:9120`，看起来像技能坏了，其实只是浏览器没起；
 * 而单跑某个脚本时更是连那点检查都没有。
 * → 把判断做成**每个脚本连接前的必经一步**，不靠"记得先跑 preflight"。
 *
 * 判据（与 `preflight.ps1` 第 4 节保持一致，那份仍是权威实现）：
 *   ① 端口通不通（不通 = Chrome 没开 / 没带 --remote-debugging-port）
 *   ② 有没有淘宝/天猫卖家域页面（没有 = 那个 Chrome 没打开千牛）
 *   ③ 卖家页是不是**全都在登录页**（是 = 登录态过期，需要用户自己登，本技能不代登录）
 *
 * 用法：`const { guardCheck } = require(path.join(__dirname, 'guard.js')); await guardCheck(PORT);`
 * 退出码：2 = 环境阻断（诊断已打印）；0 = 正常（调用方继续）
 * 逃生阀：`TB_SKIP_GUARD=1`（只给 tests/ 下的探针用）
 */
const TIMEOUT_MS = 5000;

// ⚠️ 判据必须与 `preflight.ps1` 第 4 节**逐字一致**（那份是权威实现），否则两边会给出互相矛盾的结论。
//   踩过的两个坑（preflight.ps1 里也记着）：① 登录页 URL 的 redirect_url 参数里带着
//   `item.upload.taobao.com`；② `loginmyseller.taobao.com` 含 `myseller` 子串会被卖家域命中。
//   → **只匹配 host**，且 host 含 `login` 的一律不算卖家域。
//   另外：**不能**用「任何 *.taobao.com / *.tmall.com」当卖家域 —— 实测 `main.m.tmall.com`
//   （第三方 cookie 弹窗页）会被误判成"已登录"。
const SELLER_RE = /qn\.taobao\.com|item\.upload\.taobao\.com|myseller\.taobao\.com|sell\.taobao\.com|sycm\.taobao\.com|i\.taobao\.com/;
const LOGIN_RE = /loginmyseller\.taobao\.com|login\.taobao\.com|login\.m\.taobao\.com/;

const hostOf = (u) => {
  try { return new URL(u).host; } catch (e) { return ''; }
};

async function httpJson(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function diagnose(port) {
  // ① 端口可达？
  let ver;
  try {
    ver = await httpJson(`http://127.0.0.1:${port}/json/version`);
  } catch (e) {
    return {
      阻断: true,
      原因: `端口 ${port} 不可达 —— 该店 Chrome 没开、或没带 --remote-debugging-port=${port}`,
      修法: 'powershell -File "<skillRoot>\\scripts\\open_browser.ps1"（起来后**你自己登千牛**）',
    };
  }
  // ②③ 卖家页 + 登录态
  let list = [];
  try {
    list = await httpJson(`http://127.0.0.1:${port}/json/list`);
  } catch (e) { /* 按"没有页面"处理 */ }
  const urls = (Array.isArray(list) ? list : []).map((p) => String((p && p.url) || '')).filter((u) => u.startsWith('http'));
  const hosts = urls.map(hostOf);
  const seller = hosts.filter((h) => SELLER_RE.test(h) && !/login/.test(h));
  const login = hosts.filter((h) => LOGIN_RE.test(h));
  if (seller.length) {
    return { 阻断: false, 浏览器: (ver && ver.Browser) || null, 卖家页数: seller.length };
  }
  if (login.length) {
    return {
      阻断: true,
      原因: `端口 ${port} 通了，但**停在卖家登录页** —— 登录态过期了，请在那个 Chrome 里登录千牛`,
      修法: '（本技能不代登录、不碰账号密码；登录后重跑即可）',
      登录页: login.slice(0, 2),
    };
  }
  return {
    阻断: true,
    原因: `端口 ${port} 通了（${ver && ver.Browser}），但**没有淘宝/千牛页面**`,
    修法: '在那个 Chrome 里打开 https://qn.taobao.com/home.htm/QnworkbenchHome/',
    现有页面: hosts.slice(0, 4),
  };
}

async function guardCheck(port) {
  if (process.env.TB_SKIP_GUARD === '1') return { 跳过: true };
  const d = await diagnose(String(port || process.env.TB_PORT || '9120'));
  if (d.阻断) {
    console.error('');
    console.error('★ 开不了工：' + d.原因);
    console.error('  修法：' + d.修法);
    console.error('  （这道检查是 scripts/guard.js 做的，判据与 preflight.ps1 第 4 节一致）');
    console.error('');
    process.exit(2);
  }
  return d;
}

module.exports = { guardCheck, diagnose };
