/* 个人名片验证：积分格是否出现、占位文案是否已移除。 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:25562';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // 先建游客会话，cookie 会写进 context，名片接口才拿得到数据。
  await context.request.post(`${BASE}/api/auth/guest`);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1800);
  await page.click('#profile-button');
  await page.waitForTimeout(1500);
  const body = await page.evaluate(() => document.querySelector('#profile-card-body')?.innerText ?? '');
  const hasFootnote = await page.evaluate(
    () => (document.querySelector('#profile-card')?.innerText ?? '').includes('后续将支持更多战绩维度'),
  );
  console.log('BODY:', JSON.stringify(body));
  console.log('hasFootnote:', hasFootnote);
  await page.screenshot({ path: 'uitest/out/profile_card.png' });
  await browser.close();
})();
