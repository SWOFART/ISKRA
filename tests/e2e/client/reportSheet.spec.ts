import { expect, test } from '../fixtures';
import fixtures from '../../fixtures/contracts/p0.json' with { type: 'json' };

const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function photos(stage: string, count: number, expiry: string) {
  return Array.from({ length: count }, (_, index) => ({
    id: `50000000-0000-4000-8000-${String(stage === 'after' ? index + 101 : index + 1).padStart(12, '0')}`,
    ordinal: index + 1,
    mediaUrl: `https://api.maptiler.com/photos/${stage}-${index + 1}.png`,
    expiresAt: expiry,
  }));
}

function makeReportDetail(beforePhotos = photos('before', 1, new Date(Date.now() + 60_000).toISOString()),
  afterPhotos = photos('after', 1, new Date(Date.now() + 60_000).toISOString())) {
  return { ...fixtures.publicReport, coverPhotoId: beforePhotos[0].id, beforePhotos, afterPhotos };
}

function summaryOf(report: ReturnType<typeof makeReportDetail>) {
  const {
    id, route, status, location, coverPhotoId, description, existenceYesCount,
    resolutionYesCount, existenceVerifiedAt, lastExistenceConfirmedAt, version, updatedAt, isDemo,
  } = report;
  return {
    id, route, status, location, coverPhotoId, description, existenceYesCount,
    resolutionYesCount, existenceVerifiedAt, lastExistenceConfirmedAt, version, updatedAt, isDemo,
  };
}

async function stubReportApi(
  page: import('@playwright/test').Page,
  getDetail: () => ReturnType<typeof makeReportDetail>,
): Promise<void> {
  const reportId = fixtures.publicReport.id;
  await page.route((url) => url.pathname === '/api/reports', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [summaryOf(getDetail())], nextCursor: null }),
  }));
  await page.route((url) => url.pathname === `/api/reports/${reportId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(getDetail()),
  }));
  await page.route((url) => url.hostname === 'api.maptiler.com' && url.pathname.startsWith('/photos/'), (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: imageBytes,
  }));
}

test('opens the report sheet with stage labels and supports keyboard, touch and focus-safe close/expand', async ({ page }) => {
  const detail = makeReportDetail();
  await stubReportApi(page, () => detail);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/map');

  await page.locator('.map-marker').click();
  const sheet = page.getByRole('dialog', { name: 'Report details' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('data-state', 'partial');
  await expect(sheet).toContainText('Cleanup awaiting verification');
  await expect(sheet).toContainText('Existence: 3/3 threshold');
  await expect(sheet).toContainText('Cleanup verification: 2/3');
  await expect(page.getByRole('button', { name: 'Close report details' })).toBeFocused();
  await expect(page.locator('.app-header')).toHaveJSProperty('inert', true);
  await expect(page.locator('.bottom-nav')).toHaveJSProperty('inert', true);

  const lastSheetButton = page.locator('.photo-gallery-open').last();
  await lastSheetButton.focus();
  await page.keyboard.press('Tab');
  await expect(sheet.getByRole('button', { name: 'English' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(sheet.getByRole('button', { name: 'Deutsch' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Expand report details' })).toBeFocused();

  await page.getByRole('button', { name: 'Expand report details' }).press('Enter');
  await expect(sheet).toHaveAttribute('data-state', 'full');
  await page.getByRole('button', { name: 'Return to two-thirds view' }).click();
  await expect(sheet).toHaveAttribute('data-state', 'partial');

  const handle = page.locator('.report-sheet-handle');
  await handle.dispatchEvent('pointerdown', { pointerType: 'touch', clientY: 500 });
  await handle.dispatchEvent('pointerup', { pointerType: 'touch', clientY: 400 });
  await expect(sheet).toHaveAttribute('data-state', 'full');

  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(page.locator('.app-header')).toHaveJSProperty('inert', false);
  await expect(page.locator('.bottom-nav')).toHaveJSProperty('inert', false);
  await expect(page.locator(`.report-list-item[data-report-id="${detail.id}"]`)).toBeFocused();

  await page.locator(`.report-list-item[data-report-id="${detail.id}"]`).click();
  const closeHandle = page.locator('.report-sheet-handle');
  await closeHandle.dispatchEvent('pointerdown', { pointerType: 'touch', clientY: 400 });
  await closeHandle.dispatchEvent('pointerup', { pointerType: 'touch', clientY: 500 });
  await expect(sheet).toBeHidden();
});

test('keeps the selected report open and its authored description unchanged when switching locale', async ({ page }) => {
  const detail = makeReportDetail();
  await stubReportApi(page, () => detail);
  await page.goto('/map');
  await page.locator('.map-marker').click();

  const sheet = page.getByRole('dialog', { name: 'Report details' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Cleanup verification: 2/3');
  const authoredDescription = await sheet.locator('.report-detail-description').innerText();

  await sheet.getByRole('button', { name: 'Deutsch' }).click();

  const germanSheet = page.getByRole('dialog', { name: 'Meldungsdetails' });
  await expect(germanSheet).toBeVisible();
  await expect(germanSheet).toContainText('Reinigungsprüfung: 2/3');
  await expect(germanSheet.locator('.report-detail-description')).toHaveText(authoredDescription);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
});

test('keeps one- and five-photo galleries independent with swipe and full-screen navigation', async ({ page }) => {
  const expiry = new Date(Date.now() + 60_000).toISOString();
  const detail = makeReportDetail(photos('before', 5, expiry), photos('after', 1, expiry));
  await stubReportApi(page, () => detail);
  await page.goto('/map');
  await page.locator('.map-marker').click();

  const galleries = page.locator('.photo-gallery');
  const before = galleries.nth(0);
  const after = galleries.nth(1);
  await expect(before).toContainText('5 photos');
  await expect(after).toContainText('1 photo');
  await expect(after.locator('.photo-gallery-next')).toBeHidden();
  await expect(before.locator('.photo-gallery-position')).toHaveText('1 of 5');

  const beforeViewport = before.locator('.photo-gallery-viewport');
  await beforeViewport.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 300, clientY: 40 });
  await beforeViewport.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 210, clientY: 40 });
  await expect(before.locator('.photo-gallery-position')).toHaveText('2 of 5');
  await expect(after.locator('.photo-gallery-position')).toHaveText('1 of 1');

  await before.getByRole('button', { name: 'View photo 2 full screen' }).click();
  const lightbox = page.getByRole('dialog', { name: 'Before photos · 2 of 5' });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator('img')).toHaveAttribute('alt', 'Before photos · 2 of 5');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog', { name: 'Before photos · 3 of 5' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Report details' })).toBeVisible();
  await expect(before.getByRole('button', { name: 'View photo 3 full screen' })).toBeFocused();
});

test('refreshes an expired report-photo capability from the report detail endpoint', async ({ page }) => {
  const oldDetail = makeReportDetail(photos('before', 1, '2020-01-01T00:00:00.000Z'));
  const freshDetail = makeReportDetail(photos('fresh', 1, new Date(Date.now() + 60_000).toISOString()));
  const reportId = fixtures.publicReport.id;
  let detailRequests = 0;

  await page.route((url) => url.pathname === '/api/reports', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [summaryOf(oldDetail)], nextCursor: null }),
  }));
  await page.route((url) => url.pathname === `/api/reports/${reportId}`, (route) => {
    detailRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(detailRequests === 1 ? oldDetail : freshDetail),
    });
  });
  await page.route((url) => url.hostname === 'api.maptiler.com' && url.pathname.startsWith('/photos/'), (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: imageBytes,
  }));
  await page.goto('/map');
  await page.locator('.map-marker').click();

  const before = page.locator('.photo-gallery').nth(0);
  await expect.poll(() => detailRequests).toBe(2);
  await expect(before.locator('.photo-gallery-image')).toHaveAttribute('src', /photos\/fresh-1\.png/);
  await expect(before.locator('.photo-gallery-image')).toBeVisible();
});
