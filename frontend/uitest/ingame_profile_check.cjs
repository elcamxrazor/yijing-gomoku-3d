/* 对局中看名片：A 约战 B → 开局 → 点对手名字应弹出其名片。 */
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
    await page.waitForTimeout(1400);
    await page.click('[data-mode="online"]');
    await page.waitForTimeout(400);
    const enter = await page.$('#lobby-enter');
    if (enter && (await enter.isVisible())) await enter.click();
    await page.waitForTimeout(600);
  }
  await a.waitForTimeout(2000);

  // A 约战大厅里唯一的对手
  await a.evaluate(() => {
    const row = [...document.querySelectorAll('.lobby-row')].find((item) => !item.classList.contains('self'));
    row?.querySelector('.lobby-invite')?.click();
  });
  await b.waitForSelector('#challenge-accept', { state: 'attached', timeout: 12000 });
  await b.evaluate(() => document.querySelector('#challenge-accept')?.click());

  // 双方决定先后手：A 选自己先手，B 选对方先手 → 一致
  await a.waitForSelector('#opening-self', { state: 'attached', timeout: 12000 });
  await a.evaluate(() => document.querySelector('#opening-self')?.click());
  await b.waitForSelector('#opening-opponent', { state: 'attached', timeout: 12000 });
  await b.evaluate(() => document.querySelector('#opening-opponent')?.click());
  await a.waitForTimeout(7000);

  const names = await a.evaluate(() => ({
    black: document.querySelector('#black-player-name')?.textContent ?? '',
    white: document.querySelector('#white-player-name')?.textContent ?? '',
    blackClickable: document.querySelector('#black-player-name')?.classList.contains('clickable') ?? false,
    whiteClickable: document.querySelector('#white-player-name')?.classList.contains('clickable') ?? false,
  }));
  console.log('NAMES:', JSON.stringify(names));

  // A 执黑先手 → 点白方（对手）名字
  await a.evaluate(() => document.querySelector('#white-player-name')?.click());
  await a.waitForTimeout(1400);
  const card = await a.evaluate(() => ({
    open: document.querySelector('#profile-card')?.open ?? false,
    name: document.querySelector('#profile-card-name')?.textContent ?? '',
    body: document.querySelector('#profile-card-body')?.innerText ?? '',
  }));
  console.log('CARD:', JSON.stringify(card));
  await a.screenshot({ path: 'uitest/out/ingame_profile.png' });
  await browser.close();
})();
