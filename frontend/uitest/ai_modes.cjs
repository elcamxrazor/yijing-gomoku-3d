/* 批次十验证：执子权勾选框 + 观赏模式 AI 自弈 + 编辑模式自由落子。 */
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

  // 开 AI 局（人执黑）
  await page.click('[data-mode="ai"]');
  await page.waitForTimeout(400);
  await page.click('#start-ai');
  await page.waitForTimeout(4000);

  // 勾选框应可见，且「计算机执白」已勾（AI 执白）
  const pickerVisible = await page.evaluate(() => !document.getElementById('ai-side-picker')?.hidden);
  const initial = await page.evaluate(() => ({
    black: document.getElementById('ai-side-black')?.checked,
    white: document.getElementById('ai-side-white')?.checked,
  }));
  console.log('picker visible:', pickerVisible, 'initial:', JSON.stringify(initial));

  // 切观赏模式：勾上「计算机执黑」→ AI 应开始自己下
  await page.click('#ai-side-black');
  await page.waitForTimeout(6000);
  let state1 = await page.evaluate(() => document.getElementById('move-count')?.textContent ?? '');
  console.log('spectator moveCount label:', JSON.stringify(state1));
  await page.waitForTimeout(8000);
  let state2 = await page.evaluate(() => ({
    moves: document.getElementById('move-count')?.textContent,
    thinking: document.getElementById('game-state-badge')?.textContent,
  }));
  console.log('spectator after 14s:', JSON.stringify(state2));
  await page.screenshot({ path: 'uitest/out/b10_spectator.png' });

  // 切编辑模式：两个都取消 → AI 停，玩家可自由落子
  await page.evaluate(() => {
    const b = document.getElementById('ai-side-black');
    const w = document.getElementById('ai-side-white');
    b.checked = false; w.checked = false;
    b.dispatchEvent(new Event('change')); w.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(2000);
  const editState = await page.evaluate(() => ({
    thinking: document.getElementById('game-state-badge')?.textContent,
  }));
  console.log('edit mode badge:', JSON.stringify(editState));
  // 编辑模式落一手（当前轮次方）
  await page.mouse.click(640, 340);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'uitest/out/b10_edit.png' });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
