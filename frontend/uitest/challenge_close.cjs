/* 复现：大厅约战 → 对方接受 → 对局页上应邀弹窗是否关闭。 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:25562';

async function openLobby(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-mode="online"]', { timeout: 30000 });

  // 先建立游客会话。
  const needGuest = await page.evaluate(() => {
    const el = document.getElementById('account-name');
    return !el || (el.textContent ?? '').includes('登录');
  });
  if (needGuest) {
    await page.click('#account-button');
    await page.waitForSelector('#auth-dialog[open]', { timeout: 10000 });
    await page.click('#guest-button');
    await page.waitForFunction(() => {
      const el = document.getElementById('account-name');
      return !!el && !(el.textContent ?? '').includes('登录');
    }, { timeout: 20000 });
  }
  await page.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  });

  await page.click('[data-mode="online"]');
  await page.waitForSelector('#game-dialog[open]', { timeout: 10000 });
  await page.waitForTimeout(800);
  return (await page.textContent('#account-name'))?.trim() ?? '';
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctxA = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const ctxB = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const errors = [];
  for (const p of [A, B]) p.on('pageerror', (e) => errors.push(e.message));

  const nameA = await openLobby(A);
  const nameB = await openLobby(B);
  console.log('A =', nameA, '| B =', nameB);

  await A.waitForFunction((n) => [...document.querySelectorAll('#lobby-list .lobby-row')]
    .some((r) => r.textContent?.includes(n)), nameB, { timeout: 20000 });

  await A.evaluate((n) => {
    const row = [...document.querySelectorAll('#lobby-list .lobby-row')]
      .find((r) => r.textContent?.includes(n));
    const btn = row?.querySelector('.lobby-invite');
    if (btn) btn.click();
  }, nameB);

  await B.waitForSelector('#challenge-dialog[open]', { timeout: 20000 });
  console.log('B 收到约战弹窗，点击接受');
  await B.click('#challenge-accept');

  await B.waitForFunction(() => document.getElementById('app')?.classList.contains('is-playing'), { timeout: 20000 });
  await B.waitForTimeout(700);

  const state = await B.evaluate(() => {
    const d = document.getElementById('challenge-dialog');
    const g = document.getElementById('game-dialog');
    const dc = getComputedStyle(d);
    const gc = getComputedStyle(g);
    return {
      challenge: { open: d.open, display: dc.display, opacity: dc.opacity },
      lobby: { open: g.open, display: gc.display, opacity: gc.opacity },
    };
  });
  console.log('B 对局页上的窗口状态:', JSON.stringify(state));
  await B.screenshot({ path: 'uitest/out/challenge_after_accept.png' });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
