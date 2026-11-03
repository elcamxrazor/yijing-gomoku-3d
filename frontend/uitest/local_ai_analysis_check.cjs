/* 实测：本地对弈模式出现「AI分析」按钮，点击后本地引擎给出建议与实时思考面板。 */
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:25562';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1800);

  // 开本地对弈
  await page.click('[data-mode="local"]', { timeout: 8000 });
  await page.waitForTimeout(400);
  await page.click('#start-local', { timeout: 8000 });
  await page.waitForTimeout(3500); // 等推镜与首帧

  const btnState = await page.evaluate(() => {
    const b = document.getElementById('ai-evaluate-button');
    return b ? { hidden: b.hidden, disabled: b.disabled, label: b.textContent?.trim() } : 'MISSING';
  });
  console.log('BUTTON:', JSON.stringify(btnState));

  if (typeof btnState === 'string') { console.log('FAIL: button missing'); await browser.close(); process.exit(1); }

  // 先落两子（盲点棋盘中部交叉点，与 rapfi_e2e 同款），再触发 AI 分析
  await page.mouse.click(640, 340);
  await page.waitForTimeout(1200);
  await page.mouse.click(600, 340);
  await page.waitForTimeout(1200);
  const movesInfo = await page.evaluate(() => ({
    moveCount: document.getElementById('move-count')?.textContent ?? '',
  }));
  console.log('MOVES:', JSON.stringify(movesInfo));

  // 点「AI分析」后立即查 disabled（进入函数会立刻置 true；仍 false = 早期 return）
  await page.click('#ai-evaluate-button', { timeout: 5000 });
  await page.waitForTimeout(250);
  const earlyState = await page.evaluate(() => ({
    btnDisabledImmediately: document.getElementById('ai-evaluate-button')?.disabled ?? null,
    toastsNow: [...document.querySelectorAll('#toast-region .toast')].map((t) => t.textContent?.trim()),
  }));
  console.log('EARLY:', JSON.stringify(earlyState));

  // 轮询等结果（最多 150 秒）：面板出内容 或 出现「AI 分析 · 建议」toast 都算成功
  let result = null;
  let suggestionSeen = false;
  for (let i = 0; i < 75; i++) {
    await page.waitForTimeout(2000);
    result = await page.evaluate(() => ({
      panel: document.getElementById('engine-panel')?.textContent ?? '',
      panelHidden: document.getElementById('engine-panel')?.hidden ?? null,
      toasts: [...document.querySelectorAll('#toast-region .toast')].map((t) => t.textContent?.trim()),
      btnDisabled: document.getElementById('ai-evaluate-button')?.disabled ?? null,
    }));
    if ((result.toasts ?? []).some((t) => t?.includes('AI 分析'))) suggestionSeen = true;
    if ((!result.panelHidden && result.panel.length > 0) || suggestionSeen) break;
  }
  console.log('RESULT:', JSON.stringify(result));
  console.log('SUGGESTION_TOAST_SEEN:', suggestionSeen);
  console.log('PAGE_ERRORS:', JSON.stringify(errors.slice(0, 5)));

  const ok = result && ((!result.panelHidden && result.panel.length > 0) || suggestionSeen) && errors.length === 0;
  console.log('VERDICT:', ok ? 'PASS' : 'CHECK_MANUALLY');
  await browser.close();
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
