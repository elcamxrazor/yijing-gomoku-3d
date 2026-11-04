/* 测量气泡「出现」时的逐帧透明度，判断是否有淡入过渡。 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:25562';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('[data-mode="local"]', { timeout: 30000 });
  await page.click('[data-mode="local"]');
  await page.waitForTimeout(300);
  await page.click('#start-local');
  await page.waitForTimeout(3200);

  const result = await page.evaluate(async () => {
    const layer = document.getElementById('phrase-layer');
    const sample = async (index, ms) => {
      const out = [];
      const start = performance.now();
      while (performance.now() - start < ms) {
        const el = layer.querySelectorAll('.phrase-bubble')[index];
        if (el) {
          const cs = getComputedStyle(el);
          out.push({
            t: Math.round(performance.now() - start),
            opacity: Math.round(parseFloat(cs.opacity) * 100) / 100,
            scale: Math.round(parseFloat(cs.transform.split('(')[1] || '1') * 1000) / 1000,
          });
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      return out;
    };
    const clickChip = async (i) => {
      document.getElementById('phrase-toggle').click();
      await new Promise((r) => setTimeout(r, 120));
      document.querySelectorAll('#phrase-panel .phrase-chip')[i]?.click();
    };

    await clickChip(0);
    const firstBubble = await sample(0, 420);
    await new Promise((r) => setTimeout(r, 300));
    await clickChip(1);
    const secondBubble = await sample(1, 420);
    return { firstBubble, secondBubble };
  });

  for (const [label, samples] of Object.entries(result)) {
    const nonZero = samples.filter((s) => s.opacity > 0);
    const deadFrames = samples.findIndex((s) => s.opacity > 0);
    console.log(`--- ${label} ---`);
    console.log('  帧数:', samples.length, '| 首个非零透明度所在帧序:', deadFrames);
    console.log('  前 8 帧:', JSON.stringify(samples.slice(0, 8)));
    console.log('  不同透明度个数:', new Set(samples.map((s) => s.opacity)).size,
      '| 是否从 0 起步:', samples[0]?.opacity === 0);
  }
  await browser.close();
})();
