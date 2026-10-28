#!/usr/bin/env node
/**
 * playwright-core 的唯一解析入口（淘宝技能）。
 *
 * 为什么要有它：**换机器能不能跑，取决于这一处**。
 * 只写 `require('playwright-core')` 的话，靠 Node 从 cwd 往上找 —— 换机器 / 换工作目录就 MODULE_NOT_FOUND，
 * 而技能本身自带了一份（`tools/npm/node_modules/playwright-core`，约 13MB）。
 *
 * 解析优先级：
 *   1) `TB_PLAYWRIGHT`（由 config.json 的 `playwright_core` 或环境变量设进来）
 *   2) **技能自带** `tools/npm/node_modules/playwright-core`
 *   3) 裸模块名 `playwright-core`（机器级 / NODE_PATH）
 */
const fs = require('fs');
const path = require('path');

const LOCAL_DIR = path.join(__dirname, '..', 'tools', 'npm', 'node_modules', 'playwright-core');

function candidates() {
  const out = [];
  const env = process.env.TB_PLAYWRIGHT || process.env.PW_CORE;
  if (env && env !== 'playwright-core') out.push({ how: 'TB_PLAYWRIGHT', spec: env });
  out.push({ how: '技能自带 tools/npm', spec: LOCAL_DIR });
  out.push({ how: '机器级（Node 常规解析）', spec: 'playwright-core' });
  return out;
}

function resolvePlaywrightCore() {
  const errs = [];
  for (const c of candidates()) {
    try {
      if (c.spec !== 'playwright-core' && !fs.existsSync(c.spec)) { errs.push(`${c.how}: 路径不存在 ${c.spec}`); continue; }
      return { pw: require(c.spec), how: c.how, spec: c.spec };
    } catch (e) {
      errs.push(`${c.how}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error(
    'playwright-core 找不到。已试：\n  - ' + errs.join('\n  - ') +
    '\n修法：① 确认技能目录下有 tools/npm/node_modules/playwright-core（自带那份）；' +
    '或 ② 在 config.json 里把 "playwright_core" 指向它；或 ③ 设环境变量 TB_PLAYWRIGHT。详见 HANDOVER.md'
  );
}

function playwright() {
  return resolvePlaywrightCore().pw;
}

module.exports = { resolvePlaywrightCore, playwright, LOCAL_DIR };
