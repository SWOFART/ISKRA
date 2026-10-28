import { expect, test } from '@playwright/test';

test('email sign-in failure and cancellation keep guest browsing usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('https://identitytoolkit.googleapis.com/**', (route) => route.fulfill({
    status: 400, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS' } }),
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start a litter report' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to ISKRA' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await page.getByLabel('Email', { exact: true }).fill('resident@example.test');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.locator('.auth-form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Sign-in could not be completed' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('INVALID_LOGIN_CREDENTIALS');
  await page.getByRole('button', { name: 'Back to browsing' }).click();
  await expect(page.getByRole('button', { name: 'Start a litter report' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Map', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('the German auth form fits mobile and can be reached with the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/impact');
  await page.getByRole('button', { name: 'Deutsch', exact: true }).click();
  await page.locator('.deferred-card').getByRole('button', { name: 'Anmelden', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Willkommen bei ISKRA' })).toBeFocused();
  await expect(page.getByLabel('E-Mail', { exact: true })).toBeEnabled();
  await page.getByLabel('E-Mail', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Passwort', { exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('provider success still reports unavailable account setup and allows a retry', async ({ page }) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    sub: 'local-fixture-user', user_id: 'local-fixture-user', aud: 'iskra-browser-test',
    iss: 'https://securetoken.google.com/iskra-browser-test',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    firebase: { sign_in_provider: 'password' },
  })}.local-fixture-signature`;
  await page.route('https://identitytoolkit.googleapis.com/**', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(route.request().url().includes('accounts:lookup')
      ? { users: [{ localId: 'local-fixture-user', email: 'resident@example.test', providerUserInfo: [] }] }
      : { localId: 'local-fixture-user', email: 'resident@example.test', idToken: token,
        refreshToken: 'local-fixture-refresh', expiresIn: '3600' }),
  }));
  let bootstraps = 0;
  await page.route('**/api/me/bootstrap', (route) => {
    bootstraps += 1;
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: {
      code: 'UNAVAILABLE', message: 'Account setup unavailable.', retryable: true,
      requestId: '11111111-1111-4111-8111-111111111111',
    } }) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start a litter report' }).click();
  await expect(page.getByLabel('Email', { exact: true })).toBeEnabled();
  await page.getByLabel('Email', { exact: true }).fill('resident@example.test');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.locator('.auth-form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.auth-status')).toContainText('Account setup');
  await expect(page.getByRole('button', { name: 'Retry account setup' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry account setup' }).click();
  await expect.poll(() => bootstraps).toBe(2);
  await expect(page.getByRole('heading', { name: 'Welcome to ISKRA' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to browsing' }).click();
  await expect(page.getByRole('button', { name: 'Start a litter report' })).toBeVisible();
});
