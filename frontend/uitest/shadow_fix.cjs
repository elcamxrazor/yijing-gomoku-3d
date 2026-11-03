/* 验证：1) 落子有斜影 2) 重开后阴影消失 3) 无焦散亮环。 */
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:25562';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.click('[data-mode="local"]');
  await page.waitForTimeout(400);
  await page.click('#start-local');
  await page.waitForTimeout(6000);
  // 落三手
  for (const [x, y] of [[640, 340], [607, 340], [673, 340]]) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(800);
  }
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'uitest/out/sd_before.png' });
  // 重开（再来一局沿用棋境）
  await page.click('#restart-button');
  await page.waitForTimeout(600);
  await page.click('#confirm-accept');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'uitest/out/sd_after_restart.png' });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
