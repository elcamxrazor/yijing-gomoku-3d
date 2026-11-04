/* 动效回归：① 弹窗遮罩开/关都有过渡；② 带 data-fade 的组件隐藏时先淡出再消失。 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:25562';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-mode="local"]', { timeout: 30000 });
  await page.click('[data-mode="local"]');
  await page.waitForTimeout(300);
  await page.click('#start-local');
  await page.waitForTimeout(3000);

  // ① 遮罩
  const backdrop = await page.evaluate(async () => {
    const dlg = document.getElementById('settings-dialog');
    const read = () => getComputedStyle(dlg, '::backdrop').opacity;
    dlg.showModal();
    await new Promise((r) => setTimeout(r, 320));
    dlg.close();
    const seen = new Set();
    const t0 = performance.now();
    while (performance.now() - t0 < 320) {
      seen.add(Math.round(parseFloat(read()) * 100) / 100);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { values: [...seen] };
  });
  console.log('遮罩关闭中间值个数:', backdrop.values.length, '| 终值:', backdrop.values[backdrop.values.length - 1]);

  // ② data-fade 组件
  const fades = [];
  for (const id of ['waiting-card', 'phrase-panel', 'radio-card', 'presence-alert']) {
    const r = await page.evaluate(async (id) => {
      const el = document.getElementById(id);
      if (id === 'phrase-panel') {
        document.getElementById('phrase-zone').hidden = false;
        document.getElementById('phrase-toggle').click();
      } else {
        el.hidden = false;
      }
      await new Promise((res) => setTimeout(res, 420));
      el.hidden = true;
      const seen = new Set();
      let visible = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 400) {
        const cs = getComputedStyle(el);
        if (cs.display !== 'none') visible += 1;
        seen.add(Math.round(parseFloat(cs.opacity) * 100) / 100);
        await new Promise((res) => requestAnimationFrame(res));
      }
      if (id === 'phrase-panel') {
        document.getElementById('phrase-toggle').click();
        document.getElementById('phrase-zone').hidden = true;
      }
      return { visible, values: seen.size };
    }, id);
    fades.push(`${id}: 可见帧 ${r.visible}, 透明度取值 ${r.values}`);
  }
  console.log(fades.join(' | '));
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
