/* 鸿璐（frosted-cyan）thickness 对齐凝脂后的高分辨率验证 + 颜色取样。 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:25562';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  await context.addInitScript(() => {
    localStorage.setItem('yijing.profile.v1', JSON.stringify({
      version: 3, points: 10000,
      unlocked: ['mat-frosted-cyan'],
      equipped: { materialBlack: 'frosted-cyan', materialWhite: 'solid-white' },
      settledGames: [],
    }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('[data-mode="local"]', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.click('[data-mode="local"]');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const input = document.querySelector('input[name="local-scene"][value="tea"]');
    if (input) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.click('#start-local');
  await page.waitForTimeout(8000);
  await page.mouse.click(640, 340);
  await page.waitForTimeout(900);
  await page.mouse.click(607, 340);
  await page.waitForTimeout(900);
  await page.mouse.click(673, 340);
  await page.waitForTimeout(1500);
  await page.mouse.move(10, 10);
  await page.waitForTimeout(300);
  // 大一点的近景（逻辑坐标），2x 缩放后是实际像素的两倍
  await page.screenshot({
    path: 'uitest/out/cyan_verify_closeup.png',
    clip: { x: 560, y: 260, width: 220, height: 150 },
  });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
