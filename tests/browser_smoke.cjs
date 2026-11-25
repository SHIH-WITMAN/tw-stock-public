/**
 * Headless Playwright smoke test for Phase 1 static frontend (`web/` Layout A).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.STOCK_QA_PLAYWRIGHT_MODULE || 'playwright');

const WEB_DIR = path.resolve(__dirname, '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const full = path.resolve(WEB_DIR, rel);
      if (!full.startsWith(WEB_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const ext = path.extname(full);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(full).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

(async () => {
  const { server, url } = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('.stat-card');
    const cardCount = await page.locator('.stat-card').count();
    assert.equal(cardCount, 5, 'default 4 tickers + TAIEX = 5 cards');

    // Verify removed buttons are truly absent
    assert.equal(await page.locator('#btn-png').count(), 0, 'PNG button removed');
    assert.equal(await page.locator('#chart-title-input').count(), 0, 'Custom title input removed');
    assert.equal(await page.locator('#btn-export-cfg').count(), 0, 'Export config button removed');
    assert.equal(await page.locator('#btn-import-cfg').count(), 0, 'Import config button removed');

    // Verify Layout A: selected chips visible, category drawer collapsed by default
    const pillCount = await page.locator('#selected-chips .sel-pill').count();
    assert.equal(pillCount, 5, 'TAIEX + 4 selected pills shown');
    const drawerHiddenInitially = await page.locator('#category-drawer').evaluate((n) => n.classList.contains('hidden'));
    assert.equal(drawerHiddenInitially, true, 'Category drawer collapsed by default');

    // Expand drawer and toggle a ticker
    await page.locator('#btn-toggle-drawer').click();
    const drawerHiddenAfter = await page.locator('#category-drawer').evaluate((n) => n.classList.contains('hidden'));
    assert.equal(drawerHiddenAfter, false, 'Category drawer expands on click');

    // Search dropdown instant add/remove
    await page.locator('#ticker-search').fill('2603');
    await page.waitForSelector('#search-dropdown .search-item');
    await page.locator('#search-dropdown .search-item').first().click();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.stat-card').count(), 6, '2603 added via search dropdown');

    // Focus click on second card -> auto-includes benchmark + dims rest
    await page.locator('.stat-card').nth(1).click();
    const focusedCount = await page.locator('.stat-card.focused').count();
    assert.equal(focusedCount, 2, 'first click on non-benchmark focuses itself + benchmark');
    await page.locator('#btn-reset-focus').click();
    assert.equal(await page.locator('.stat-card.focused').count(), 0);

    // Tab 2: ETF calendar table (bond ETF shows 不適用台股基準)
    await page.locator('[data-tab="etf"]').click();
    await page.waitForSelector('#etf-table tbody tr');
    const etfText = await page.locator('#etf-table').textContent();
    assert.match(etfText, /不適用台股基準/);
    assert.match(etfText, /0050/);
    assert.match(etfText, /00679B/);

    // Tab 3: Status & Methodology
    await page.locator('[data-tab="status"]').click();
    const statusText = await page.locator('#status-body').textContent();
    assert.match(statusText, /tri_ex_close_gross_v1/);
    assert.match(statusText, /臺灣證券交易所/);

    // Dark theme + mobile 360px overflow check
    await page.locator('#theme-toggle').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.locator('[data-tab="trend"]').click();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(120);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `mobile 360px should not overflow horizontally (got ${overflow}px)`);

    assert.deepEqual(errors, [], `Unexpected browser errors: ${errors.join('; ')}`);
    console.log(JSON.stringify({ result: 'PASS', cardCount, pillCount, overflow, theme: 'dark' }));
  } finally {
    await browser.close();
    server.close();
  }
})();
