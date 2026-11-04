/* 移动端开局遮罩视觉抽查：模拟硬币已落地 + 结果文字，确认硬币居中且不越界。 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:25562';
const VIEWPORT = process.env.H ? { width: 390, height: Number(process.env.H) } : { width: 390, height: 844 };

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await (await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 3, isMobile: true, hasTouch: true })).newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('[data-mode="local"]', { timeout: 30000 });

  const info = await page.evaluate(() => {
    const overlay = document.getElementById('opening-overlay');
    const card = document.getElementById('opening-card');
    const coin = document.getElementById('opening-coin');
    const wrap = document.getElementById('coin-canvas-wrap');
    const result = document.getElementById('opening-result');
    overlay.hidden = false;
    card.hidden = true;
    coin.hidden = false;
    const c = document.createElement('div');
    c.style.cssText = 'width:100%;height:100%;border-radius:50%;background:radial-gradient(circle at 36% 30%,#f7f1e2,#c9a24a 55%,#8d6a24);display:grid;place-items:center;font-size:34px;font-weight:700;color:#4a3410';
    c.textContent = '张三';
    wrap.replaceChildren(c);
    result.textContent = '硬币落地 · 张三 先手';
    const r = wrap.getBoundingClientRect();
    return { wrap: { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }, vh: window.innerHeight };
  });
  console.log(JSON.stringify(info));
  await page.screenshot({ path: `uitest/out/mobile_coin_${VIEWPORT.height}.png` });
  await browser.close();
})();
