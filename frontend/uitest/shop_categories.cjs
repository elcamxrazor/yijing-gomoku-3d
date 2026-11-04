/**
 * 商城分类切换 + 实物兑换的 UI 验收（人工跑，不进 CI）。
 *   node uitest/shop_categories.cjs
 * 可用 SHOP_BASE 指定地址（默认本机 25562）：
 *   SHOP_BASE=http://127.0.0.1:25570/ node uitest/shop_categories.cjs
 * 产出：uitest/out/shop_tab_pieces.png / _boards.png / _physical.png / shop_bought.png / shop_mobile.png
 */
const { chromium } = require('playwright');

const BASE = process.env.SHOP_BASE || 'http://127.0.0.1:25562/';

async function openShop(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // 商城购买需要会话：没有就建一个游客（与真实用户首次进入的路径一致）。
  await page.evaluate(() => fetch('/api/auth/guest', { method: 'POST' }).catch(() => null));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  // 用脚本点击：首页有入场遮罩时会挡住真实点击，这里只关心商城本身。
  await page.evaluate(() => document.getElementById('shop-button').click());
  await page.waitForSelector('#shop-dialog[open]');
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const shot = async (name) => (await page.$('#shop-dialog')).screenshot({ path: `uitest/out/${name}.png` });

  await openShop(page);
  await shot('shop_tab_pieces');
  console.log('棋子分类商品数 =', await page.$$eval('.shop-item', (els) => els.length));

  await page.click('[data-shop-tab="boards"]');
  await page.waitForTimeout(300);
  await shot('shop_tab_boards');
  console.log('棋盘分类空态 =', await page.$eval('.shop-empty', (el) => el.textContent.trim()));

  await page.click('[data-shop-tab="physical"]');
  await page.waitForTimeout(300);
  await shot('shop_tab_physical');
  const before = await page.$eval('.shop-points strong', (el) => el.textContent.trim());
  await page.click('[data-shop-action="unlock"][data-item="goods-xiaomi-su7"]');
  await page.waitForTimeout(1500);
  const after = await page.$eval('.shop-points strong', (el) => el.textContent.trim());
  const label = await page.$eval('.shop-item .shop-action button', (el) => el.textContent.trim());
  console.log(`兑换小米SU7：积分 ${before} -> ${after}，按钮「${label}」`);
  await shot('shop_bought');

  // 切回棋子：确认来回切换不丢内容、不误改已购状态
  await page.click('[data-shop-tab="pieces"]');
  await page.waitForTimeout(300);
  console.log('切回棋子后商品数 =', await page.$$eval('.shop-item', (els) => els.length));

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await openShop(mobile);
  await mobile.click('[data-shop-tab="physical"]');
  await mobile.waitForTimeout(300);
  await (await mobile.$('#shop-dialog')).screenshot({ path: 'uitest/out/shop_mobile.png' });

  await browser.close();
})();
