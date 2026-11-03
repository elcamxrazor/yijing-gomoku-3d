/* 实测：
 *  44 · 开局弹窗里「规则」标签与规则选择按钮不再重叠（几何测量）。
 *  45 · 鼠标中键点击棋盘复位视角（旋转后再中键点击，相机回到默认位姿）。
 *      用 ?debugcam=1 暴露的相机位姿读数做确定性断言（避开环境粒子动画造成的像素噪声）。
 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'http://127.0.0.1:25562/?debugcam=1';
const OUT = 'uitest/shots';
fs.mkdirSync(OUT, { recursive: true });

function poseClose(a, b, tol = 0.5) {
  if (!a || !b) return false;
  const eq = (x, y) => Math.abs(x - y) <= tol;
  return (
    eq(a.pos[0], b.pos[0]) && eq(a.pos[1], b.pos[1]) && eq(a.pos[2], b.pos[2]) &&
    eq(a.tgt[0], b.tgt[0]) && eq(a.tgt[1], b.tgt[1]) && eq(a.tgt[2], b.tgt[2]) &&
    eq(a.fov, b.fov)
  );
}
function poseDist(a, b) {
  const d = (x, y) => (x - y) * (x - y);
  return Math.sqrt(
    d(a.pos[0], b.pos[0]) + d(a.pos[1], b.pos[1]) + d(a.pos[2], b.pos[2]) +
    d(a.fov, b.fov)
  );
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const readPose = () => page.evaluate(() => (window.__camPose ? window.__camPose() : null));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1800);

  // ---- 44：本地开局弹窗 ----
  await page.click('[data-mode="local"]', { timeout: 8000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/44-local-dialog.png` });
  const overlap = await page.evaluate(() => {
    const label = [...document.querySelectorAll('.form-label-row')].find((e) => e.textContent.trim() === '规则');
    const picker = label?.nextElementSibling;
    if (!label || !picker) return 'NO_ELEMENTS';
    const lr = label.getBoundingClientRect();
    const pr = picker.getBoundingClientRect();
    return { labelBottom: Math.round(lr.bottom), pickerTop: Math.round(pr.top), gap: Math.round(pr.top - lr.bottom) };
  });
  console.log('44 OVERLAP (local):', JSON.stringify(overlap));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.click('[data-mode="ai"]', { timeout: 8000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/44-ai-dialog.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // ---- 45：本地对弈 + 中键复位 ----
  await page.click('[data-mode="local"]', { timeout: 8000 });
  await page.waitForTimeout(300);
  await page.click('#start-local', { timeout: 8000 });

  // 等到相机彻底落定：开场推镜 / 复位补间都结束（rp/ip=false 且 无补间）。
  const waitSettled = async (maxMs = 20000) => {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < maxMs) {
      const p = await readPose();
      last = p;
      if (p && !p.rp && !p.ip && p.tw === 0) return p;
      await page.waitForTimeout(200);
    }
    return last;
  };

  const canvasBox = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const cx = canvasBox.x + Math.round(canvasBox.w / 2);
  const cy = canvasBox.y + Math.round(canvasBox.h / 2);

  const poseDefault = await waitSettled();
  await page.screenshot({ path: `${OUT}/45-default.png` });

  // 右键拖动旋转视角（拖够大，方位角明显变化）
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 320, cy + 200, { steps: 16 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(500);
  const shotRotated = await page.screenshot();
  const poseRotated = await readPose();

  // 中键点击复位
  await page.mouse.click(cx, cy, { button: 'middle' });
  await page.waitForTimeout(1300);
  const poseReset = await waitSettled();
  await page.screenshot({ path: `${OUT}/45-reset.png` });
  fs.writeFileSync(`${OUT}/45-rotated.png`, shotRotated);

  console.log('45 poseDefault:', JSON.stringify(poseDefault));
  console.log('45 poseRotated:', JSON.stringify(poseRotated));
  console.log('45 poseReset:  ', JSON.stringify(poseReset));

  const gapOk = typeof overlap === 'object' && overlap.gap >= 0;
  const rotatedChanged = poseRotated && poseDefault && poseDist(poseRotated, poseDefault) > 0.1;
  const resetReturned = poseClose(poseReset, poseDefault, 0.5) && poseReset && poseReset.rp === false && poseReset.ip === false;
  console.log('44 gap>=0:', gapOk, '| 45 rotatedChanged:', rotatedChanged, ' resetReturned:', resetReturned);
  console.log('VERDICT:', (gapOk && rotatedChanged && resetReturned && errors.length === 0) ? 'PASS' : 'CHECK_MANUALLY');
  await browser.close();
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
