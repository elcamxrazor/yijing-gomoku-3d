/* 凝脂材质验证：装备半透明白子 + 开启手数编号，落子后近景看编号与圆点。 */
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:25562';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    localStorage.setItem('yijing.profile.v1', JSON.stringify({
      version: 3, points: 10000,
      unlocked: ['mat-translucent-white'],
      equipped: { materialBlack: 'solid-black', materialWhite: 'translucent-white' },
      settledGames: [],
    }));
    localStorage.setItem('yijing.settings.v1', JSON.stringify({ moveNumbers: 'off' }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.click('[data-mode="local"]');
  await page.waitForTimeout(400);
  await page.click('#start-local');
  await page.waitForTimeout(8000);
  for (const [x, y] of [[640, 340], [607, 340], [673, 340], [640, 307]]) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'uitest/out/grease_full.png' });
  await page.screenshot({ path: 'uitest/out/grease_closeup.png', clip: { x: 540, y: 240, width: 220, height: 150 } });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
