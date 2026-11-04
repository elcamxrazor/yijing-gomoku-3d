/* 复盘 → 一键续弈：从棋谱的某一手开一局人机，盘面原样保留。 */
let playwright;
try {
  playwright = require('playwright');
} catch {
  // 没装完整包时退到 core：本脚本只用系统 Edge，不需要下载自带浏览器。
  playwright = require('playwright-core');
}
const { chromium } = playwright;
const BASE = process.env.BASE || 'http://127.0.0.1:25599';

async function moveCount(page) {
  const text = await page.textContent('#move-count').catch(() => '');
  const match = (text || '').match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function ensureGuest(page) {
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
  }
  await page.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  });
}

async function place(page, points) {
  for (const [x, y] of points) {
    const before = await moveCount(page);
    await page.mouse.click(x, y);
    const grown = await page
      .waitForFunction(
        (prev) => {
          const text = document.querySelector('#move-count')?.textContent ?? '';
          const match = text.match(/(\d+)/);
          return match ? Number(match[1]) > prev : false;
        },
        before,
        { timeout: 5000 },
      )
      .then(() => true)
      .catch(() => false);
    if (grown) {
      // 等 AI 那一手回来：手数再涨一次。
      await page
        .waitForFunction(
          (prev) => {
            const text = document.querySelector('#move-count')?.textContent ?? '';
            const match = text.match(/(\d+)/);
            return match ? Number(match[1]) >= prev + 2 : false;
          },
          before,
          { timeout: 25000 },
        )
        .catch(() => {});
      return true;
    }
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const steps = [];
  const check = (label, ok, extra = '') => {
    steps.push(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
    return ok;
  };

  try {
    await ensureGuest(page);

    // 开一局人机（默认执黑）。
    await page.click('[data-mode="ai"]');
    await page.waitForSelector('#game-dialog[open]', { timeout: 10000 });
    await page.click('#start-ai');
    await page.waitForFunction(() => {
      const badge = document.getElementById('turn-badge');
      return !!badge && !badge.hidden;
    }, { timeout: 30000 });

    const placedA = await place(page, [[640, 430], [660, 440], [620, 420]]);
    const placedB = placedA ? await place(page, [[600, 380], [680, 380], [600, 480]]) : false;
    const beforeResign = await moveCount(page);
    check('残局前先下满两轮', placedA && placedB, `手数 ${beforeResign}`);

    // 认输进结算卡。
    await page.click('#resign-button');
    await page.waitForSelector('#confirm-dialog[open]', { timeout: 10000 });
    await page.click('#confirm-accept');
    await page.waitForSelector('#result-card:not([hidden])', { timeout: 15000 });

    // 复盘。
    await page.click('#result-replay');
    await page.waitForSelector('#replay-bar:not([hidden])', { timeout: 15000 });
    const total = Number(await page.textContent('#replay-progress').then((t) => (t || '').split('/')[1]?.trim() ?? 0));
    check('棋谱有可复盘的手数', total >= 2, `共 ${total} 手`);

    // 拖到第 1 手（中盘任意一手）。
    await page.evaluate(() => {
      const slider = document.getElementById('replay-slider');
      slider.value = '1';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(300);

    const disabled = await page.getAttribute('#replay-continue', 'disabled');
    check('中盘时「续弈」可用', disabled === null);

    await page.click('#replay-continue');
    await page.waitForSelector('#continue-dialog[open]', { timeout: 10000 });
    const subtitle = (await page.textContent('#continue-subtitle'))?.trim() ?? '';
    const blackNote = (await page.textContent('#continue-black-note'))?.trim() ?? '';
    const whiteNote = (await page.textContent('#continue-white-note'))?.trim() ?? '';
    check('弹窗说明了从第几手接手', subtitle.includes('第 1 手'), subtitle);
    check('两个按钮都标明了先后手', blackNote.length > 0 && whiteNote.length > 0, `${blackNote} / ${whiteNote}`);
    // 弹窗有 0.22s 的入场动画，截图要等它落定，否则拍到的是一帧透明。
    await page.waitForTimeout(600);
    check('弹窗真的显示出来了', await page.isVisible('#continue-dialog'), '');
    await page.screenshot({ path: 'uitest/shot-continue-dialog.png' });

    // 点「计算机执白」= 人执黑。
    await page.click('#continue-dialog [data-ai-color="white"]');
    await page.waitForFunction(() => {
      const dialog = document.getElementById('continue-dialog');
      return !!dialog && !dialog.open;
    }, { timeout: 10000 });
    await page.waitForFunction(() => {
      const text = document.querySelector('#move-count')?.textContent ?? '';
      const match = text.match(/(\d+)/);
      return match ? Number(match[1]) === 1 : false;
    }, { timeout: 25000 }).catch(() => {});

    const afterCount = await moveCount(page);
    const yourColor = await page.textContent('#current-color').catch(() => '');
    check('新局从第 1 手接手（盘上 1 颗子）', afterCount === 1, `手数 ${afterCount}`);
    // 1 手残局轮到白方；人执黑，所以该 AI 走 —— 徽标会写「对方正在思考」。
    const badge = (await page.textContent('#turn-badge'))?.trim() ?? '';
    check('轮到 AI 时立刻开始思考', badge.includes('思考'), badge);

    // 引擎真的在残局上算出并提交了一手（不是只把界面点亮）。
    await page
      .waitForFunction(
        () => {
          const text = document.querySelector('#move-count')?.textContent ?? '';
          const match = text.match(/(\d+)/);
          return match ? Number(match[1]) >= 2 : false;
        },
        { timeout: 45000 },
      )
      .catch(() => {});
    const afterAi = await moveCount(page);
    check('AI 在残局盘面上落子成功', afterAi >= 2, `手数 ${afterAi}`);

    const playedOn = await place(page, [
      [560, 380], [700, 440], [580, 470], [720, 380], [520, 430], [640, 510],
    ]);
    check('接手后玩家能继续落子', playedOn, `手数 ${await moveCount(page)}`);
    await page.screenshot({ path: 'uitest/shot-continue-game.png' });

    // 重开：回到残局起点，而不是退回空盘。
    await page.click('#restart-button');
    const confirmed = await page
      .waitForSelector('#confirm-dialog[open]', { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (confirmed) {
      const message = (await page.textContent('#confirm-message'))?.trim() ?? '';
      check('重开确认文案提到残局起点', message.includes('残局'), message);
      await page.click('#confirm-accept');
    }
    let sawStart = false;
    for (let i = 0; i < 40; i += 1) {
      if ((await moveCount(page)) === 1) {
        sawStart = true;
        break;
      }
      await page.waitForTimeout(100);
    }
    check('重开回到残局起点而不是空盘', sawStart, `最终手数 ${await moveCount(page)}`);

    check('没有页面异常', errors.length === 0, errors.join(' | '));
  } catch (error) {
    steps.push(`ERROR ${error.message}`);
    await page.screenshot({ path: 'uitest/shot-continue-error.png' }).catch(() => {});
  } finally {
    console.log(steps.join('\n'));
    await browser.close();
  }
})();
