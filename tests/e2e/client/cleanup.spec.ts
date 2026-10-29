import { expect, test } from '../fixtures';
import fixtures from '../../fixtures/contracts/p0.json' with { type: 'json' };
import { CleanupReceiptSchema, ViewerReportDetailSchema } from '../../../src/shared/contracts';

const reportId = fixtures.viewerReport.id;
const analysisId = '11111111-1111-4111-8111-111111111143';
const cleanupId = '11111111-1111-4111-8111-111111111144';

function verifiedReport() {
  const source = fixtures.viewerReport;
  const expiry = new Date(Date.now() + 60_000).toISOString();
  const before = {
    ...source.beforePhotos[0],
    ordinal: 1,
    mediaUrl: 'https://api.maptiler.com/photos/before-1.png',
    expiresAt: expiry,
  };
  return ViewerReportDetailSchema.parse({
    ...source,
    status: 'VERIFIED',
    resolutionYesCount: 0,
    coverPhotoId: before.id,
    beforePhotos: [before],
    afterPhotos: [],
    cleaner: null,
    currentStage: 'EXISTENCE',
    openVoteStages: ['EXISTENCE'],
    viewer: {
      stages: {
        EXISTENCE: { canVote: false, reason: 'SELF_VOTE', hasVoted: false },
        RESOLUTION: { canVote: false, reason: 'STAGE_CLOSED', hasVoted: false },
      },
      canSubmitCleanup: true,
    },
  });
}

function submittedReport(photoId: string, source: ReturnType<typeof verifiedReport>) {
  const expiry = new Date(Date.now() + 60_000).toISOString();
  return ViewerReportDetailSchema.parse({
    ...source,
    status: 'AWAITING_RESOLUTION',
    resolutionYesCount: 0,
    afterPhotos: [{
      id: photoId,
      ordinal: 1,
      mediaUrl: 'https://api.maptiler.com/photos/after-1.png',
      expiresAt: expiry,
    }],
    cleaner: { id: 'cleanup-fixture-user', nickname: 'Cleanup Tester', avatar: 'leaf' },
    currentStage: 'RESOLUTION',
    openVoteStages: ['EXISTENCE', 'RESOLUTION'],
    version: source.version + 1,
    updatedAt: new Date().toISOString(),
    viewer: {
      stages: {
        EXISTENCE: { canVote: false, reason: 'SELF_VOTE', hasVoted: false },
        RESOLUTION: { canVote: true, reason: null, hasVoted: false },
      },
      canSubmitCleanup: false,
    },
  });
}

async function enableCameraHarness(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const state = {
      locationRequests: 0,
      locationOptions: null as { enableHighAccuracy?: boolean; maximumAge?: number } | null,
    };
    Object.defineProperty(window, '__cleanupTestState', { configurable: true, value: state });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      get: () => ({
        async getUserMedia() {
          const stream = new MediaStream();
          Object.defineProperty(stream, 'getTracks', { value: () => [{ stop() {} }] });
          return stream;
        },
      }),
    });
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success: PositionCallback, _error: PositionErrorCallback, options?: PositionOptions) {
          state.locationRequests += 1;
          state.locationOptions = options ? {
            enableHighAccuracy: options.enableHighAccuracy,
            maximumAge: options.maximumAge,
          } : null;
          success({
            coords: {
              latitude: 49.14, longitude: 9.22, accuracy: 12, altitude: null,
              altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}),
            },
            timestamp: Date.now(),
            toJSON: () => ({}),
          });
        },
      },
    });
    HTMLVideoElement.prototype.play = () => Promise.resolve();
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 480 });
    const nativeGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value(this: HTMLCanvasElement, contextId: string, ...args: unknown[]) {
        if (contextId === '2d') return { drawImage: () => undefined };
        return Reflect.apply(nativeGetContext, this, [contextId, ...args]);
      },
    });
    HTMLCanvasElement.prototype.toBlob = function (callback, type) {
      callback(new Blob([new Uint8Array([255, 216, 255, 217])], { type: type ?? 'image/jpeg' }));
    };
  });
}

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    sub: 'cleanup-fixture-user', user_id: 'cleanup-fixture-user', aud: 'iskra-browser-test',
    iss: 'https://securetoken.google.com/iskra-browser-test',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    firebase: { sign_in_provider: 'password' },
  })}.local-fixture-signature`;
  await page.route('https://identitytoolkit.googleapis.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(route.request().url().includes('accounts:lookup')
      ? { users: [{ localId: 'cleanup-fixture-user', email: 'cleanup@example.test', providerUserInfo: [] }] }
      : { localId: 'cleanup-fixture-user', email: 'cleanup@example.test', idToken: token,
        refreshToken: 'cleanup-fixture-refresh', expiresIn: '3600' }),
  }));
  await page.route('**/api/me/bootstrap', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      user: { id: 'cleanup-fixture-user', nickname: 'Cleanup Tester', avatar: 'leaf' },
      balance: 0,
      balanceVersion: 0,
    }),
  }));
  await page.route('**/api/me/notifications*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [], nextCursor: null }),
  }));
  await page.route('**/api/me/impact*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(fixtures.impact),
  }));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill('cleanup@example.test');
  await page.getByLabel('Password', { exact: true }).fill('cleanup-test-password');
  await page.locator('.auth-form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}

async function openCleanup(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.map-marker').click();
  const sheet = page.getByRole('dialog', { name: 'Report details' });
  await expect(sheet).toContainText('Three other residents verify this cleanup');
  await sheet.getByRole('button', { name: 'I cleaned this up' }).click();
  const camera = page.getByRole('dialog', { name: 'Capture cleanup photos' });
  await camera.getByRole('button', { name: 'Take photo', exact: true }).click();
  await camera.getByRole('button', { name: 'Continue with photos' }).click();
}

test('submits an accepted cleanup without reserving it and shows pending credit', async ({ page }) => {
  const report = verifiedReport();
  let uploadPosts = 0;
  let photoId = '';
  await enableCameraHarness(page);
  await page.route((url) => url.pathname === '/api/reports', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{
      id: report.id, route: report.route, status: report.status, location: report.location,
      coverPhotoId: report.coverPhotoId, description: report.description,
      existenceYesCount: report.existenceYesCount, resolutionYesCount: report.resolutionYesCount,
      existenceVerifiedAt: report.existenceVerifiedAt, lastExistenceConfirmedAt: report.lastExistenceConfirmedAt,
      version: report.version, updatedAt: report.updatedAt, isDemo: report.isDemo,
    }], nextCursor: null }),
  }));
  await page.route((url) => url.pathname === `/api/reports/${reportId}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(report) });
  });
  await page.route('**/api/uploads', async (route) => {
    const body = route.request().postDataJSON() as { purpose: string; reportId: string; ordinal: number };
    expect(body.purpose).toBe('CLEANUP');
    expect(body.reportId).toBe(reportId);
    expect(body.ordinal).toBe(1);
    uploadPosts += 1;
    photoId = '11111111-1111-4111-8111-111111111145';
    return route.fulfill({
      status: 201, contentType: 'application/json',
      body: JSON.stringify({
        photoId,
        uploadUrl: `https://app.example.test/api/uploads/${photoId}/content?ticket=signed-cleanup`,
        expiresAt: '2030-01-01T00:00:00.000Z',
        maxBytes: 1_048_576,
      }),
    });
  });
  await page.route('**/api/uploads/*/content?*', (route) => route.fulfill({
    status: 201, contentType: 'application/json',
    body: JSON.stringify({ photoId, state: 'UPLOADED' }),
  }));
  await page.route('**/api/ai/analyze-cleanup', async (route) => {
    const body = route.request().postDataJSON() as { photoIds: string[]; outputLocale: string; location: { lat: number } };
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    expect(body.outputLocale).toBe('en');
    expect(body.photoIds).toEqual([photoId]);
    expect(body.location.lat).toBeCloseTo(49.14);
    return route.fulfill({
      status: 202, contentType: 'application/json',
      body: JSON.stringify({
        analysisId, status: 'READY', expiresAt: '2030-01-01T00:00:00.000Z',
        result: {
          decision: 'ACCEPT', sameScene: 'LIKELY', appearsClean: true, hazardRemaining: false,
          reason: 'The same scene appears clean.', confidence: 0.8,
        },
      }),
    });
  });
  await page.route((url) => url.pathname === `/api/reports/${reportId}/cleanups`, (route) => {
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    const receipt = CleanupReceiptSchema.parse({
      cleanupId, status: 'AWAITING_VERIFICATION', provisionalRp: 40,
      report: submittedReport(photoId, report),
    });
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(receipt) });
  });

  await page.goto('/map');
  await signIn(page);
  const locationBefore = await page.evaluate(() => (
    window as unknown as { __cleanupTestState: { locationRequests: number } }
  ).__cleanupTestState.locationRequests);
  expect(locationBefore).toBe(0);
  await openCleanup(page);
  expect(uploadPosts).toBe(0);
  const dialog = page.getByRole('dialog', { name: 'Photos ready for the next step' });
  await expect(dialog).toContainText('Opening the camera does not reserve the cleanup');
  await expect(dialog).toContainText('including when you reported it yourself');
  await dialog.getByRole('button', { name: 'Get fresh location' }).click();
  await expect(dialog).toContainText('Fresh location captured');
  const location = await page.evaluate(() => (
    window as unknown as { __cleanupTestState: { locationOptions: { maximumAge?: number; enableHighAccuracy?: boolean } | null } }
  ).__cleanupTestState.locationOptions);
  expect(location?.maximumAge).toBe(0);
  expect(location?.enableHighAccuracy).toBe(true);
  await dialog.getByRole('button', { name: 'Upload and assess photos' }).click();
  await expect(dialog).toContainText('40 RP is pending, not credited');
  await expect(dialog).toContainText('Verification starts at 0 of 3');
  await dialog.getByRole('button', { name: 'Send cleanup for verification' }).click();
  await expect(dialog).toContainText('Thank you. 40 RP is pending and has not been credited. Verification is 0 of 3.');
  await dialog.getByRole('button', { name: 'Open My Impact' }).click();
  await expect(page.getByRole('heading', { name: 'Your impact', exact: true })).toBeVisible();
  expect(uploadPosts).toBe(1);
});

test('keeps a litter retake on the camera path and does not submit it', async ({ page }) => {
  const report = verifiedReport();
  let cleanupPosts = 0;
  await enableCameraHarness(page);
  await page.route((url) => url.pathname === '/api/reports', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{
      id: report.id, route: report.route, status: report.status, location: report.location,
      coverPhotoId: report.coverPhotoId, description: report.description,
      existenceYesCount: report.existenceYesCount, resolutionYesCount: report.resolutionYesCount,
      existenceVerifiedAt: report.existenceVerifiedAt, lastExistenceConfirmedAt: report.lastExistenceConfirmedAt,
      version: report.version, updatedAt: report.updatedAt, isDemo: report.isDemo,
    }], nextCursor: null }),
  }));
  await page.route((url) => url.pathname === `/api/reports/${reportId}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(report),
  }));
  await page.route('**/api/uploads', (route) => route.fulfill({
    status: 201, contentType: 'application/json',
    body: JSON.stringify({
      photoId: '11111111-1111-4111-8111-111111111146',
      uploadUrl: 'https://app.example.test/api/uploads/11111111-1111-4111-8111-111111111146/content?ticket=signed-retake',
      expiresAt: '2030-01-01T00:00:00.000Z',
      maxBytes: 1_048_576,
    }),
  }));
  await page.route('**/api/uploads/*/content?*', (route) => route.fulfill({
    status: 201, contentType: 'application/json',
    body: JSON.stringify({ photoId: '11111111-1111-4111-8111-111111111146', state: 'UPLOADED' }),
  }));
  await page.route('**/api/ai/analyze-cleanup', (route) => route.fulfill({
    status: 202, contentType: 'application/json',
    body: JSON.stringify({
      analysisId, status: 'READY', expiresAt: '2030-01-01T00:00:00.000Z',
      result: {
        decision: 'RETAKE', reasonCode: 'LITTER_REMAINING',
        reason: 'Litter is still visible.', instruction: 'Photograph the remaining litter more closely.',
      },
    }),
  }));
  await page.route((url) => url.pathname === `/api/reports/${reportId}/cleanups`, (route) => {
    cleanupPosts += 1;
    return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/map');
  await signIn(page);
  await openCleanup(page);
  const dialog = page.getByRole('dialog', { name: 'Photos ready for the next step' });
  await dialog.getByRole('button', { name: 'Get fresh location' }).click();
  await dialog.getByRole('button', { name: 'Upload and assess photos' }).click();
  await expect(dialog).toContainText('Litter is still visible.');
  await expect(dialog).toContainText('Photograph the remaining litter more closely.');
  await expect(dialog).toContainText('This cleanup was not submitted.');
  await expect(dialog.getByRole('button', { name: 'Send cleanup for verification' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Retake photos' }).click();
  await expect(page.getByRole('dialog', { name: 'Capture cleanup photos' })).toBeVisible();
  expect(cleanupPosts).toBe(0);
});

test('shows the cleanup conflict loser without credit', async ({ page }) => {
  const report = verifiedReport();
  const photoId = '11111111-1111-4111-8111-111111111147';
  await enableCameraHarness(page);
  await page.route((url) => url.pathname === '/api/reports', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{
      id: report.id, route: report.route, status: report.status, location: report.location,
      coverPhotoId: report.coverPhotoId, description: report.description,
      existenceYesCount: report.existenceYesCount, resolutionYesCount: report.resolutionYesCount,
      existenceVerifiedAt: report.existenceVerifiedAt, lastExistenceConfirmedAt: report.lastExistenceConfirmedAt,
      version: report.version, updatedAt: report.updatedAt, isDemo: report.isDemo,
    }], nextCursor: null }),
  }));
  await page.route((url) => url.pathname === `/api/reports/${reportId}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(report),
  }));
  await page.route('**/api/uploads', (route) => route.fulfill({
    status: 201, contentType: 'application/json',
    body: JSON.stringify({
      photoId,
      uploadUrl: `https://app.example.test/api/uploads/${photoId}/content?ticket=signed-loser`,
      expiresAt: '2030-01-01T00:00:00.000Z',
      maxBytes: 1_048_576,
    }),
  }));
  await page.route('**/api/uploads/*/content?*', (route) => route.fulfill({
    status: 201, contentType: 'application/json',
    body: JSON.stringify({ photoId, state: 'UPLOADED' }),
  }));
  await page.route('**/api/ai/analyze-cleanup', (route) => route.fulfill({
    status: 202, contentType: 'application/json',
    body: JSON.stringify({
      analysisId, status: 'READY', expiresAt: '2030-01-01T00:00:00.000Z',
      result: {
        decision: 'ACCEPT', sameScene: 'LIKELY', appearsClean: true, hazardRemaining: false,
        reason: 'The same scene appears clean.', confidence: 0.8,
      },
    }),
  }));
  await page.route((url) => url.pathname === `/api/reports/${reportId}/cleanups`, (route) => route.fulfill({
    status: 409, contentType: 'application/json',
    body: JSON.stringify({
      error: {
        code: 'CLEANUP_ALREADY_SUBMITTED',
        message: 'Another cleanup was already submitted.',
        requestId: '11111111-1111-4111-8111-111111111148',
        retryable: false,
      },
    }),
  }));
  await page.goto('/map');
  await signIn(page);
  await openCleanup(page);
  const dialog = page.getByRole('dialog', { name: 'Photos ready for the next step' });
  await dialog.getByRole('button', { name: 'Get fresh location' }).click();
  await dialog.getByRole('button', { name: 'Upload and assess photos' }).click();
  await dialog.getByRole('button', { name: 'Send cleanup for verification' }).click();
  await expect(dialog).toContainText('Someone else already submitted this cleanup. Nothing was credited.');
  await expect(dialog).not.toContainText('Thank you');
});
