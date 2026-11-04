/* 验证退场动画：close() / hidden 之后，过渡中元素仍可见且 opacity 正在下降。 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:25562';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-mode="local"]', { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const probe = (el) => ({ opacity: getComputedStyle(el).opacity, display: getComputedStyle(el).display });

    // 1) <dialog>.close()
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.textContent = 'anim test';
    document.body.appendChild(dlg);
    dlg.showModal();
    await wait(320);
    const dialogOpen = probe(dlg);
    dlg.close();
    await wait(80);
    const dialogMid = probe(dlg);
    await wait(280);
    const dialogAfter = probe(dlg);
    dlg.remove();

    // 2) .float-card[hidden]
    const card = document.createElement('div');
    card.className = 'float-card';
    card.textContent = 'card';
    document.body.appendChild(card);
    await wait(340);
    card.hidden = true;
    await wait(90);
    const cardMid = probe(card);
    await wait(280);
    const cardAfter = probe(card);
    card.remove();

    // 3) .phrase-panel[hidden]
    const panel = document.createElement('div');
    panel.className = 'phrase-panel';
    panel.textContent = 'panel';
    document.body.appendChild(panel);
    await wait(240);
    panel.hidden = true;
    await wait(60);
    const panelMid = probe(panel);
    panel.remove();

    // 4) 开局遮罩 + 硬币退场
    const ov = document.createElement('div');
    ov.className = 'opening-overlay';
    const cw = document.createElement('div');
    cw.className = 'coin-canvas-wrap';
    ov.appendChild(cw);
    document.body.appendChild(ov);
    await wait(320);
    ov.classList.add('leaving');
    cw.classList.add('leaving');
    await wait(100);
    const overlayMid = {
      opacity: getComputedStyle(ov).opacity,
      coinTransform: getComputedStyle(cw).transform,
      coinFilter: getComputedStyle(cw).filter,
    };
    ov.remove();

    return { dialogOpen, dialogMid, dialogAfter, cardMid, cardAfter, panelMid, overlayMid };
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
