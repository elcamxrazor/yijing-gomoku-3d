/* 本轮改动验证：本地棋境选择 / 编号与圆点互斥 / 短语按钮并入操作坞 / 2K 棋盘。 */
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:25562';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // 预置档案：解锁客厅棋境（商城未解锁时对应单选卡是禁用的）。
  await page.addInitScript(() => {
    localStorage.setItem('yijing.profile.v1', JSON.stringify({
      version: 1, points: 500,
      unlocked: ['scene-courtyard', 'scene-cyber', 'scene-living'],
      equipped: { materialBlack: 'solid-black', materialWhite: 'solid-white' },
      settledGames: [],
    }));
  });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);

  // 1) 本地对弈 → 开局弹窗带棋境选择
  await page.click('[data-mode="local"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'uitest/out/b3_local_dialog.png' });

  // 选「现代客厅」开局（顺带回归上一轮的客厅接入）
  const livingRadio = page.locator('input[name="local-scene"][value="living"]');
  if (await livingRadio.count()) await livingRadio.check({ force: true });
  await page.click('#start-local');
  await page.waitForTimeout(8000); // 等推镜 + 模型
  await page.screenshot({ path: 'uitest/out/b3_local_start.png' });

  // 2) 落两子（本地同屏轮流），等圆点延迟窗口过去后截图：应看到最新一手圆点
  await page.mouse.click(620, 330);
  await page.waitForTimeout(1200);
  await page.mouse.click(700, 330);
  await page.waitForTimeout(1200);
  await page.mouse.click(560, 330);
  await page.waitForTimeout(1400);
  await page.screenshot({ path: 'uitest/out/b3_dot_on.png' });

  // 3) 开启手数编号（最新一步）：圆点应消失，只剩红字
  await page.click('#settings-button');
  await page.waitForTimeout(300);
  await page.click('[data-move-numbers="last"]');
  await page.waitForTimeout(200);
  await page.click('[data-close="settings-dialog"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'uitest/out/b3_numbers_no_dot.png' });
  // 关掉编号，恢复圆点
  await page.click('#settings-button');
  await page.waitForTimeout(300);
  await page.click('[data-move-numbers="off"]');
  await page.click('[data-close="settings-dialog"]');

  // 4) 短语按钮在操作坞里：展开面板截图
  await page.click('#phrase-toggle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'uitest/out/b3_phrase_dock.png' });
  await page.keyboard.press('Escape');

  console.log('errors:', errors.length ? errors.slice(0, 10) : 'none');
  await browser.close();
})();
