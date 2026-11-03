/* 抛硬币动画验证：两个浏览器走完建房/加入/选择先后手，抓抛硬币空中帧。 */
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:25562';

async function makeGuest(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1200);
  return { context, page };
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const a = await makeGuest(browser);
  const b = await makeGuest(browser);
  const errors = [];
  a.page.on('pageerror', (e) => errors.push('A: ' + e.message));
  b.page.on('pageerror', (e) => errors.push('B: ' + e.message));

  // A 建房拿房号
  async function page_wait(page, ms) { await page.waitForTimeout(ms); }
  await a.page.click('[data-mode="online"]');
  await page_wait(a.page, 600);
  await a.page.click('[data-lobby-tab="room"]');
  await page_wait(a.page, 300);
  await a.page.click('#create-room');
  await page_wait(a.page, 800);
  const code = await a.page.evaluate(() => {
    const el = document.getElementById('panel-room-code');
    return el ? el.textContent.trim() : (document.querySelector('#room-info strong')?.textContent ?? '');
  });
  console.log('room code:', code);

  // B 加入
  await b.page.click('[data-mode="online"]');
  await page_wait(b.page, 600);
  await b.page.click('[data-lobby-tab="room"]');
  await page_wait(b.page, 300);
  await b.page.fill('#room-code-input', code);
  await b.page.click('#join-form button[type="submit"]');
  await page_wait(b.page, 1500);

  // 双方选择先后手（A 选自己先手，B 选对方）→ 触发硬币
  await a.page.click('#opening-self');
  await page_wait(a.page, 300);
  await b.page.click('#opening-self');
  // 硬币上抛阶段（1.05s）中段抓帧
  await page_wait(a.page, 420);
  await a.page.screenshot({ path: 'uitest/out/coin_toss.png' });
  await page_wait(a.page, 500);
  await a.page.screenshot({ path: 'uitest/out/coin_apex.png' });
  await page_wait(a.page, 1800);
  await a.page.screenshot({ path: 'uitest/out/coin_settled.png' });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
