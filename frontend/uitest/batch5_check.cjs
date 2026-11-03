/* 批次六验证：个人名片 + 场景免解锁。 */
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://127.0.0.1:25562';
const setup = JSON.parse(fs.readFileSync('uitest/out/rapfi_setup.json', 'utf8'));
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{
    name: 'zen_session', value: setup.cookie.startsWith('zen_session=') ? setup.cookie.slice(12) : setup.cookie,
    domain: '127.0.0.1', path: '/', httpOnly: false, secure: false,
  }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);

  // 1) 对局中（HUD）打开名片
  await page.click('#profile-button');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'uitest/out/b5_profile_card.png' });
  const cardText = await page.evaluate(() => document.getElementById('profile-card-body')?.innerText ?? '');
  console.log('card:', JSON.stringify(cardText));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 2) 本地开局面板：所有场景卡应无「未解锁」标记
  await page.click('[data-mode="local"]');
  await page.waitForTimeout(500);
  const lockedTags = await page.evaluate(() => document.querySelectorAll('.scene-locked-tag').length);
  const disabledInputs = await page.evaluate(() =>
    [...document.querySelectorAll('input[name="local-scene"]')].filter((i) => i.disabled).length,
  );
  console.log('locked tags:', lockedTags, 'disabled scene inputs:', disabledInputs);
  await page.screenshot({ path: 'uitest/out/b5_scene_picker.png' });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
