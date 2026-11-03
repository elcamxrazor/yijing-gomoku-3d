/* 实测：设置弹窗里「对方棋子皮肤」「棋盘坐标」分段控件点击后高亮与持久化是否生效。 */
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:25562';

const readState = () => ({
  opponent: [...document.querySelectorAll('#opponent-skin-options button')].map((b) => ({
    val: b.getAttribute('data-opponent-skin'),
    active: b.classList.contains('active'),
    aria: b.getAttribute('aria-checked'),
  })),
  coords: [...document.querySelectorAll('#board-coords-options button')].map((b) => ({
    val: b.getAttribute('data-board-coords'),
    active: b.classList.contains('active'),
    aria: b.getAttribute('aria-checked'),
  })),
  stored: localStorage.getItem('yijing.settings.v1'),
  dialogOpen: document.getElementById('settings-dialog')?.open ?? null,
});

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1800);

  // 关掉可能挡住点击的欢迎遮罩（只影响测试可见性，不改产品逻辑）
  await page.evaluate(() => {
    document.querySelectorAll('.welcome, .opening-overlay').forEach((el) => { el.hidden = true; });
  });

  const btn = await page.evaluate(() => {
    const el = document.getElementById('settings-button');
    if (!el) return 'MISSING';
    const r = el.getBoundingClientRect();
    return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, display: getComputedStyle(el).display };
  });
  console.log('settings-button:', JSON.stringify(btn));

  try {
    await page.click('#settings-button', { timeout: 5000 });
  } catch (e) {
    console.log('click settings-button failed:', e.message.split('\n')[0]);
    await page.evaluate(() => document.getElementById('settings-dialog')?.showModal());
  }
  await page.waitForTimeout(300);

  const before = await page.evaluate(readState);
  console.log('BEFORE:', JSON.stringify(before));

  // 真实点击：「对方皮肤」切到隐藏，「棋盘坐标」切到显示
  await page.click('#opponent-skin-options button[data-opponent-skin="off"]', { force: true });
  await page.waitForTimeout(150);
  await page.click('#board-coords-options button[data-board-coords="on"]', { force: true });
  await page.waitForTimeout(250);

  const after = await page.evaluate(readState);
  console.log('AFTER :', JSON.stringify(after));

  // 再点回去，确认双向切换
  await page.click('#opponent-skin-options button[data-opponent-skin="on"]', { force: true });
  await page.click('#board-coords-options button[data-board-coords="off"]', { force: true });
  await page.waitForTimeout(250);
  const back = await page.evaluate(readState);
  console.log('BACK  :', JSON.stringify(back));

  const verdict = {
    initialOk: before.opponent.length === 2 && before.coords.length === 2,
    oppChanged: before.opponent.find(b => b.val === 'off')?.active !== after.opponent.find(b => b.val === 'off')?.active,
    coordsChanged: before.coords.find(b => b.val === 'on')?.active !== after.coords.find(b => b.val === 'on')?.active,
    oppBack: back.opponent.find(b => b.val === 'on')?.active === true,
    coordsBack: back.coords.find(b => b.val === 'off')?.active === true,
    persisted: after.stored !== before.stored,
  };
  console.log('VERDICT:', JSON.stringify(verdict));
  console.log('ERRORS:', JSON.stringify(errors.slice(0, 8)));

  await browser.close();
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
