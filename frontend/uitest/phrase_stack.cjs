/* 验证快捷短语气泡：连续发两条时，两条同时可见且纵向不重叠。 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:25562';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('[data-mode="local"]', { timeout: 30000 });
  await page.click('[data-mode="local"]');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const input = document.querySelector('input[name="local-scene"][value="tea"]');
    if (input) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.click('#start-local');
  await page.waitForTimeout(3200);

  // 发送两条不同的短语（面板每次发送后收起，需要重新打开）。
  for (const index of [0, 1]) {
    await page.evaluate(() => document.getElementById('phrase-toggle').click());
    await page.waitForTimeout(150);
    await page.evaluate((i) => {
      const chips = document.querySelectorAll('#phrase-panel .phrase-chip');
      if (chips[i]) chips[i].click();
    }, index);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(400);

  const bubbles = await page.evaluate(() => [...document.querySelectorAll('#phrase-layer .phrase-bubble')].map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      text: (el.textContent || '').trim(),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      opacity: getComputedStyle(el).opacity,
    };
  }));

  let overlapping = false;
  for (let i = 1; i < bubbles.length; i += 1) {
    if (bubbles[i].top < bubbles[i - 1].bottom - 2) overlapping = true;
  }

  console.log('bubbles:', JSON.stringify(bubbles, null, 2));
  console.log('count:', bubbles.length, '| overlapping:', overlapping);
  await page.screenshot({ path: 'uitest/out/phrase_stack.png' });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
