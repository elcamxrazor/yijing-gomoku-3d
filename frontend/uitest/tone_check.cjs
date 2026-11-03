/* 棋盘调色验证：本地开局后近景截图，看板面色调。 */
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:25562';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{
    name: 'zen_session', value: 'unused',
    domain: '127.0.0.1', path: '/', httpOnly: false, secure: false,
  }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.click('[data-mode="local"]');
  await page.waitForTimeout(400);
  await page.click('#start-local');
  await page.waitForTimeout(9000); // 等贴图异步接上
  await page.screenshot({ path: 'uitest/out/tone_board.png' });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
