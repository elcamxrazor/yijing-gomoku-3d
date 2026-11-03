/* 磨砂墨玉验证：装备材质 + 落黑子 + 近景截图，与默认黑子对比。 */
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:25562';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    localStorage.setItem('yijing.profile.v1', JSON.stringify({
      version: 3, points: 10000,
      unlocked: ['mat-frosted-black'],
      equipped: { materialBlack: 'frosted-black', materialWhite: 'solid-white' },
      settledGames: [],
    }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.click('[data-mode="local"]');
  await page.waitForTimeout(400);
  await page.click('#start-local');
  await page.waitForTimeout(8000);
  // 落两颗黑子（本地同屏轮流，黑-白-黑）
  await page.mouse.click(640, 340);
  await page.waitForTimeout(900);
  await page.mouse.click(607, 340);
  await page.waitForTimeout(900);
  await page.mouse.click(673, 340);
  await page.waitForTimeout(1500);
    await page.screenshot({ path: 'uitest/out/jade_stones.png' });
  await page.screenshot({
    path: 'uitest/out/jade_closeup.png',
    clip: { x: 560, y: 270, width: 180, height: 110 },
  });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
