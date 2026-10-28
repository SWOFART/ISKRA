import { expect, test } from '../fixtures';
import fixtures from '../../fixtures/contracts/p0.json' with { type: 'json' };

const mapStyle = {
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
const fixtureTile = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function stubMapTiler(page: import('@playwright/test').Page): Promise<void> {
  await page.route('https://api.maptiler.com/maps/streets-v4/style.json?key=local-map-fixture-key', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(mapStyle),
  }));
  await page.route((url) => url.hostname === 'api.maptiler.com'
    && url.pathname.startsWith('/maps/streets-v4/') && url.pathname.endsWith('.png'), (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: fixtureTile,
  }));
}

test('shows the Heilbronn report map, route filters and stage-aware status labels', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  const report = fixtures.publicReport;
  const summary = {
    id: report.id,
    route: report.route,
    status: report.status,
    location: report.location,
    coverPhotoId: report.coverPhotoId,
    description: report.description,
    existenceYesCount: report.existenceYesCount,
    resolutionYesCount: report.resolutionYesCount,
    existenceVerifiedAt: report.existenceVerifiedAt,
    lastExistenceConfirmedAt: report.lastExistenceConfirmedAt,
    version: report.version,
    updatedAt: report.updatedAt,
    isDemo: report.isDemo,
  };
  const requestUrls: string[] = [];
  await stubMapTiler(page);
  await page.route('**/api/reports**', async (route) => {
    requestUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [summary], nextCursor: null }),
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto('/map');
  const policy = response?.headers()['content-security-policy'] ?? '';
  expect(policy).toContain("connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://api.maptiler.com");
  expect(policy).toContain("worker-src 'self'");

  await expect(page.getByRole('region', { name: 'Report map overview centered on Heilbronn' })).toBeVisible();
  await expect(page.locator('.maplibregl-ctrl-attrib-inner')).toContainText('MapTiler');
  await expect(page.locator('.nav-tab')).toHaveCount(3);
  await expect(page.locator('.route-filter')).toHaveText(['Green', 'Yellow', 'Red']);
  await expect(page.locator('.map-marker')).toHaveCount(1);
  await expect(page.locator('.map-marker')).toHaveAttribute('aria-label', /Green route.*Cleanup awaiting verification/);
  await expect(page.locator('.report-list-item')).toContainText('Cleanup awaiting verification');
  await expect(page.locator('.report-list-item')).toContainText('3/3 threshold · 8 confirmations');
  await expect(page.locator('.report-list-item')).toBeVisible();

  const verificationFilter = page.getByRole('button', { name: 'Needs verification' });
  await verificationFilter.click();
  await expect(verificationFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.report-list-item')).toHaveCount(1);
  await expect.poll(() => requestUrls.length).toBe(2);
  const verificationQuery = new URL(requestUrls[1]).searchParams;
  expect(verificationQuery.get('needsVerification')).toBe('true');
  expect(verificationQuery.get('bbox')).toBeNull();

  await page.getByRole('button', { name: 'Green', exact: true }).click();
  await expect(page.locator('.route-filter[data-route="GREEN"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.report-list-empty')).toContainText('No reports match these filters.');
  await expect(page.locator('.map-marker')).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

test('reveals every report in a cluster, including reports at the same coordinates', async ({ page }) => {
  const report = fixtures.publicReport;
  const first = {
    id: report.id,
    route: report.route,
    status: report.status,
    location: report.location,
    coverPhotoId: report.coverPhotoId,
    description: 'Litter beside the path.',
    existenceYesCount: report.existenceYesCount,
    resolutionYesCount: report.resolutionYesCount,
    existenceVerifiedAt: report.existenceVerifiedAt,
    lastExistenceConfirmedAt: report.lastExistenceConfirmedAt,
    version: report.version,
    updatedAt: report.updatedAt,
    isDemo: report.isDemo,
  };
  const secondId = '33333333-3333-4333-8333-333333333333';
  const reports = [first, { ...first, id: secondId, description: 'Waste near the same entrance.' }];
  await stubMapTiler(page);
  await page.route('**/api/reports**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: reports, nextCursor: null }),
    });
  });
  await page.goto('/map');

  const cluster = page.locator('.map-marker--cluster');
  await expect(cluster).toHaveCount(1);
  await cluster.click();

  const clusterDetails = page.getByRole('region', { name: 'Reports in selected map group' });
  await expect(clusterDetails).toBeVisible();
  await expect(clusterDetails.locator('.map-cluster-report')).toHaveCount(2);
  await expect(clusterDetails).toContainText('Litter beside the path.');
  await expect(clusterDetails).toContainText('Waste near the same entrance.');
  await clusterDetails.locator('.map-cluster-report').nth(1).click();
  await expect(page.locator(`.report-list-item[data-report-id="${secondId}"]`))
    .toHaveAttribute('aria-pressed', 'true');
});

test('keeps the report list available and retries a failed map style request', async ({ page }) => {
  const report = fixtures.publicReport;
  const summary = {
    id: report.id,
    route: report.route,
    status: report.status,
    location: report.location,
    coverPhotoId: report.coverPhotoId,
    description: report.description,
    existenceYesCount: report.existenceYesCount,
    resolutionYesCount: report.resolutionYesCount,
    existenceVerifiedAt: report.existenceVerifiedAt,
    lastExistenceConfirmedAt: report.lastExistenceConfirmedAt,
    version: report.version,
    updatedAt: report.updatedAt,
    isDemo: report.isDemo,
  };
  const styleRequests: number[] = [];
  await page.route('https://api.maptiler.com/maps/streets-v4/style.json?key=local-map-fixture-key', (route) => {
    styleRequests.push(Date.now());
    if (styleRequests.length === 1) {
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(mapStyle),
    });
  });
  await page.route((url) => url.hostname === 'api.maptiler.com'
    && url.pathname.startsWith('/maps/streets-v4/') && url.pathname.endsWith('.png'), (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: fixtureTile,
  }));
  await page.route('**/api/reports**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [summary], nextCursor: null }),
  }));
  await page.goto('/map');

  await expect(page.locator('.map-tile-status')).toContainText('Map tiles could not be loaded.');
  await expect(page.locator('.report-list-item')).toBeVisible();
  await page.getByRole('button', { name: 'Retry loading map tiles' }).click();
  await expect(page.locator('.maplibregl-ctrl-attrib-inner')).toContainText('MapTiler');
  await expect(page.locator('.map-tile-status')).toBeHidden();
  await expect.poll(() => styleRequests.length).toBeGreaterThanOrEqual(2);
});
