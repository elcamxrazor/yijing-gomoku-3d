/* 移动端布局回归：
 * 1) 短语气泡层级——必须挂在 #app 下、不被叙事行/顶栏压住，且不与之几何重叠；
 * 2) 开局硬币——结果文字出现时硬币窗口不得位移（min-height 预留占位）。
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:25562';
const VIEWPORT = { width: 390, height: 844 };

const rect = (el) => {
  const r = el.getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('[data-mode="local"]', { timeout: 30000 });
  await page.click('[data-mode="local"]');
  await page.waitForTimeout(300);
  await page.click('#start-local');
  await page.waitForTimeout(3200);

  // ---- 1) 短语气泡 ----
  for (const i of [0, 1]) {
    await page.evaluate(() => document.getElementById('phrase-toggle').click());
    await page.waitForTimeout(140);
    await page.evaluate((k) => document.querySelectorAll('#phrase-panel .phrase-chip')[k]?.click(), i);
    await page.waitForTimeout(280);
  }
  await page.waitForTimeout(250);

  const phraseReport = await page.evaluate(() => {
    const layer = document.getElementById('phrase-layer');
    const toRect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; };
    const bubbles = [...layer.querySelectorAll('.phrase-bubble')].map((el) => ({ text: (el.textContent || '').trim().slice(0, 8), rect: toRect(el) }));
    const hud = ['.hud-top', '.narration', '.turn-badge', '.status-row']
      .map((sel) => { const el = document.querySelector(sel); return el ? { sel, rect: toRect(el) } : null; })
      .filter(Boolean);
    return {
      parent: layer.parentElement.id || layer.parentElement.className,
      zIndex: getComputedStyle(layer).zIndex,
      paddingTop: getComputedStyle(layer).paddingTop,
      bubbles, hud,
    };
  });

  const overlap = (a, b) => a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right;
  const hits = [];
  for (const b of phraseReport.bubbles) {
    for (const h of phraseReport.hud) {
      if (overlap(b.rect, h.rect)) hits.push(`${b.text} × ${h.sel}`);
    }
  }

  console.log('--- 短语气泡 ---');
  console.log('父节点:', phraseReport.parent, '| z-index:', phraseReport.zIndex, '| padding-top:', phraseReport.paddingTop);
  for (const b of phraseReport.bubbles) console.log('  气泡:', b.text, JSON.stringify(b.rect));
  for (const h of phraseReport.hud) console.log('  HUD :', h.sel, JSON.stringify(h.rect));
  console.log('与 HUD 几何重叠:', hits.length ? hits : '无');
  await page.screenshot({ path: 'uitest/out/mobile_phrase.png' });

  // ---- 2) 开局硬币结果文字不推动硬币窗口 ----
  const coinReport = await page.evaluate(() => {
    const overlay = document.getElementById('opening-overlay');
    const card = document.getElementById('opening-card');
    const coin = document.getElementById('opening-coin');
    const wrap = document.getElementById('coin-canvas-wrap');
    const result = document.getElementById('opening-result');
    overlay.hidden = false;
    card.hidden = true;
    coin.hidden = false;
    const canvas = document.createElement('canvas');
    canvas.width = 420; canvas.height = 420;
    canvas.style.cssText = 'width:100%;height:100%;display:block';
    wrap.replaceChildren(canvas);
    result.textContent = '';
    const before = wrap.getBoundingClientRect();
    result.textContent = '硬币落地 · 张三 先手';
    const after = wrap.getBoundingClientRect();
    const out = {
      before: { top: Math.round(before.top), height: Math.round(before.height) },
      after: { top: Math.round(after.top), height: Math.round(after.height) },
      shift: Math.round((after.top - before.top) * 10) / 10,
      resultHeight: Math.round(result.getBoundingClientRect().height),
    };
    overlay.hidden = true;
    return out;
  });
  console.log('--- 开局硬币 ---');
  console.log('硬币窗口 前:', JSON.stringify(coinReport.before), '后:', JSON.stringify(coinReport.after));
  console.log('位移:', coinReport.shift, 'px | 结果文字高:', coinReport.resultHeight);

  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
