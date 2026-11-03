/* 推荐点收缩验证：AI 局中推荐环在落子瞬间抽缩。抓落子后 120ms 与 600ms 两帧。 */
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://127.0.0.1:25562';
const setup = JSON.parse(fs.readFileSync('uitest/out/rapfi_setup.json', 'utf8'));
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{
    name: 'zen_session', value: setup.cookie.startsWith('zen_session=') ? setup.cookie.slice(12) : setup.cookie,
    domain: '127.0.0.1', path: '/', httpOnly: false, secure: false,
  }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.click('[data-mode="ai"]');
  await page.waitForTimeout(400);
  await page.click('#start-ai');
  await page.waitForTimeout(4000);
  await page.mouse.click(640, 340);
  // 等 AI 落子（首局含引擎加载，放宽）；轮询 moveCount 变 2 就立刻抓帧
  await page.waitForTimeout(45000);
  await page.screenshot({ path: 'uitest/out/hint_after_120ms.png' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'uitest/out/hint_after_700ms.png' });
  // 第二回合：AI 思考时会产生新推荐环，AI 落子瞬间再收缩——抓中间帧
  await page.mouse.click(560, 340);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: 'uitest/out/hint_round2.png' });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
