/* 复盘「收藏」端到端：收藏 → 播放条取消（需确认）→ 已收藏页签 → 列表取消（需确认）→ 全部列表。 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:25562';
const W = Number(process.env.W || 1200);
const H = Number(process.env.H || 840);

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await (await browser.newContext({
    viewport: { width: W, height: H },
    isMobile: W < 500,
    hasTouch: W < 500,
  })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-mode="ai"]', { timeout: 30000 });

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
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  }

  // 造一局棋：人机局 → 认输
  await page.click('[data-mode="ai"]');
  await page.waitForSelector('#start-ai', { timeout: 10000 });
  await page.click('#start-ai');
  await page.waitForTimeout(2200);
  await page.evaluate(() => {
    const canvas = document.querySelector('#scene-container canvas');
    const r = canvas.getBoundingClientRect();
    for (const type of ['pointerdown', 'pointerup']) {
      canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 1,
      }));
    }
  });
  await page.waitForTimeout(1400);
  await page.click('#resign-button');
  await page.waitForTimeout(400);
  if (await page.evaluate(() => !!document.querySelector('#confirm-dialog[open]'))) {
    await page.click('#confirm-accept');
  }
  await page.waitForTimeout(1400);

  // 首页 → 复盘列表
  await page.click('#brand-home');
  await page.waitForTimeout(1200);
  await page.click('#open-replays');
  await page.waitForSelector('#replay-dialog[open] .replay-row', { timeout: 15000 });
  const tabs = await page.$$eval('#replay-tabs [data-replay-tab]', (els) => els.map((e) => e.textContent.trim()));
  console.log('页签:', tabs.join(' / '));

  // 进第一局 → 收藏
  await page.click('#replay-dialog .replay-row');
  await page.waitForSelector('#replay-bar:not([hidden])', { timeout: 15000 });
  await page.waitForTimeout(600);
  console.log('收藏前:', JSON.stringify(await page.evaluate(() => {
    const b = document.getElementById('replay-keep');
    return { label: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') };
  })));
  await page.click('#replay-keep');
  await page.waitForTimeout(600);
  console.log('收藏后:', JSON.stringify(await page.evaluate(() => {
    const b = document.getElementById('replay-keep');
    return { label: b.textContent.trim(), pressed: b.getAttribute('aria-pressed'), on: b.classList.contains('on') };
  })));

  // 播放条再点一次 = 取消收藏：先「再想想」应保持
  await page.click('#replay-keep');
  await page.waitForSelector('#confirm-dialog[open]', { timeout: 5000 });
  await page.waitForTimeout(320);
  await page.screenshot({ path: `uitest/out/replay_unfav_confirm_${W}.png` });
  await page.click('#confirm-cancel');
  await page.waitForTimeout(600);
  console.log('播放条点「再想想」后:', JSON.stringify(await page.evaluate(() => {
    const b = document.getElementById('replay-keep');
    return { label: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') };
  })));

  // 退出复盘 → 已收藏页签
  await page.click('#replay-exit');
  await page.waitForTimeout(1000);
  await page.click('#open-replays');
  await page.waitForSelector('#replay-dialog[open]', { timeout: 10000 });
  await page.click('#replay-tabs [data-replay-tab="favorite"]');
  await page.waitForTimeout(800);
  console.log('已收藏页签:', JSON.stringify(await page.evaluate(() => ({
    rows: document.querySelectorAll('#replay-list .replay-item').length,
    starred: document.querySelectorAll('#replay-list .replay-fav.on').length,
  }))));

  // 列表星标取消收藏：确认框 → 再想想 → 仍保留
  await page.click('#replay-list .replay-fav');
  await page.waitForSelector('#confirm-dialog[open]', { timeout: 5000 });
  console.log('确认弹窗:', JSON.stringify(await page.evaluate(() => ({
    title: document.getElementById('confirm-title').textContent.trim(),
    accept: document.getElementById('confirm-accept').textContent.trim(),
  }))));
  await page.click('#confirm-cancel');
  await page.waitForTimeout(700);
  console.log('点「再想想」后:', JSON.stringify(await page.evaluate(() => ({
    rows: document.querySelectorAll('#replay-list .replay-item').length,
    starred: document.querySelectorAll('#replay-list .replay-fav.on').length,
  }))));

  // 再来一次，这回确认 → 行淡出 + 空态
  await page.click('#replay-list .replay-fav');
  await page.waitForSelector('#confirm-dialog[open]', { timeout: 5000 });
  await page.click('#confirm-accept');
  await page.waitForTimeout(900);
  console.log('取消收藏后:', JSON.stringify(await page.evaluate(() => ({
    rows: document.querySelectorAll('#replay-list .replay-item').length,
    empty: !document.getElementById('replay-empty').hidden,
    emptyText: document.getElementById('replay-empty').textContent.trim().slice(0, 20),
  }))));

  // 回到「全部」：这局仍在、星标已灭
  await page.click('#replay-tabs [data-replay-tab="all"]');
  await page.waitForTimeout(800);
  console.log('全部页签:', JSON.stringify(await page.evaluate(() => ({
    rows: document.querySelectorAll('#replay-list .replay-item').length,
    starred: document.querySelectorAll('#replay-list .replay-fav.on').length,
  }))));

  await page.screenshot({ path: `uitest/out/replay_favorite_${W}.png` });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
