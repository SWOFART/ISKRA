import { expect, test as base, type Page } from '@playwright/test';

const style = {
  version: 8,
  sources: {
    base: {
      type: 'raster',
      tiles: ['https://api.maptiler.com/maps/streets-v4/{z}/{x}/{y}.png?key=local-map-fixture-key'],
      tileSize: 256,
      attribution: '© MapTiler © OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'base', type: 'raster', source: 'base' }],
};
const tile = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function interceptMapTiler(page: Page): Promise<void> {
  await page.route('https://api.maptiler.com/maps/streets-v4/style.json?key=local-map-fixture-key', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(style),
  }));
  await page.route((url) => url.hostname === 'api.maptiler.com'
    && url.pathname.startsWith('/maps/streets-v4/') && url.pathname.endsWith('.png'), (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: tile,
  }));
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await interceptMapTiler(page);
    await use(page);
  },
});

export { expect };
