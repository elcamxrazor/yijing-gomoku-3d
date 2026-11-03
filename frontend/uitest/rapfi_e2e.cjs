/* Rapfi 前端引擎端到端验证：真实浏览器里下一手棋，AI 由前端 WASM 引擎应手。 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'http://127.0.0.1:25562';
const setup = JSON.parse(fs.readFileSync('uitest/out/rapfi_setup.json', 'utf8'));

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{
    name: 'zen_session', value: setup.cookie,
    domain: '127.0.0.1', path: '/', httpOnly: false, secure: false,
  }]);
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);

  // 人机对弈 → 执黑 → 开始
  await page.click('[data-mode="ai"]');
  await page.waitForTimeout(400);
  await page.click('#start-ai');
  await page.waitForTimeout(4000); // 等推镜与首帧

  // 落一手（天元附近）
  await page.mouse.click(640, 340);
  // 等本地引擎：首次需下载 ~10MB 权重 + 编译 + 思考，给足时间
  await page.waitForTimeout(60000);
  await page.screenshot({ path: 'uitest/out/rf1_first_exchange.png' });

  const state1 = await page.evaluate(() => ({
    panel: document.getElementById('engine-panel')?.textContent ?? '',
    panelHidden: document.getElementById('engine-panel')?.hidden ?? null,
    moveCount: document.getElementById('move-count')?.textContent ?? '',
    turn: document.getElementById('current-color')?.textContent ?? '',
  }));
  console.log('after first exchange:', JSON.stringify(state1));

  // 再来一个回合确认交替
  await page.mouse.click(560, 340);
  await page.waitForTimeout(8000);
  await page.screenshot({ path: 'uitest/out/rf2_second_exchange.png' });
  const state2 = await page.evaluate(() => ({
    moveCount: document.getElementById('move-count')?.textContent ?? '',
    panel: document.getElementById('engine-panel')?.textContent ?? '',
  }));
  console.log('after second exchange:', JSON.stringify(state2));
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
