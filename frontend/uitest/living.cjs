/* 客厅棋境截图：解锁 scene-living → 开 AI 局 → 推镜结束后截图。 */
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:25562';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // 预置档案：解锁客厅棋境（商城未解锁也能截图）。
  await page.addInitScript(() => {
    localStorage.setItem('yijing.profile.v1', JSON.stringify({
      version: 1, points: 500,
      unlocked: ['scene-courtyard', 'scene-cyber', 'scene-living'],
      equipped: { materialBlack: 'lacquer-black', materialWhite: 'jade-white' },
      settledGames: [],
    }));
  });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('requestfailed', (r) => errors.push('reqfail: ' + r.url()));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });

  // 进 AI 弹窗，选客厅棋境执黑开局。
  await page.click('[data-mode="ai"]', { timeout: 30000 });
  await page.waitForTimeout(300);
  const livingRadio = page.locator('input[name="ai-scene"][value="living"]');
  if (await livingRadio.count()) {
    await livingRadio.check({ force: true });
    console.log('选中 living 棋境');
  } else {
    console.log('!! 找不到 living 单选卡');
  }
  await page.click('#start-ai');
  await page.waitForTimeout(500);

  // 等推镜（5.6s）结束 + 模型加载：总给足 25s，然后确认画面稳定。
  // 推镜中段截一张：此时能看到整条客厅动线。
  await page.waitForTimeout(2600);
  await page.screenshot({ path: 'uitest/out/living_midintro.png' });
  await page.waitForTimeout(22400);

  await page.screenshot({ path: 'uitest/out/living_intro.png' });

  // 落一子：点棋盘中心偏上的交叉点，验证拾取与棋子渲染
  await page.mouse.click(540, 245);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'uitest/out/living_move.png' });

  // 拉远看客厅全景：分几步滚轮，留出阻尼收敛时间
  await page.mouse.move(640, 400);
  for (let i = 0; i < 5; i += 1) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'uitest/out/living_wide.png' });

  // 右键拖拽旋转到低角度：看沙发、电视墙与整个客厅动线
  await page.mouse.move(640, 300);
  await page.waitForTimeout(300);
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(150);
  await page.mouse.move(640, 640, { steps: 30 });
  await page.waitForTimeout(150);
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'uitest/out/living_room_view.png' });

  console.log('errors:', errors.length ? errors.slice(0, 10) : 'none');
  await browser.close();
})();
