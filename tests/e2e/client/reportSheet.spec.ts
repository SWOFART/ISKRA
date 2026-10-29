import { expect, test } from '../fixtures';
import fixtures from '../../fixtures/contracts/p0.json' with { type: 'json' };
import { ViewerReportDetailSchema } from '../../../src/shared/contracts';

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

function summaryOf(report: ReturnType<typeof makeReportDetail> | VoteReport) {
  const {
    id, route, status, location, coverPhotoId, description, existenceYesCount,
    resolutionYesCount, existenceVerifiedAt, lastExistenceConfirmedAt, version, updatedAt, isDemo,
  } = report;
  return {
    id, route, status, location, coverPhotoId, description, existenceYesCount,
    resolutionYesCount, existenceVerifiedAt, lastExistenceConfirmedAt, version, updatedAt, isDemo,
  };
}

type VoteReport = ReturnType<typeof ViewerReportDetailSchema.parse>;

function makeVoteReport(): VoteReport {
  const expiry = new Date(Date.now() + 60_000).toISOString();
  const beforePhotos = photos('before', 1, expiry);
  const afterPhotos = photos('after', 1, expiry);
  return ViewerReportDetailSchema.parse({
    ...fixtures.viewerReport,
    coverPhotoId: beforePhotos[0].id,
    beforePhotos,
    afterPhotos,
  });
}

function applyVote(report: VoteReport, stage: 'EXISTENCE' | 'RESOLUTION', choice: 'YES' | 'NO'): VoteReport {
  const now = new Date(Date.now()).toISOString();
  const voted = { canVote: false, reason: 'ALREADY_VOTED', hasVoted: true } as const;
  return ViewerReportDetailSchema.parse({
    ...report,
    existenceYesCount: report.existenceYesCount + (stage === 'EXISTENCE' && choice === 'YES' ? 1 : 0),
    lastExistenceConfirmedAt: stage === 'EXISTENCE' && choice === 'YES' ? now : report.lastExistenceConfirmedAt,
    resolutionYesCount: report.resolutionYesCount + (stage === 'RESOLUTION' && choice === 'YES' ? 1 : 0),
    version: report.version + 1,
    updatedAt: now,
    viewer: {
      ...report.viewer,
      stages: {
        EXISTENCE: stage === 'EXISTENCE' ? voted : report.viewer.stages.EXISTENCE,
        RESOLUTION: stage === 'RESOLUTION' ? voted : report.viewer.stages.RESOLUTION,
      },
    },
  });
}

function voteReceipt(report: VoteReport, replayed: boolean, rpAwarded: 0 | 5, balanceVersion: number) {
  return {
    voteId: '11111111-1111-4111-8111-000000000005',
    replayed,
    rpAwarded,
    balance: 25,
    balanceVersion,
    report,
  };
}

async function signInForVoting(page: import('@playwright/test').Page): Promise<string> {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    sub: 'vote-fixture-user', user_id: 'vote-fixture-user', aud: 'iskra-browser-test',
    iss: 'https://securetoken.google.com/iskra-browser-test',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    firebase: { sign_in_provider: 'password' },
  })}.local-fixture-signature`;
  await page.route('https://identitytoolkit.googleapis.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(route.request().url().includes('accounts:lookup')
      ? { users: [{ localId: 'vote-fixture-user', email: 'vote@example.test', providerUserInfo: [] }] }
      : { localId: 'vote-fixture-user', email: 'vote@example.test', idToken: token,
        refreshToken: 'vote-fixture-refresh', expiresIn: '3600' }),
  }));
  await page.route('**/api/me/bootstrap', (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      user: { id: 'vote-fixture-user', nickname: 'Vote Tester', avatar: 'leaf' },
      balance: 0,
      balanceVersion: 0,
    }) });
  });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill('vote@example.test');
  await page.getByLabel('Password', { exact: true }).fill('vote-test-password');
  await page.locator('.auth-form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  return token;
}

async function stubVoteReportApi(
  page: import('@playwright/test').Page,
  getDetail: () => VoteReport,
): Promise<void> {
  const reportId = fixtures.viewerReport.id;
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

test('shows vote controls only for stages allowed by the viewer permissions', async ({ page }) => {
  const report = ViewerReportDetailSchema.parse({
    ...makeVoteReport(),
    viewer: {
      stages: {
        EXISTENCE: { canVote: false, reason: 'SELF_VOTE', hasVoted: false },
        RESOLUTION: { canVote: true, reason: null, hasVoted: false },
      },
      canSubmitCleanup: false,
    },
  });
  await stubVoteReportApi(page, () => report);
  await page.goto('/map');
  await page.locator('.map-marker').click();
  const sheet = page.getByRole('dialog', { name: 'Report details' });
  const existence = sheet.getByRole('region', { name: 'Existence verification' });
  const resolution = sheet.getByRole('region', { name: 'Cleanup verification' });
  await expect(existence).toContainText('You cannot vote on your own report at this stage.');
  await expect(existence.getByRole('button', { name: 'Yes', exact: true })).toHaveCount(0);
  await expect(resolution.getByRole('button', { name: 'Yes', exact: true })).toBeVisible();
  await expect(resolution.getByRole('button', { name: 'No', exact: true })).toBeVisible();
});

test('offers resolution first, records both stage choices and keeps post-threshold existence support visible', async ({ page }) => {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 49.14, longitude: 9.22, accuracy: 5 });
  let currentReport = makeVoteReport();
  const submitted: Array<{ stage: string; choice: string }> = [];
  const reportId = currentReport.id;
  await stubVoteReportApi(page, () => currentReport);
  await page.route((url) => url.pathname === `/api/reports/${reportId}/votes`, async (route) => {
    expect(route.request().headers().authorization).toBeTruthy();
    const body = route.request().postDataJSON() as { stage: string; choice: string };
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    submitted.push(body);
    currentReport = applyVote(currentReport, body.stage as 'EXISTENCE' | 'RESOLUTION', body.choice as 'YES' | 'NO');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      voteReceipt(currentReport, false, 5, submitted.length),
    ) });
  });

  await page.goto('/map');
  await signInForVoting(page);
  await page.locator('.map-marker').click();
  const sheet = page.getByRole('dialog', { name: 'Report details' });
  const stages = sheet.locator('.report-vote-stage');
  await expect(stages.locator('.report-vote-stage-heading')).toHaveText([
    'Cleanup verification', 'Existence verification',
  ]);

  await stages.nth(1).getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(sheet).toContainText('Vote accepted. 5 RP credited.');
  await expect(sheet.locator('.report-stage-progress')).toContainText('3/3 threshold · 9 confirmations');
  await expect(sheet.locator('.report-stage-progress')).toContainText('Latest confirmation:');
  await expect(sheet).toBeVisible();

  await stages.nth(0).getByRole('button', { name: 'No', exact: true }).click();
  await expect(sheet.locator('.report-stage-progress')).toContainText('Cleanup verification: 2/3');
  await expect(stages.nth(0)).toContainText('Vote accepted. 5 RP credited.');
  expect(submitted.map(({ stage, choice }) => ({ stage, choice }))).toEqual([
    { stage: 'EXISTENCE', choice: 'YES' },
    { stage: 'RESOLUTION', choice: 'NO' },
  ]);
  await expect(sheet).toBeVisible();
});

test('retries an ambiguous vote with the same body and key after its location fix becomes stale', async ({ page }) => {
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    Object.defineProperty(window, '__advanceClock', {
      configurable: true,
      value: (amount: number) => { offsetMs += amount; },
    });
    Date.now = () => realNow() + offsetMs;
  });
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 49.14, longitude: 9.22, accuracy: 5 });
  let currentReport = makeVoteReport();
  const reportId = currentReport.id;
  const requests: Array<{ body: unknown; key: string | undefined }> = [];
  await stubVoteReportApi(page, () => currentReport);
  await page.route((url) => url.pathname === `/api/reports/${reportId}/votes`, async (route) => {
    requests.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
    if (requests.length === 1) {
      currentReport = applyVote(currentReport, 'EXISTENCE', 'YES');
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
        error: {
          code: 'UNAVAILABLE', message: 'Temporary service failure.',
          requestId: '11111111-1111-4111-8111-000000000009', retryable: true,
        },
      }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      voteReceipt(currentReport, true, 0, 4),
    ) });
  });

  await page.goto('/map');
  const token = await signInForVoting(page);
  await page.locator('.map-marker').click();
  const sheet = page.getByRole('dialog', { name: 'Report details' });
  const existence = sheet.getByRole('region', { name: 'Existence verification' });
  await existence.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry this vote' })).toBeEnabled();

  await page.evaluate(() => (window as unknown as { __advanceClock: (amount: number) => void }).__advanceClock(61_000));
  await page.context().setGeolocation({ latitude: 49.25, longitude: 9.22, accuracy: 5 });
  await page.getByRole('button', { name: 'Retry this vote' }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].key).toBeTruthy();
  expect(requests[1].key).toBe(requests[0].key);
  expect(token).toBeTruthy();
  const originalLocation = (requests[0].body as { location: { observedAt: string } }).location;
  expect(await page.evaluate((observedAt) => Date.parse(observedAt) < Date.now() - 60_000,
    originalLocation.observedAt)).toBe(true);
  await expect(existence).toContainText('This vote was already recorded. No additional RP was credited.');
  await expect(sheet.locator('.report-stage-progress')).toContainText('3/3 threshold · 9 confirmations');
  await expect(sheet).toBeVisible();
});
