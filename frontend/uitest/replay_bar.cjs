/* 复盘播放条布局回归：宽屏 / 窄屏下「永久储存」都必须单行显示且不溢出播放条。 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:25562';

const check = async (browser, width, height) => {
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('[data-mode="local"]', { timeout: 30000 });
  await page.waitForTimeout(300);

  const r = await page.evaluate(async () => {
    const bar = document.getElementById('replay-bar');
    const keep = document.getElementById('replay-keep');
    const controls = document.querySelector('.replay-controls');
    const ai = document.getElementById('replay-ai-result');
    // 放一段最长的 AI 结果，模拟最挤的情况
    ai.textContent = '推荐 (7, 7) 评分 12.3';
    document.body.classList.add('is-replaying');
    bar.hidden = false;
    // 等淡入过渡走完再量，避免量到 opacity 还在路上的中间态
    await new Promise((r2) => setTimeout(r2, 420));

    const br = bar.getBoundingClientRect();
    const kr = keep.getBoundingClientRect();
    const cr = controls.getBoundingClientRect();
    const cs = getComputedStyle(keep);
    return {
      bar: { left: Math.round(br.left), right: Math.round(br.right), width: Math.round(br.width) },
      keep: { left: Math.round(kr.left), right: Math.round(kr.right), width: Math.round(kr.width), height: Math.round(kr.height) },
      keepNowrap: cs.whiteSpace === 'nowrap',
      keepTextOverflow: keep.scrollWidth - keep.clientWidth,
      keepSingleLine: kr.height <= 34,
      controls: { width: Math.round(cr.width), scrollWidth: controls.scrollWidth },
      overflowX: controls.scrollWidth - Math.round(cr.width),
      keepInsideBar: kr.right <= br.right + 1 && kr.left >= br.left - 1,
      text: keep.textContent.trim(),
    };
  });
  console.log(`--- ${width}×${height} ---`);
  console.log(JSON.stringify(r));
  await page.screenshot({ path: `uitest/out/replay_bar_${width}.png` });
  await page.close();
  return r;
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  await check(browser, 1280, 800);
  await check(browser, 390, 844);
  await check(browser, 360, 720);
  await browser.close();
})();
