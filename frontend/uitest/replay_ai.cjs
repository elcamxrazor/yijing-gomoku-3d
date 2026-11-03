/* 复盘 AI 评估验证：结束一局（由 Python 预置脚本产出 cookie+gameId）→
   进复盘 → 点「AI评估」→ 建议环与文案出现。 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'http://127.0.0.1:25562';
const setup = JSON.parse(fs.readFileSync('uitest/out/replay_ai_setup.json', 'utf8'));

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const cookieValue = setup.cookie.startsWith('zen_session=')
    ? setup.cookie.slice('zen_session='.length)
    : setup.cookie;
  await context.addCookies([{
    name: 'zen_session', value: cookieValue,
    domain: '127.0.0.1', path: '/', httpOnly: false, secure: false,
  }]);
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);

  // 打开复盘列表 → 进入刚才那局
  await page.click('#open-replays');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'uitest/out/r1_list.png' });
  await page.click(`[data-replay-id="${setup.gameId}"]`);
  await page.waitForTimeout(3000); // 等棋境加载

  // 先拖到中盘再评估（空盘建议=天元没有展示意义）
  await page.fill('#replay-slider', '2');
  await page.dispatchEvent('#replay-slider', 'input');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'uitest/out/r2_replay_bar.png' });

  // 点「AI评估」，等服务端真实引擎返回
  await page.click('#replay-ai');
  await page.waitForTimeout(6000);
  await page.screenshot({ path: 'uitest/out/r3_suggestion.png' });

  // 翻走再翻回来：文案应消失又重现（缓存重亮环）
  await page.fill('#replay-slider', '0');
  await page.dispatchEvent('#replay-slider', 'input');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'uitest/out/r4_moved_away.png' });
  await page.fill('#replay-slider', '2');
  await page.dispatchEvent('#replay-slider', 'input');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'uitest/out/r5_back_cached.png' });

  const aiText = await page.textContent('#replay-ai-result');
  const aiDisabled = await page.getAttribute('#replay-ai', 'disabled');
  console.log('result text:', aiText);
  console.log('button disabled:', aiDisabled !== null);
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
