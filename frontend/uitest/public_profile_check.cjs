/* 大厅互看名片：两个游客进大厅，A 点 B 的昵称 → 应弹出 B 的名片（无积分）。 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:25562';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctxA.request.post(`${BASE}/api/auth/guest`);
  await ctxB.request.post(`${BASE}/api/auth/guest`);

  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  for (const page of [a, b]) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(1500);
    await page.click('[data-mode="online"]');
    await page.waitForTimeout(500);
    const enter = await page.$('#lobby-enter');
    if (enter && (await enter.isVisible())) await enter.click();
    await page.waitForTimeout(800);
  }
  await a.waitForTimeout(2500);

  const rows = await a.evaluate(() =>
    [...document.querySelectorAll('.lobby-row')].map((row) => ({
      name: row.querySelector('.lobby-fullname')?.textContent ?? '',
      self: row.classList.contains('self'),
      clickable: row.querySelector('.lobby-name')?.classList.contains('clickable') ?? false,
    })),
  );
  console.log('ROWS:', JSON.stringify(rows));

  const clicked = await a.evaluate(() => {
    const row = [...document.querySelectorAll('.lobby-row')].find((item) => !item.classList.contains('self'));
    const name = row?.querySelector('.lobby-name');
    if (!name) return false;
    name.click();
    return true;
  });
  await a.waitForTimeout(1200);
  const card = await a.evaluate(() => ({
    open: document.querySelector('#profile-card')?.open ?? false,
    name: document.querySelector('#profile-card-name')?.textContent ?? '',
    body: document.querySelector('#profile-card-body')?.innerText ?? '',
  }));
  console.log('CLICKED:', clicked, 'CARD:', JSON.stringify(card));
  await a.screenshot({ path: 'uitest/out/profile_other.png' });
  await browser.close();
})();
