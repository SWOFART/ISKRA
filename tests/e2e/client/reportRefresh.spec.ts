import { expect, test } from '../fixtures';
import fixtures from '../../fixtures/contracts/p0.json' with { type: 'json' };
import { ViewerReportDetailSchema } from '../../../src/shared/contracts';

const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

type VoteReport = ReturnType<typeof ViewerReportDetailSchema.parse>;

function photos(stage: string, expiry: string) {
  return [{
    id: `50000000-0000-4000-8000-${String(stage === 'after' ? 101 : 1).padStart(12, '0')}`,
    ordinal: 1,
    mediaUrl: `https://api.maptiler.com/photos/${stage}-1.png`,
    expiresAt: expiry,
  }];
}

function makeReport(overrides: {
  status: VoteReport['status'];
  existenceYesCount: number;
  resolutionYesCount: number;
  existenceVerifiedAt: string | null;
  lastExistenceConfirmedAt: string | null;
  version: number;
  updatedAt: string;
}): VoteReport {
  const expiry = new Date(Date.now() + 60_000).toISOString();
  const beforePhotos = photos('before', expiry);
  const cleaned = overrides.status === 'AWAITING_RESOLUTION' || overrides.status === 'RESOLVED';
  const openVoteStages: VoteReport['openVoteStages'] = overrides.status === 'RESOLVED' ? []
    : overrides.status === 'AWAITING_RESOLUTION' ? ['EXISTENCE', 'RESOLUTION'] : ['EXISTENCE'];
  const openStage = { canVote: false, reason: 'UNAUTHENTICATED', hasVoted: false } as const;
  return ViewerReportDetailSchema.parse({
    ...fixtures.viewerReport,
    ...overrides,
    coverPhotoId: beforePhotos[0].id,
    beforePhotos,
    afterPhotos: cleaned ? photos('after', expiry) : [],
    cleaner: cleaned ? fixtures.viewerReport.cleaner : null,
    currentStage: overrides.status === 'RESOLVED' ? null
      : overrides.status === 'AWAITING_RESOLUTION' ? 'RESOLUTION' : 'EXISTENCE',
    openVoteStages,
    viewer: { stages: { EXISTENCE: openStage, RESOLUTION: openStage }, canSubmitCleanup: false },
  });
}

function summaryOf(report: VoteReport) {
  const {
    id, route, status, location, coverPhotoId, description, existenceYesCount,
    resolutionYesCount, existenceVerifiedAt, lastExistenceConfirmedAt, version, updatedAt, isDemo,
  } = report;
  return {
    id, route, status, location, coverPhotoId, description, existenceYesCount,
    resolutionYesCount, existenceVerifiedAt, lastExistenceConfirmedAt, version, updatedAt, isDemo,
  };
}

async function stubPhotoMedia(page: import('@playwright/test').Page): Promise<void> {
  await page.route((url) => url.hostname === 'api.maptiler.com' && url.pathname.startsWith('/photos/'), (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: imageBytes,
  }));
}

test('keeps committed verification when a delayed older report snapshot arrives', async ({ page }) => {
  test.setTimeout(60_000);
  const first = '2026-10-27T12:00:00.000Z';
  const second = '2026-10-27T12:05:00.000Z';
  const third = '2026-10-27T12:10:00.000Z';
  const committed = makeReport({
    status: 'VERIFIED', existenceYesCount: 8, resolutionYesCount: 0,
    existenceVerifiedAt: first, lastExistenceConfirmedAt: first, version: 13, updatedAt: first,
  });
  const delayed = makeReport({
    status: 'AWAITING_EXISTENCE', existenceYesCount: 2, resolutionYesCount: 0,
    existenceVerifiedAt: null, lastExistenceConfirmedAt: second, version: 12, updatedAt: second,
  });
  const newer = makeReport({
    status: 'AWAITING_RESOLUTION', existenceYesCount: 9, resolutionYesCount: 1,
    existenceVerifiedAt: first, lastExistenceConfirmedAt: third, version: 14, updatedAt: third,
  });
  const reportId = committed.id;
  const detailSnapshots = [committed, delayed, newer];
  let detailRequests = 0;

  await page.route((url) => url.pathname === '/api/reports', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [summaryOf(committed)], nextCursor: null }),
  }));
  await page.route((url) => url.pathname === `/api/reports/${reportId}`, (route) => {
    const snapshot = detailSnapshots[Math.min(detailRequests, detailSnapshots.length - 1)];
    detailRequests += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) });
  });
  await stubPhotoMedia(page);

  await page.goto('/map');
  await page.locator('.map-marker').click();
  const sheet = page.getByRole('dialog', { name: 'Report details' });
  await expect(sheet).toContainText('Confirmed — more residents can still support');
  await expect(sheet.locator('.report-stage-progress')).toContainText('3/3 threshold · 8 confirmations');

  await expect.poll(() => detailRequests, { timeout: 8_000 }).toBe(2);
  await expect(sheet).toContainText('Confirmed — more residents can still support');
  await expect(sheet.locator('.report-stage-progress')).toContainText('8 confirmations');
  await expect(page.locator(`.report-list-item[data-report-id="${reportId}"]`)).toContainText('Confirmed — more residents can still support');

  await expect.poll(() => detailRequests, { timeout: 8_000 }).toBe(3);
  await expect(sheet).toContainText('Cleanup awaiting verification');
  await expect(sheet.locator('.report-stage-progress')).toContainText('9 confirmations');
  await expect(sheet.locator('.report-stage-progress')).toContainText('Cleanup verification: 1/3');

  await page.getByRole('button', { name: 'Close report details' }).click();
  await expect(sheet).toBeHidden();
  await page.locator('.map-filter-button', { hasText: 'Needs verification' }).click();
  const listed = page.locator(`.report-list-item[data-report-id="${reportId}"]`);
  await expect(listed).toContainText('Cleanup awaiting verification');
  await expect(listed).toContainText('Cleanup verification: 1/3');
  await expect(listed).toContainText('9 confirmations');
});

test('pauses the open report refresh while the tab is hidden and refreshes on return', async ({ page }) => {
  test.setTimeout(60_000);
  const detail = makeReport({
    status: 'AWAITING_RESOLUTION', existenceYesCount: 8, resolutionYesCount: 2,
    existenceVerifiedAt: '2026-10-27T12:00:00.000Z', lastExistenceConfirmedAt: '2026-10-27T12:00:00.000Z',
    version: 12, updatedAt: '2026-10-27T12:00:00.000Z',
  });
  const reportId = detail.id;
  let detailRequests = 0;

  await page.route((url) => url.pathname === '/api/reports', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [summaryOf(detail)], nextCursor: null }),
  }));
  await page.route((url) => url.pathname === `/api/reports/${reportId}`, (route) => {
    detailRequests += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) });
  });
  await stubPhotoMedia(page);

  await page.goto('/map');
  await page.locator('.map-marker').click();
  await expect(page.getByRole('dialog', { name: 'Report details' })).toBeVisible();
  await expect.poll(() => detailRequests).toBe(1);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(5_500);
  expect(detailRequests).toBe(1);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => detailRequests).toBe(2);

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => detailRequests).toBe(3);
  await expect(page.getByRole('dialog', { name: 'Report details' })).toBeVisible();
});

test('preserves a loaded photo and focus across signed URL rotation, then opens the fresh URL', async ({ page }) => {
  test.setTimeout(60_000);
  const detail = makeReport({
    status: 'AWAITING_RESOLUTION', existenceYesCount: 8, resolutionYesCount: 2,
    existenceVerifiedAt: '2026-10-27T12:00:00.000Z', lastExistenceConfirmedAt: '2026-10-27T12:00:00.000Z',
    version: 12, updatedAt: '2026-10-27T12:00:00.000Z',
  });
  const reportId = detail.id;
  let detailRequests = 0;
  let photoRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/photos/')) photoRequests++;
  });

  await page.route((url) => url.pathname === '/api/reports', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [summaryOf(detail)], nextCursor: null }),
  }));
  await page.route((url) => url.pathname === `/api/reports/${reportId}`, (route) => {
    detailRequests += 1;
    const rotated = { ...detail, beforePhotos: detail.beforePhotos.map((photo) => ({
      ...photo, mediaUrl: photo.mediaUrl + '?ticket=' + detailRequests,
      expiresAt: new Date(Date.now() + 300_000 + detailRequests * 1000).toISOString(),
    })) };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rotated) });
  });
  await stubPhotoMedia(page);

  await page.goto('/map');
  await page.locator('.map-marker').click();
  const sheet = page.getByRole('dialog', { name: 'Report details' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'View photo 1 full screen' }).first().click();
  const lightbox = page.getByRole('dialog', { name: 'Before photos · 1 of 1' });
  await expect(lightbox).toBeVisible();

  const close = lightbox.getByRole('button', { name: 'Close full-screen photo' });
  await expect(close).toBeFocused();
  const image = lightbox.locator('img');
  await expect(image).toHaveJSProperty('complete', true);
  const initialRequests = photoRequests;
  await image.evaluate((element) => { element.dataset.preserved = 'true'; });
  await expect.poll(() => detailRequests, { timeout: 8_000 }).toBe(2);
  await expect(lightbox).toBeVisible();
  await expect(close).toBeFocused();
  await expect(image).toHaveAttribute('data-preserved', 'true');
  await expect(image).toHaveAttribute('src', /ticket=1$/);
  expect(photoRequests).toBe(initialRequests);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'View photo 1 full screen' }).first().click();
  await expect(lightbox).toBeVisible();
  await expect(image).toHaveAttribute('src', /ticket=2$/);
});

test('waits for cleanup evidence before adopting an advanced list status', async ({ page }) => {
  test.setTimeout(60_000);
  const verified = makeReport({
    status: 'VERIFIED', existenceYesCount: 8, resolutionYesCount: 0,
    existenceVerifiedAt: '2026-10-27T12:00:00.000Z', lastExistenceConfirmedAt: '2026-10-27T12:00:00.000Z',
    version: 13, updatedAt: '2026-10-27T12:00:00.000Z',
  });
  const cleaned = makeReport({
    status: 'AWAITING_RESOLUTION', existenceYesCount: 9, resolutionYesCount: 1,
    existenceVerifiedAt: '2026-10-27T12:00:00.000Z', lastExistenceConfirmedAt: '2026-10-27T12:05:00.000Z',
    version: 14, updatedAt: '2026-10-27T12:05:00.000Z',
  });
  const reportId = cleaned.id;
  const detailSnapshots = [verified, verified, cleaned];
  let detailRequests = 0;

  await page.route((url) => url.pathname === '/api/reports', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [summaryOf(cleaned)], nextCursor: null }),
  }));
  await page.route((url) => url.pathname === `/api/reports/${reportId}`, (route) => {
    const snapshot = detailSnapshots[Math.min(detailRequests, detailSnapshots.length - 1)];
    detailRequests += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) });
  });
  await stubPhotoMedia(page);

  await page.goto('/map');
  await expect(page.locator(`.report-list-item[data-report-id="${reportId}"]`)).toContainText('Cleanup awaiting verification');
  await page.locator('.map-marker').click();
  const sheet = page.getByRole('dialog', { name: 'Report details' });
  // The list is already ahead, but this payload has no cleanup evidence yet.
  await expect(sheet).toContainText('Confirmed — more residents can still support');
  await expect(sheet).toContainText('No photos are available.');
  await expect(page.locator(`.report-list-item[data-report-id="${reportId}"]`)).toContainText('Cleanup awaiting verification');
  await expect(sheet).toContainText('Confirmed — more residents can still support');

  await expect.poll(() => detailRequests, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
  await expect(sheet).toContainText('Confirmed — more residents can still support');

  await expect.poll(() => detailRequests, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  await expect(sheet).toContainText('Cleanup awaiting verification');
  await expect(sheet.locator('.report-stage-progress')).toContainText('Cleanup verification: 1/3');
});


test('focus and visibility signals honor Retry-After without extra report requests', async ({ page }) => {
  const detail = makeReport({ status: 'VERIFIED', existenceYesCount: 3, resolutionYesCount: 0,
    existenceVerifiedAt: '2026-10-27T12:00:00.000Z', lastExistenceConfirmedAt: '2026-10-27T12:00:00.000Z',
    version: 12, updatedAt: '2026-10-27T12:00:00.000Z' });
  let requests = 0;
  await page.route((url) => url.pathname === '/api/reports', (route) => route.fulfill({ json: { items: [summaryOf(detail)], nextCursor: null } }));
  await page.route((url) => url.pathname === `/api/reports/${detail.id}`, (route) => {
    requests++;
    return requests === 2
      ? route.fulfill({ status: 429, headers: { 'Retry-After': '20' }, json: { error: { code: 'RATE_LIMITED', message: 'Try later', requestId: '11111111-1111-4111-8111-111111111123', retryable: true } } })
      : route.fulfill({ json: detail });
  });
  await stubPhotoMedia(page);
  await page.goto('/map');
  await expect(page.locator('.map-marker')).toBeVisible();
  const clockStart = new Date();
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(new Date(clockStart.getTime() + 1_000));
  await page.locator('.map-marker').click();
  const sheet = page.getByRole('dialog', { name: 'Report details' });
  await expect(sheet).toContainText('Confirmed — more residents can still support');
  await page.clock.runFor(5_000);
  await expect.poll(() => requests).toBe(2);
  // Wait for the 429 to be parsed before delivering foreground signals.
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
  await page.waitForTimeout(100);
  expect(requests).toBe(2);
  await page.clock.runFor(19_000);
  expect(requests).toBe(2);
  await page.clock.runFor(1_000);
  await expect.poll(() => requests).toBe(3);
  await expect(sheet).toContainText('Confirmed — more residents can still support');
});

test('a slow initial detail request does not overlap foreground or timer refreshes', async ({ page }) => {
  const detail = makeReport({ status: 'VERIFIED', existenceYesCount: 3, resolutionYesCount: 0,
    existenceVerifiedAt: '2026-10-27T12:00:00.000Z', lastExistenceConfirmedAt: '2026-10-27T12:00:00.000Z',
    version: 12, updatedAt: '2026-10-27T12:00:00.000Z' });
  let requests = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === '/api/reports', (route) => route.fulfill({ json: { items: [summaryOf(detail)], nextCursor: null } }));
  await page.route((url) => url.pathname === `/api/reports/${detail.id}`, async (route) => {
    requests++;
    if (requests === 1) await gate;
    await route.fulfill({ json: detail });
  });
  await stubPhotoMedia(page);
  await page.goto('/map');
  await expect(page.locator('.map-marker')).toBeVisible();
  const clockStart = new Date();
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(new Date(clockStart.getTime() + 1_000));
  await page.locator('.map-marker').click();
  await expect.poll(() => requests).toBe(1);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(6_000);
  expect(requests).toBe(1);
  release();
  await expect(page.getByRole('dialog', { name: 'Report details' })).toContainText('Confirmed — more residents can still support');
  await page.clock.runFor(5_000);
  await expect.poll(() => requests).toBe(2);
});
