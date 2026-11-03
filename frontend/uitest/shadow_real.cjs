/* 路线一验证：真实阴影的时机（下落中 vs 落定）与形状。 */
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:25562';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (m.text().includes('TEA-LIGHTS') || m.text().includes('BOARD-PROBE')) console.log('MARKER:', m.text()); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.click('[data-mode="local"]');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const input = document.querySelector('input[name="local-scene"][value="tea"]');
    if (input) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(200);
  const checked = await page.evaluate(() => document.querySelector('input[name="local-scene"]:checked')?.value);
  console.log('selected scene:', checked);
  await page.click('#start-local');
  await page.waitForTimeout(2500);
  const activeScene = await page.evaluate(() => {
    const el = document.querySelector('[data-scene-indicator], .scene-name, #stage-scene');
    return el?.textContent ?? document.body.className;
  });
  console.log('active scene indicator:', JSON.stringify(activeScene));
  await page.waitForTimeout(6000);
  const debug = await page.evaluate(() => window.__sceneDebug ? window.__sceneDebug() : null);
  console.log('SCENE DEBUG:', JSON.stringify(debug, null, 1));
  // 抓下落动画中段（点击后 ~150ms，棋子还在空中）
  await page.mouse.click(640, 340);
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'uitest/out/sr_dropping.png' });
  await page.waitForTimeout(900);
  await page.mouse.click(607, 340);
  await page.waitForTimeout(1100);
  await page.mouse.click(673, 340);
  await page.waitForTimeout(1100);
  await page.screenshot({ path: 'uitest/out/sr_red2.png' });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
