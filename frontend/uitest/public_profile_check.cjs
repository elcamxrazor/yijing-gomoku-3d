/* 大厅互看名片：两个游客进大厅，A 点 B 的昵称 → 应弹出 B 的名片，
 * 且布局与看自己完全一致（六格网格：总场次/胜率/积分/胜/负/和棋），并显示积分。 */
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
  await a.waitForTimeout(1500);

  const card = await a.evaluate(() => {
    const body = document.querySelector('#profile-card-body');
    const cells = [...document.querySelectorAll('#profile-card-body .profile-stat')];
    const pointsCell = document.querySelector('#profile-card-body .profile-stat.points');
    return {
      open: document.querySelector('#profile-card')?.open ?? false,
      name: document.querySelector('#profile-card-name')?.textContent ?? '',
      bodyText: body?.innerText ?? '',
      cellCount: cells.length,
      hasPointsCell: !!pointsCell,
      pointsValue: pointsCell?.querySelector('strong')?.textContent ?? null,
      pointsLabel: pointsCell?.querySelector('span')?.textContent ?? null,
    };
  });
  console.log('CLICKED:', clicked, 'CARD:', JSON.stringify(card));
  await a.screenshot({ path: 'uitest/out/profile_other.png' });

  const openOk = card.open === true;
  const hasPoints = card.hasPointsCell === true && card.pointsLabel === '积分' && card.pointsValue !== null && card.pointsValue !== '';
  const cellOk = card.cellCount === 6; // 与自己名片一致：总场次/胜率/积分/胜/负/和棋
  console.log('open:', openOk, '| hasPoints:', hasPoints, '(', card.pointsValue, ') | cellCount==6:', cellOk);
  console.log('VERDICT:', openOk && hasPoints && cellOk ? 'PASS' : 'FAIL');
  await browser.close();
  process.exit(openOk && hasPoints && cellOk ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e && e.message ? e.message : e); process.exit(2); });
