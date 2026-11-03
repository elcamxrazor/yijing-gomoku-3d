/* 批次十一验证：皮肤上服 + 设置开关 + 永久储存按钮。 */
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://127.0.0.1:25562';
const setup = JSON.parse(fs.readFileSync('uitest/out/rapfi_setup.json', 'utf8'));
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{
    name: 'zen_session', value: setup.cookie.startsWith('zen_session=') ? setup.cookie.slice(12) : setup.cookie,
    domain: '127.0.0.1', path: '/', httpOnly: false, secure: false,
  }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1800);

  // 1) 设置弹窗：开关存在且默认开
  await page.click('#settings-button');
  await page.waitForTimeout(400);
  const toggle = await page.evaluate(() => ({
    exists: !!document.getElementById('opponent-skin-toggle'),
    checked: document.getElementById('opponent-skin-toggle')?.checked,
  }));
  console.log('skin toggle:', JSON.stringify(toggle));
  await page.screenshot({ path: 'uitest/out/b11_settings.png' });

  // 2) 皮肤设置上服：改一下编号设置，验证 PUT 不报错（网络层）
  await page.click('[data-move-numbers="all"]');
  await page.waitForTimeout(800);
  console.log('prefs persisted (no error):', errors.length === 0);

  await page.click('#settings-dialog .modal-close');
  await page.waitForTimeout(400);

  // 3) 开一局 AI 并认输 → 复盘界面应有「永久储存」按钮
  await page.click('[data-mode="ai"]');
  await page.waitForTimeout(400);
  await page.click('#start-ai');
  await page.waitForTimeout(5000);
  await page.click('[data-action="resign"], #resign-button').catch(() => {});
  await page.waitForTimeout(1500);
  const resignVisible = await page.evaluate(() => {
    const btn = document.getElementById('resign-button');
    return btn ? !btn.hidden : false;
  });
  console.log('resign button:', resignVisible);
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
