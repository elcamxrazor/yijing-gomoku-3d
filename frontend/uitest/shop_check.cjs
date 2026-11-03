/* 校验商城色块：读取每个商品的 .shop-swatch 计算样式。 */
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:25562';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    localStorage.setItem('yijing.profile.v1', JSON.stringify({
      version: 3, points: 10000,
      unlocked: ['mat-frosted-black', 'mat-frosted-cyan', 'mat-translucent-white'],
      equipped: { materialBlack: 'solid-black', materialWhite: 'solid-white' },
      settledGames: [],
    }));
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.click('#shop-button');
  await page.waitForTimeout(800);
  const info = await page.evaluate(() => {
    return [...document.querySelectorAll('.shop-item')].map((item) => ({
      name: item.querySelector('.shop-name')?.textContent?.replace('已装备', '').trim(),
      swatch: item.querySelector('.shop-swatch')
        ? getComputedStyle(item.querySelector('.shop-swatch')).backgroundColor
        : null,
    }));
  });
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: 'uitest/out/shop_swatch.png' });
  await browser.close();
})();
