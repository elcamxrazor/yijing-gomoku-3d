/* 鸿璐（frosted-cyan）验证：装备材质 + 落黑子 + 近景截图。 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:25562';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.click('[data-mode="local"]');
  await page.waitForTimeout(400);
  // 本地局默认「随机棋境」，不固定场景会让光照/底色每次不同，测色就会漂。
  const scene = process.env.SCENE || 'tea';
  await page.evaluate((id) => {
    const input = document.querySelector(`input[name="local-scene"][value="${id}"]`);
    if (input) {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, scene);
  await page.click('#start-local');
  await page.waitForTimeout(8000);
  // 黑-白-黑 三颗，黑子用鸿璐
  await page.mouse.click(640, 340);
  await page.waitForTimeout(900);
  await page.mouse.click(607, 340);
  await page.waitForTimeout(900);
  await page.mouse.click(673, 340);
  await page.waitForTimeout(1500);
  await page.mouse.move(10, 10);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `uitest/out/cyan_${scene}_stones.png` });
  await page.screenshot({
    path: `uitest/out/cyan_${scene}_closeup.png`,
    clip: { x: 560, y: 270, width: 180, height: 110 },
  });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
