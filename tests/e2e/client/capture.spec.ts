import { expect, test } from '../fixtures';
import fixtures from '../../fixtures/contracts/p0.json' with { type: 'json' };

type CaptureTestState = {
  mode: 'allow' | 'denied';
  unsupported: boolean;
  stopped: number;
  revoked: number;
  locationRequests: number;
  locationMode: 'allow' | 'denied';
  locationOptions: { enableHighAccuracy?: boolean; maximumAge?: number; timeout?: number } | null;
};
const loginEmail = 'capture@example.test';
const loginPassword = 'capture-test-password';

async function enableCameraHarness(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const state: CaptureTestState = {
      mode: 'allow', unsupported: false, stopped: 0, revoked: 0,
      locationRequests: 0, locationMode: 'allow', locationOptions: null,
    };
    const mediaDevices = {
      async getUserMedia() {
        if (state.mode === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
        const stream = new MediaStream();
        Object.defineProperty(stream, 'getTracks', {
          value: () => [{ stop: () => { state.stopped += 1; } }],
        });
        return stream;
      },
    };
    Object.defineProperty(window, '__captureTestState', { configurable: true, value: state });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      get: () => state.unsupported ? undefined : mediaDevices,
    });
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success: PositionCallback, error: PositionErrorCallback, options?: PositionOptions) {
          state.locationRequests += 1;
          state.locationOptions = options ? {
            enableHighAccuracy: options.enableHighAccuracy,
            maximumAge: options.maximumAge,
            timeout: options.timeout,
          } : null;
          if (state.locationMode === 'denied') {
            error({ code: 1, message: 'Permission denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
            return;
          }
          const timestamp = Date.now();
          success({
            coords: {
              latitude: 49.14, longitude: 9.22, accuracy: 12, altitude: null,
              altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}),
            },
            timestamp,
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
      value: function (this: HTMLCanvasElement, contextId: string, ...args: unknown[]) {
        if (contextId === '2d') return { drawImage: () => undefined };
        return Reflect.apply(nativeGetContext, this, [contextId, ...args]);
      },
    });
    HTMLCanvasElement.prototype.toBlob = function (callback, type) {
      callback(new Blob([new Uint8Array([255, 216, 255, 217])], { type: type ?? 'image/jpeg' }));
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => { state.revoked += 1; revoke(url); };
  });
}

type ReportApiScenario = 'accept-running' | 'retake' | 'retry-analysis'
  | 'retry-after-upload' | 'retry-after-photo-content' | 'retry-after-analysis' | 'retry-after-publication';

async function signIn(
  page: import('@playwright/test').Page,
  locale: 'en' | 'de' = 'en',
  beforeMap?: (token: string) => Promise<void>,
): Promise<void> {
  if (locale === 'de') await page.addInitScript(() => localStorage.setItem('iskra.locale', 'de'));
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    sub: 'capture-fixture-user', user_id: 'capture-fixture-user', aud: 'iskra-browser-test',
    iss: 'https://securetoken.google.com/iskra-browser-test',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    firebase: { sign_in_provider: 'password' },
  })}.local-fixture-signature`;
  await page.route('https://identitytoolkit.googleapis.com/**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(route.request().url().includes('accounts:lookup')
      ? { users: [{ localId: 'capture-fixture-user', email: loginEmail, providerUserInfo: [] }] }
      : { localId: 'capture-fixture-user', email: loginEmail, idToken: token,
        refreshToken: 'capture-fixture-refresh', expiresIn: '3600' }),
  }));
  await page.route('**/api/me/bootstrap', (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'capture-fixture-user', nickname: 'Camera Tester', avatar: 'leaf' },
        balance: 0,
        balanceVersion: 0,
      }),
    });
  });
  await page.route('**/api/me/impact*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(fixtures.impact),
  }));
  await page.goto('/impact');
  const signInLabel = locale === 'de' ? 'Anmelden' : 'Sign in';
  await page.locator('.deferred-card').getByRole('button', { name: signInLabel, exact: true }).click();
  await page.getByLabel(locale === 'de' ? 'E-Mail' : 'Email', { exact: true }).fill(loginEmail);
  await page.getByLabel(locale === 'de' ? 'Passwort' : 'Password', { exact: true }).fill(loginPassword);
  await page.locator('.auth-form').getByRole('button', { name: signInLabel, exact: true }).click();
  await expect(page.getByRole('heading', { name: locale === 'de' ? 'Dein Einfluss' : 'Your impact', exact: true })).toBeVisible();
  await beforeMap?.(token);
  await page.getByRole('tab', { name: locale === 'de' ? 'Karte' : 'Map', exact: true }).click();
  await expect(page.locator('.report-button')).toBeVisible();
}

async function installReportApi(
  page: import('@playwright/test').Page,
  token: string,
  scenario: ReportApiScenario,
  locale: 'en' | 'de' = scenario === 'retake' ? 'de' : 'en',
) {
  const photoIds: string[] = [];
  const analysisRequests: { body: Record<string, unknown>; operationKey: string | undefined }[] = [];
  let uploadRequests = 0;
  let photoUploadRequests = 0;
  let publicationRequest: Record<string, unknown> | null = null;
  let publicationRequests = 0;
  const publicationOperationKeys: (string | undefined)[] = [];
  let analysisPolls = 0;
  const response = (
    route: import('@playwright/test').Route,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => route.fulfill({
    status,
    contentType: 'application/json',
    headers,
    body: JSON.stringify(body),
  });
  const rateLimitResponse = (route: import('@playwright/test').Route) => response(route, 429, {
    error: {
      code: 'RATE_LIMITED',
      message: 'Please wait before trying again.',
      requestId: '11111111-1111-4111-8111-111111111123',
      retryable: true,
    },
  }, { 'Retry-After': '1' });
  const acceptedResult = locale === 'de' ? {
    decision: 'ACCEPT', route: 'RED', description: 'Scharfe Glasscherben am Bordstein.',
    hazardLevel: 'URGENT', safetyMessage: 'Berühren Sie das scharfe Material nicht und halten Sie andere fern.',
    reason: 'Das Foto zeigt sichtbaren Müll mit einer möglichen scharfen Gefahr.', confidence: 0.91,
  } : {
    decision: 'ACCEPT', route: 'RED', description: 'Hazardous litter near the curb.',
    hazardLevel: 'URGENT', safetyMessage: 'Avoid touching the sharp material and keep others away.',
    reason: 'The photo shows visible litter with a possible sharp hazard.', confidence: 0.91,
  };
  const checkAuth = (route: import('@playwright/test').Route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
  };

  await page.route('**/api/reports*', async (route) => {
    checkAuth(route);
    if (route.request().method() === 'GET') return response(route, 200, { items: [], nextCursor: null });
    publicationRequest = route.request().postDataJSON() as Record<string, unknown>;
    publicationRequests += 1;
    publicationOperationKeys.push(route.request().headers()['idempotency-key']);
    if (scenario === 'retry-after-publication' && publicationRequests === 1) return rateLimitResponse(route);
    const reportId = '11111111-1111-4111-8111-111111111121';
    const description = String(publicationRequest.description);
    const report = {
      id: reportId,
      route: 'RED',
      status: 'AWAITING_EXISTENCE',
      location: { lat: 49.14, lng: 9.22 },
      coverPhotoId: photoIds[0],
      description,
      existenceYesCount: 0,
      resolutionYesCount: 0,
      existenceVerifiedAt: null,
      lastExistenceConfirmedAt: null,
      version: 1,
      updatedAt: '2026-10-28T12:00:00.000Z',
      isDemo: false,
      beforePhotos: photoIds.map((id, index) => ({
        id,
        ordinal: index + 1,
        mediaUrl: `https://media.example.test/${id}?token=temporary`,
        expiresAt: '2030-01-01T00:00:00.000Z',
      })),
      afterPhotos: [],
      author: { id: 'capture-fixture-user', nickname: 'Camera Tester', avatar: 'leaf' },
      cleaner: null,
      currentStage: 'EXISTENCE',
      openVoteStages: ['EXISTENCE'],
      viewer: {
        stages: {
          EXISTENCE: { canVote: false, reason: 'SELF_VOTE', hasVoted: false },
          RESOLUTION: { canVote: false, reason: 'STAGE_CLOSED', hasVoted: false },
        },
        canSubmitCleanup: false,
      },
    };
    return response(route, 201, { report, rpAwarded: 5, balance: 5, balanceVersion: 1 });
  });
  await page.route('**/api/uploads', async (route) => {
    checkAuth(route);
    const request = route.request().postDataJSON() as { purpose: string; byteSize: number; ordinal: number };
    expect(request.purpose).toBe('REPORT');
    expect(request.byteSize).toBeGreaterThan(0);
    uploadRequests += 1;
    if (scenario === 'retry-after-upload' && uploadRequests === 1) return rateLimitResponse(route);
    const photoId = `11111111-1111-4111-8111-1111111111${String(uploadRequests + 10).padStart(2, '0')}`;
    photoIds.push(photoId);
    return response(route, 201, {
      photoId,
      uploadUrl: `https://app.example.test/api/uploads/${photoId}/content?ticket=signed-${uploadRequests}`,
      expiresAt: '2030-01-01T00:00:00.000Z',
      maxBytes: 1_048_576,
    });
  });
  await page.route('**/api/uploads/*/content?*', async (route) => {
    checkAuth(route);
    expect(route.request().method()).toBe('PUT');
    expect(route.request().headers()['content-type']).toBe('image/jpeg');
    expect(route.request().postDataBuffer()?.byteLength).toBeGreaterThan(0);
    photoUploadRequests += 1;
    if (scenario === 'retry-after-photo-content' && photoUploadRequests === 1) return rateLimitResponse(route);
    const photoId = new URL(route.request().url()).pathname.split('/')[3];
    return response(route, 201, { photoId, state: 'UPLOADED' });
  });
  await page.route('**/api/ai/analyze-report', async (route) => {
    checkAuth(route);
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body.outputLocale).toBe(locale);
    expect(Array.isArray(body.photoIds)).toBe(true);
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    analysisRequests.push({ body, operationKey: route.request().headers()['idempotency-key'] });
    const analysisId = '11111111-1111-4111-8111-111111111122';
    if (scenario === 'retry-after-analysis' && analysisRequests.length === 1) return rateLimitResponse(route);
    if (scenario === 'retry-analysis' && analysisRequests.length === 1) {
      return response(route, 202, {
        analysisId,
        status: 'FAILED',
        error: {
          code: 'AI_TIMEOUT',
          message: 'Analysis timed out. Retry with the same photos.',
          requestId: '11111111-1111-4111-8111-111111111123',
          retryable: true,
        },
      });
    }
    if (scenario === 'retake') {
      return response(route, 202, {
        analysisId,
        status: 'READY',
        result: {
          decision: 'RETAKE', reasonCode: 'INSUFFICIENT_EVIDENCE',
          reason: 'Das Motiv ist unscharf.', instruction: 'Nehmen Sie eine klare Nahaufnahme auf.',
        },
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
    }
    if (scenario === 'accept-running' && analysisRequests.length === 1) {
      return response(route, 202, { analysisId, status: 'RUNNING' });
    }
    return response(route, 202, {
      analysisId,
      status: 'READY',
      result: acceptedResult,
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });
  await page.route('**/api/ai/analyses/*', async (route) => {
    checkAuth(route);
    analysisPolls += 1;
    return response(route, 200, {
      analysisId: '11111111-1111-4111-8111-111111111122',
      status: 'READY',
      result: acceptedResult,
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });
  return {
    photoIds,
    analysisRequests,
    get uploadRequests() { return uploadRequests; },
    get photoUploadRequests() { return photoUploadRequests; },
    get publicationRequest() { return publicationRequest; },
    get publicationRequests() { return publicationRequests; },
    publicationOperationKeys,
    get analysisPolls() { return analysisPolls; },
  };
}

async function submitOneReportPhoto(page: import('@playwright/test').Page, locale: 'en' | 'de') {
  await page.locator('.report-button').click();
  const camera = page.getByRole('dialog', { name: locale === 'de' ? 'Fotos für Meldung aufnehmen' : 'Capture report photos' });
  await camera.getByRole('button', { name: locale === 'de' ? 'Foto aufnehmen' : 'Take photo', exact: true }).click();
  await camera.getByRole('button', { name: locale === 'de' ? 'Mit Fotos fortfahren' : 'Continue with photos' }).click();
  const dialog = page.getByRole('dialog', { name: locale === 'de' ? 'Fotos bereit für den nächsten Schritt' : 'Photos ready for the next step' });
  await dialog.getByRole('button', { name: locale === 'de' ? 'Frischen Standort abrufen' : 'Get fresh location' }).click();
  await expect(dialog).toContainText(locale === 'de' ? 'Frischer Standort erfasst' : 'Fresh location captured');
  await dialog.getByRole('button', { name: locale === 'de' ? 'Fotos hochladen und prüfen' : 'Upload and assess photos' }).click();
  return dialog;
}

async function captureState(page: import('@playwright/test').Page): Promise<CaptureTestState> {
  return page.evaluate(() => (window as unknown as { __captureTestState: CaptureTestState }).__captureTestState);
}

test('captures at most five camera photos, supports retake and explicit discard without a draft', async ({ page }) => {
  await enableCameraHarness(page);
  await signIn(page);
  expect((await captureState(page)).locationRequests).toBe(0);
  await page.locator('.report-button').click();

  const dialog = page.getByRole('dialog', { name: 'Capture report photos' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Continue with photos' })).toBeDisabled();
  await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.locator('.app-header')).toHaveJSProperty('inert', true);
  await expect(page.locator('.bottom-nav')).toHaveJSProperty('inert', true);
  await expect(dialog.locator('video')).toBeVisible();

  const shutter = dialog.getByRole('button', { name: 'Take photo', exact: true });
  for (let index = 0; index < 5; index += 1) {
    await shutter.click();
    if (index === 0) await expect(dialog.getByRole('button', { name: 'Continue with photos' })).toBeEnabled();
  }
  await expect(dialog.locator('.photo-capture-count')).toHaveText('5 of 5 photos');
  await expect(dialog.locator('.photo-capture-item')).toHaveCount(5);
  await expect(dialog.locator('.photo-capture-shutter')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Continue with photos' })).toBeEnabled();
  expect((await captureState(page)).locationRequests).toBe(0);

  await dialog.getByRole('button', { name: 'Delete photo 5', exact: true }).click();
  await expect(dialog.locator('.photo-capture-count')).toHaveText('4 of 5 photos');
  await dialog.getByRole('button', { name: 'Retake photo 1' }).click();
  await expect(dialog.locator('.photo-capture-count')).toHaveText('3 of 5 photos');
  await expect(shutter).toBeEnabled();
  await shutter.click();
  await shutter.click();
  await expect(dialog.locator('.photo-capture-item')).toHaveCount(5);

  await dialog.getByRole('button', { name: 'Continue with photos' }).click();
  const handoff = page.getByRole('dialog', { name: 'Photos ready for the next step' });
  await expect(dialog).toBeHidden();
  await expect(handoff).toBeVisible();
  await expect(handoff).toContainText('5 photos are ready. Get a fresh location, then submit them for assessment.');
  await expect(handoff.locator('.photo-capture-preview')).toHaveCount(5);
  expect((await captureState(page)).locationRequests).toBe(0);
  await expect.poll(async () => (await captureState(page)).stopped).toBe(1);

  await page.evaluate(() => {
    (window as unknown as { __captureTestState: CaptureTestState }).__captureTestState.locationMode = 'denied';
  });
  await handoff.getByRole('button', { name: 'Get fresh location' }).click();
  await expect(handoff).toContainText('Location access was blocked.');
  expect((await captureState(page)).locationRequests).toBe(1);
  await page.evaluate(() => {
    (window as unknown as { __captureTestState: CaptureTestState }).__captureTestState.locationMode = 'allow';
  });
  await handoff.getByRole('button', { name: 'Try location again' }).click();
  await expect(handoff).toContainText('Fresh location captured (±12 m).');
  const firstLocationState = await captureState(page);
  expect(firstLocationState.locationRequests).toBe(2);
  expect(firstLocationState.locationOptions).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });

  await handoff.getByRole('button', { name: 'Edit photos' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('video')).toBeVisible();
  await expect(dialog.locator('.photo-capture-item')).toHaveCount(5);
  await dialog.getByRole('button', { name: 'Delete photo 5', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete photo 4', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete photo 3', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete photo 2', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete photo 1', exact: true }).click();
  await expect(dialog.locator('.photo-capture-count')).toHaveText('0 of 5 photos');
  await expect(dialog.getByRole('button', { name: 'Continue with photos' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Take photo', exact: true }).click();
  await expect(dialog.locator('.photo-capture-item')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Continue with photos' }).click();
  await expect(handoff).toBeVisible();
  await expect(handoff.locator('.photo-capture-preview')).toHaveCount(1);
  expect((await captureState(page)).locationRequests).toBe(2);
  await handoff.getByRole('button', { name: 'Get fresh location' }).click();
  await expect(handoff).toContainText('Fresh location captured (±12 m).');
  expect((await captureState(page)).locationRequests).toBe(3);
  await expect.poll(async () => (await captureState(page)).stopped).toBe(2);

  await handoff.getByRole('button', { name: 'Discard photos and exit' }).click();
  await expect(handoff).toBeHidden();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.app-header')).toHaveJSProperty('inert', false);
  await expect(page.locator('.bottom-nav')).toHaveJSProperty('inert', false);

  await page.locator('.report-button').click();
  const reopened = page.getByRole('dialog', { name: 'Capture report photos' });
  await expect(reopened).toBeVisible();
  await expect(reopened.locator('.photo-capture-count')).toHaveText('0 of 5 photos');
  await reopened.locator('.photo-capture-close').click();
  await page.getByRole('alertdialog', { name: 'Leave photo capture?' })
    .getByRole('button', { name: 'Discard and exit' }).click();
  const state = await captureState(page);
  expect(state.stopped).toBe(3);
  expect(state.revoked).toBeGreaterThanOrEqual(5);
});

test('explains denied and unsupported camera access and permits retry without a file picker', async ({ page }) => {
  await enableCameraHarness(page);
  await signIn(page);
  await page.evaluate(() => {
    (window as unknown as { __captureTestState: CaptureTestState }).__captureTestState.mode = 'denied';
  });
  await page.locator('.report-button').click();

  const dialog = page.getByRole('dialog', { name: 'Capture report photos' });
  await expect(dialog).toContainText('Camera access was blocked.');
  await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
  await page.evaluate(() => {
    const state = (window as unknown as { __captureTestState: CaptureTestState }).__captureTestState;
    state.unsupported = true;
  });
  await dialog.getByRole('button', { name: 'Retry camera' }).click();
  await expect(dialog).toContainText('Camera is unavailable in this browser or page.');

  await page.evaluate(() => {
    const state = (window as unknown as { __captureTestState: CaptureTestState }).__captureTestState;
    state.unsupported = false;
    state.mode = 'allow';
  });
  await dialog.getByRole('button', { name: 'Retry camera' }).click();
  await expect(dialog.locator('video')).toBeVisible();
  await dialog.locator('.photo-capture-close').click();
  await page.getByRole('alertdialog', { name: 'Leave photo capture?' })
    .getByRole('button', { name: 'Discard and exit' }).click();
});

test('uploads, analyzes, previews and publishes an urgent RED report without opening the report sheet', async ({ page }) => {
  await enableCameraHarness(page);
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  let apiState: Awaited<ReturnType<typeof installReportApi>> | undefined;
  await signIn(page, 'en', async (token) => { apiState = await installReportApi(page, token, 'accept-running'); });
  const dialog = await submitOneReportPhoto(page, 'en');
  await expect(dialog.locator('.report-assessment-reason')).toContainText('The photo shows visible litter with a possible sharp hazard.');
  await expect(dialog.locator('.report-route-value')).toHaveText('Red');
  await expect(dialog.locator('.report-route-value')).toBeVisible();
  await expect(dialog.locator('.report-safety-guidance')).toHaveText('Avoid touching the sharp material and keep others away.');
  await expect(dialog.locator('.report-analysis-status')).not.toContainText(/\d+%/);
  const description = dialog.getByLabel('Factual description');
  await expect(description).toHaveValue('Hazardous litter near the curb.');
  await description.fill('Sharp broken glass beside the curb.');
  await dialog.getByRole('button', { name: 'Publish report' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.map-notice')).toContainText('5 RP credited now; 15 RP pending after verification (20 RP total).');
  await expect(page.locator('.report-sheet')).toBeHidden();
  const marker = page.locator('.map-marker--highlighted');
  await expect(marker).toBeVisible();
  await expect(marker).toHaveAttribute('aria-label', /Newly published report\. Red route/);
  const markerCenter = await marker.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const map = element.closest('.map-viewport')!.getBoundingClientRect();
    return { x: box.x + box.width / 2 - map.x, y: box.y + box.height / 2 - map.y, width: map.width, height: map.height };
  });
  expect(markerCenter.x).toBeGreaterThan(markerCenter.width * 0.35);
  expect(markerCenter.x).toBeLessThan(markerCenter.width * 0.65);
  expect(markerCenter.y).toBeGreaterThan(markerCenter.height * 0.3);
  expect(markerCenter.y).toBeLessThan(markerCenter.height * 0.7);
  expect(apiState?.uploadRequests).toBe(1);
  expect(apiState?.analysisRequests).toHaveLength(1);
  expect(apiState?.analysisPolls).toBe(1);
  expect(apiState?.publicationRequest).toEqual({
    analysisId: '11111111-1111-4111-8111-111111111122',
    description: 'Sharp broken glass beside the curb.',
  });
  expect((await captureState(page)).stopped).toBe(1);
  expect(browserErrors).toEqual([]);
});

test('shows localized RETAKE guidance without a route or publication', async ({ page }) => {
  await enableCameraHarness(page);
  let apiState: Awaited<ReturnType<typeof installReportApi>> | undefined;
  await signIn(page, 'de', async (token) => { apiState = await installReportApi(page, token, 'retake'); });
  const dialog = await submitOneReportPhoto(page, 'de');
  await expect(dialog.locator('.report-analysis-status')).toContainText('Neue Fotos sind erforderlich.');
  await expect(dialog.locator('.report-retake-guidance')).toContainText('Nehmen Sie eine klare Nahaufnahme auf.');
  await expect(dialog.locator('.report-route-value')).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Meldung veröffentlichen' })).toBeHidden();
  expect(apiState?.publicationRequest).toBeNull();
});

test('publishes an accepted report with German preview and reward copy', async ({ page }) => {
  await enableCameraHarness(page);
  let apiState: Awaited<ReturnType<typeof installReportApi>> | undefined;
  await signIn(page, 'de', async (token) => { apiState = await installReportApi(page, token, 'accept-running', 'de'); });
  const dialog = await submitOneReportPhoto(page, 'de');
  await expect(dialog.locator('.report-assessment-reason')).toContainText('Das Foto zeigt sichtbaren Müll mit einer möglichen scharfen Gefahr.');
  await expect(dialog.locator('.report-route-value')).toHaveText('Rot');
  await expect(dialog.locator('.report-safety-guidance'))
    .toHaveText('Berühren Sie das scharfe Material nicht und halten Sie andere fern.');
  const description = dialog.getByLabel('Sachliche Beschreibung');
  await expect(description).toHaveValue('Scharfe Glasscherben am Bordstein.');
  await description.fill('Scharfe Glasscherben neben dem Bordstein.');
  await dialog.getByRole('button', { name: 'Meldung veröffentlichen' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.map-notice'))
    .toContainText('Veröffentlicht. Jetzt 5 RP gutgeschrieben; 15 RP nach der Prüfung ausstehend (20 RP insgesamt).');
  const marker = page.locator('.map-marker--highlighted');
  await expect(marker).toHaveAttribute('aria-label', /Neue Meldung veröffentlicht\. Route Rot/);
  expect(apiState?.publicationRequest).toEqual({
    analysisId: '11111111-1111-4111-8111-111111111122',
    description: 'Scharfe Glasscherben neben dem Bordstein.',
  });
});

test('retries a technical analysis failure with the retained uploaded photo and a fresh operation key', async ({ page }) => {
  await enableCameraHarness(page);
  let apiState: Awaited<ReturnType<typeof installReportApi>> | undefined;
  await signIn(page, 'en', async (token) => { apiState = await installReportApi(page, token, 'retry-analysis'); });
  const dialog = await submitOneReportPhoto(page, 'en');
  await expect(dialog.locator('.report-analysis-status')).toContainText('The photo assessment took too long. Your photos are retained; try again.');
  await dialog.getByRole('button', { name: 'Retry assessment with these photos' }).click();
  await expect(dialog.locator('.report-safety-guidance')).toHaveText('Avoid touching the sharp material and keep others away.');
  expect(apiState?.uploadRequests).toBe(1);
  expect(apiState?.analysisRequests).toHaveLength(2);
  expect(apiState?.analysisRequests[1].body.photoIds).toEqual(apiState?.analysisRequests[0].body.photoIds);
  expect(apiState?.analysisRequests[1].operationKey).not.toBe(apiState?.analysisRequests[0].operationKey);
});

test('honors Retry-After before retrying a failed photo upload', async ({ page }) => {
  await enableCameraHarness(page);
  let apiState: Awaited<ReturnType<typeof installReportApi>> | undefined;
  await signIn(page, 'en', async (token) => { apiState = await installReportApi(page, token, 'retry-after-upload'); });
  const dialog = await submitOneReportPhoto(page, 'en');
  const retryButton = dialog.getByRole('button', { name: 'Retry photo upload' });
  await expect(dialog.locator('.report-analysis-status')).toHaveText('Please wait before retrying.');
  await expect(retryButton).toBeDisabled();
  await retryButton.dispatchEvent('click');
  expect(apiState?.uploadRequests).toBe(1);
  await expect(retryButton).toBeEnabled();
  await retryButton.click();
  await expect(dialog.locator('.report-safety-guidance'))
    .toHaveText('Avoid touching the sharp material and keep others away.');
  expect(apiState?.uploadRequests).toBe(2);
});

test('honors Retry-After before retrying a failed JPEG upload', async ({ page }) => {
  await enableCameraHarness(page);
  let apiState: Awaited<ReturnType<typeof installReportApi>> | undefined;
  await signIn(page, 'en', async (token) => { apiState = await installReportApi(page, token, 'retry-after-photo-content'); });
  const dialog = await submitOneReportPhoto(page, 'en');
  const retryButton = dialog.getByRole('button', { name: 'Retry photo upload' });
  await expect(dialog.locator('.report-analysis-status')).toHaveText('Please wait before retrying.');
  await expect(retryButton).toBeDisabled();
  await retryButton.dispatchEvent('click');
  expect(apiState?.uploadRequests).toBe(1);
  expect(apiState?.photoUploadRequests).toBe(1);
  await expect(retryButton).toBeEnabled();
  await retryButton.click();
  await expect(dialog.locator('.report-safety-guidance'))
    .toHaveText('Avoid touching the sharp material and keep others away.');
  expect(apiState?.uploadRequests).toBe(1);
  expect(apiState?.photoUploadRequests).toBe(2);
});

test('honors Retry-After before retrying a failed analysis', async ({ page }) => {
  await enableCameraHarness(page);
  let apiState: Awaited<ReturnType<typeof installReportApi>> | undefined;
  await signIn(page, 'en', async (token) => { apiState = await installReportApi(page, token, 'retry-after-analysis'); });
  const dialog = await submitOneReportPhoto(page, 'en');
  const retryButton = dialog.getByRole('button', { name: 'Retry assessment with these photos' });
  const analyzeButton = dialog.getByRole('button', { name: 'Upload and assess photos' });
  const locationButton = dialog.getByRole('button', { name: 'Refresh location' });
  await expect(dialog.locator('.report-analysis-status')).toHaveText('Please wait before retrying.');
  await expect(retryButton).toBeDisabled();
  await expect(analyzeButton).toBeDisabled();
  await expect(locationButton).toBeDisabled();
  await retryButton.dispatchEvent('click');
  await analyzeButton.dispatchEvent('click');
  expect(apiState?.analysisRequests).toHaveLength(1);
  await expect(retryButton).toBeEnabled();
  await expect(locationButton).toBeEnabled();
  await locationButton.click();
  await expect(dialog.locator('.photo-capture-location-status')).toContainText('Fresh location captured');
  await retryButton.click();
  await expect(dialog.locator('.report-safety-guidance'))
    .toHaveText('Avoid touching the sharp material and keep others away.');
  expect(apiState?.analysisRequests).toHaveLength(2);
  expect(apiState?.analysisRequests[1].operationKey).not.toBe(apiState?.analysisRequests[0].operationKey);
});

test('honors Retry-After before retrying publication', async ({ page }) => {
  await enableCameraHarness(page);
  let apiState: Awaited<ReturnType<typeof installReportApi>> | undefined;
  await signIn(page, 'en', async (token) => { apiState = await installReportApi(page, token, 'retry-after-publication'); });
  const dialog = await submitOneReportPhoto(page, 'en');
  const description = dialog.getByLabel('Factual description');
  await description.fill('Sharp broken glass beside the curb.');
  const retryButton = dialog.getByRole('button', { name: 'Retry publication' });
  await dialog.getByRole('button', { name: 'Publish report' }).click();
  await expect(dialog.locator('.report-analysis-status')).toHaveText('Please wait before retrying.');
  await expect(retryButton).toBeDisabled();
  await description.fill('Updated sharp glass location beside the curb.');
  await retryButton.dispatchEvent('click');
  expect(apiState?.publicationRequests).toBe(1);
  await expect(retryButton).toBeEnabled();
  await retryButton.click();
  await expect(dialog).toBeHidden();
  expect(apiState?.publicationRequests).toBe(2);
  expect(apiState?.publicationOperationKeys[1]).not.toBe(apiState?.publicationOperationKeys[0]);
  expect(apiState?.publicationRequest).toMatchObject({
    description: 'Updated sharp glass location beside the curb.',
  });
});
