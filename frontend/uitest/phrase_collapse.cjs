/* 验证短语气泡「让位」动画：上面一条到期收起时，下面一条应匀速上滑，
 * 而不是瞬间跳到上一格的位置。 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:25562';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('[data-mode="local"]', { timeout: 30000 });
  await page.click('[data-mode="local"]');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const input = document.querySelector('input[name="local-scene"][value="tea"]');
    if (input) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.click('#start-local');
  await page.waitForTimeout(3200);

  // 连发两条短语
  for (const index of [0, 1]) {
    await page.evaluate(() => document.getElementById('phrase-toggle').click());
    await page.waitForTimeout(120);
    await page.evaluate((i) => {
      const chips = document.querySelectorAll('#phrase-panel .phrase-chip');
      if (chips[i]) chips[i].click();
    }, index);
    await page.waitForTimeout(index === 0 ? 1000 : 120);
  }

  const before = await page.evaluate(() => [...document.querySelectorAll('#phrase-layer .phrase-bubble')].map((el) => {
    const r = el.getBoundingClientRect();
    return { text: (el.textContent || '').trim().slice(0, 12), top: Math.round(r.top), height: Math.round(r.height) };
  }));
  console.log('两条气泡初始位置:', JSON.stringify(before));

  // 等第一条开始收起，然后逐帧记录剩下那条的 top
  const samples = await page.evaluate(async () => {
    const layer = document.getElementById('phrase-layer');
    const t0 = performance.now();
    while (!layer.querySelector('.phrase-bubble.collapsing') && performance.now() - t0 < 8000) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    const out = [];
    const start = performance.now();
    while (performance.now() - start < 900) {
      const el = layer.querySelector('.phrase-bubble:not(.collapsing)');
      out.push({
        t: Math.round(performance.now() - start),
        top: el ? Math.round(el.getBoundingClientRect().top * 10) / 10 : null,
        nodes: layer.childElementCount,
      });
      await new Promise((r) => requestAnimationFrame(r));
    }
    return out;
  });

  const tops = samples.map((s) => s.top).filter((v) => v !== null);
  let maxStep = 0;
  for (let i = 1; i < tops.length; i += 1) maxStep = Math.max(maxStep, Math.abs(tops[i] - tops[i - 1]));
  const travel = tops.length ? tops[0] - tops[tops.length - 1] : 0;

  console.log('帧数:', samples.length, '| 起点 top:', tops[0], '| 终点 top:', tops[tops.length - 1]);
  console.log('总位移:', Math.round(travel * 10) / 10, 'px | 相邻帧最大跳变:', Math.round(maxStep * 10) / 10, 'px');
  console.log('位移是否分步完成(>=5 个不同位置):', new Set(tops).size >= 5);
  console.log('是否存在瞬间跳位(单帧 > 总位移 60%):', travel > 1 && maxStep > travel * 0.6);

  await page.screenshot({ path: 'uitest/out/phrase_collapse.png' });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
