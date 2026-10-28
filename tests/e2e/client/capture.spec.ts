import { expect, test } from '../fixtures';

type CaptureTestState = { mode: 'allow' | 'denied'; unsupported: boolean; stopped: number; revoked: number };
const loginEmail = 'capture@example.test';
const loginPassword = 'capture-test-password';

async function enableCameraHarness(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const state: CaptureTestState = { mode: 'allow', unsupported: false, stopped: 0, revoked: 0 };
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
    HTMLVideoElement.prototype.play = () => Promise.resolve();
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 480 });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({ drawImage: () => undefined }),
    });
    HTMLCanvasElement.prototype.toBlob = function (callback, type) {
      callback(new Blob([new Uint8Array([255, 216, 255, 217])], { type: type ?? 'image/jpeg' }));
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => { state.revoked += 1; revoke(url); };
  });
}

async function signIn(page: import('@playwright/test').Page): Promise<void> {
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
  await page.goto('/');
  await page.getByRole('button', { name: 'Start a litter report' }).click();
  await page.getByLabel('Email', { exact: true }).fill(loginEmail);
  await page.getByLabel('Password', { exact: true }).fill(loginPassword);
  await page.locator('.auth-form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.report-button')).toBeVisible();
}

async function captureState(page: import('@playwright/test').Page): Promise<CaptureTestState> {
  return page.evaluate(() => (window as unknown as { __captureTestState: CaptureTestState }).__captureTestState);
}

test('captures at most five camera photos, supports retake and explicit discard without a draft', async ({ page }) => {
  await enableCameraHarness(page);
  await signIn(page);
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

  await dialog.getByRole('button', { name: 'Delete photo 5', exact: true }).click();
  await expect(dialog.locator('.photo-capture-count')).toHaveText('4 of 5 photos');
  await dialog.getByRole('button', { name: 'Retake photo 1' }).click();
  await expect(dialog.locator('.photo-capture-count')).toHaveText('3 of 5 photos');
  await expect(shutter).toBeEnabled();
  await shutter.click();
  await shutter.click();
  await expect(dialog.locator('.photo-capture-item')).toHaveCount(5);

  await dialog.getByRole('button', { name: 'Continue with photos' }).click();
  await expect(dialog).toContainText('Photos are held in memory only. Upload and analysis will be connected in a later step.');
  await expect.poll(async () => (await captureState(page)).stopped).toBe(1);

  await dialog.getByRole('button', { name: 'Delete photo 5', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete photo 4', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete photo 3', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete photo 2', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete photo 1', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Continue with photos' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Retry camera' }).click();
  await expect(dialog.locator('video')).toBeVisible();
  await dialog.getByRole('button', { name: 'Take photo', exact: true }).click();
  await expect(dialog.locator('.photo-capture-item')).toHaveCount(1);

  await dialog.locator('.photo-capture-close').click();
  const exitPrompt = page.getByRole('alertdialog', { name: 'Leave photo capture?' });
  await expect(exitPrompt).toBeVisible();
  await exitPrompt.getByRole('button', { name: 'Continue creating' }).click();
  await expect(dialog.locator('.photo-capture-item')).toHaveCount(1);

  await dialog.locator('.photo-capture-close').click();
  await page.getByRole('alertdialog', { name: 'Leave photo capture?' })
    .getByRole('button', { name: 'Discard and exit' }).click();
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
