import { expect, test } from '../fixtures';
import fixtures from '../../fixtures/contracts/p0.json' with { type: 'json' };

const email = 'rewards-fixture@example.test';
const password = 'rewards-test-password';
const userId = 'rewards-fixture-user';
const rewardId = '33333333-3333-4333-8333-333333333333';
const voucherId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';

async function stubAuthenticatedClient(page: import('@playwright/test').Page): Promise<string> {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    sub: userId, user_id: userId, aud: 'iskra-browser-test',
    iss: 'https://securetoken.google.com/iskra-browser-test',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    firebase: { sign_in_provider: 'password' },
  })}.local-fixture-signature`;
  await page.route('https://identitytoolkit.googleapis.com/**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(route.request().url().includes('accounts:lookup')
      ? { users: [{ localId: userId, email, providerUserInfo: [] }] }
      : { localId: userId, email, idToken: token, refreshToken: 'rewards-fixture-refresh', expiresIn: '3600' }),
  }));
  await page.route('**/api/me/bootstrap', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ user: { id: userId, nickname: 'Rewards Tester', avatar: 'leaf' }, balance: 45, balanceVersion: 1 }),
  }));
  return token;
}

test('keeps every demo reward visible and reuses the same redemption key after an ambiguous failure', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const token = await stubAuthenticatedClient(page);
  const rewards = [
    { id: rewardId, title: 'Reusable bottle', description: 'A demo bottle item.', costRp: 20, isDemo: true, demoTerms: 'Demo terms only.' },
    { id: '66666666-6666-4666-8666-666666666666', title: 'City postcard', description: 'A demo postcard item.', costRp: 60, isDemo: true, demoTerms: 'Also demo terms only.' },
  ];
  const voucher = {
    id: voucherId, catalogId: rewardId, title: rewards[0].title, description: rewards[0].description,
    costRpSnapshot: 20, displayCode: `DEMO-${voucherId.toUpperCase()}`, status: 'RECEIVED',
    createdAt: '2026-10-29T10:00:00.000Z', isDemo: true, demoTerms: rewards[0].demoTerms,
  };
  let balance = 45;
  let impactReads = 0;
  let redemptionAttempts = 0;
  const redemptionHeaders: string[] = [];
  const redemptionBodies: unknown[] = [];

  await page.route('**/api/rewards/catalog', async (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: rewards }) });
  });
  await page.route('**/api/me/impact**', async (route) => {
    impactReads += 1;
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    if (impactReads === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: {
        code: 'UNAVAILABLE', message: 'Temporarily unavailable.', requestId, retryable: true,
      } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...fixtures.impact,
      totals: { ...fixtures.impact.totals, balanceRp: balance },
      balanceVersion: balance === 45 ? 1 : 2,
    }) });
  });
  await page.route('**/api/me/vouchers**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      items: balance === 45 ? [] : [voucher], nextCursor: null,
    }),
  }));
  await page.route('**/api/me/notifications**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], nextCursor: null }),
  }));
  await page.route('**/api/rewards/*/redeem', async (route) => {
    redemptionAttempts += 1;
    redemptionHeaders.push(route.request().headers()['idempotency-key'] ?? '');
    redemptionBodies.push(route.request().postDataJSON());
    if (redemptionAttempts === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: {
        code: 'UNAVAILABLE', message: 'Temporarily unavailable.',
        requestId, retryable: true,
      } }) });
      return;
    }
    balance = 25;
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
      voucher, balance, balanceVersion: 2, rpDebited: 20,
    }) });
  });

  await page.goto('/rewards');
  await page.locator('.deferred-card').getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.locator('.auth-form').getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Rewards' })).toBeVisible();
  await expect(page.locator('.rewards-card')).toHaveCount(2);
  await expect(page.locator('.rewards-balance-status')).toContainText('service could not be reached');
  await expect(page.locator('.rewards-progress').first()).toBeHidden();
  await page.locator('.rewards-balance-retry').click();
  await expect(page.locator('.rewards-balance-value')).toHaveText('45 RP');
  await expect(page.getByText('Remaining after purchase: 25 RP')).toBeVisible();
  const gridColumns = await page.locator('.rewards-catalog-grid').evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length);
  expect(gridColumns).toBe(2);
  await expect.poll(() => page.locator('.rewards-progress').nth(1).evaluate((element) => ({
    value: (element as HTMLProgressElement).value,
    max: (element as HTMLProgressElement).max,
  }))).toEqual({ value: 45, max: 60 });

  await page.locator('.rewards-card').first().getByRole('button', { name: 'Review demo reward' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm demo reward' });
  await expect(dialog).toContainText('Current: 45 RP');
  await expect(dialog).toContainText('Cost: 20 RP');
  await expect(dialog).toContainText('Remaining after purchase: 25 RP');
  await dialog.getByRole('button', { name: 'Confirm and spend RP' }).click();
  await expect(dialog.locator('.rewards-redemption-status')).toContainText('service could not be reached');
  await dialog.getByRole('button', { name: 'Confirm and spend RP' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText('Demo voucher received. 20 RP spent; 25 RP remain.')).toBeVisible();
  const receivedVoucher = page.locator('.rewards-voucher');
  await expect(receivedVoucher).toHaveCount(1);
  await expect(page.locator('.rewards-card')).toHaveCount(2);
  await expect(receivedVoucher).toContainText('Received · demo only');
  await expect(receivedVoucher).toContainText(`DEMO-${voucherId.toUpperCase()}`);
  await expect(receivedVoucher.locator('canvas, img, svg')).toHaveCount(0);
  await expect(receivedVoucher).not.toContainText(/expires|expiration|giltig bis/i);
  expect(redemptionHeaders[0]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(redemptionHeaders[1]).toBe(redemptionHeaders[0]);
  expect(redemptionBodies).toEqual([{ confirmedCostRp: 20 }, { confirmedCostRp: 20 }]);
});
