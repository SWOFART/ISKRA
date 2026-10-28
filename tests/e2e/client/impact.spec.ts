import { expect, test } from '../fixtures';
import fixtures from '../../fixtures/contracts/p0.json' with { type: 'json' };

const email = 'impact-fixture@example.test';
const password = 'impact-test-password';

function makeReportSummaries() {
  return Array.from({ length: 12 }, (_, index) => {
    const id = `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const updatedAt = new Date(Date.UTC(2026, 9, 16 + index)).toISOString();
    return {
      id,
      route: 'GREEN',
      status: 'AWAITING_RESOLUTION',
      location: { lat: 49.14, lng: 9.22 },
      coverPhotoId: fixtures.publicReport.coverPhotoId,
      description: `Fixture report ${index + 1}: litter remains near the path.`,
      existenceYesCount: 8,
      resolutionYesCount: 2,
      existenceVerifiedAt: '2026-10-16T12:00:00.000Z',
      lastExistenceConfirmedAt: updatedAt,
      version: index + 1,
      updatedAt,
      isDemo: true,
    };
  });
}

async function stubAuthenticatedClient(page: import('@playwright/test').Page): Promise<string> {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    sub: 'impact-fixture-user', user_id: 'impact-fixture-user', aud: 'iskra-browser-test',
    iss: 'https://securetoken.google.com/iskra-browser-test',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    firebase: { sign_in_provider: 'password' },
  })}.local-fixture-signature`;
  await page.route('https://identitytoolkit.googleapis.com/**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(route.request().url().includes('accounts:lookup')
      ? { users: [{ localId: 'impact-fixture-user', email, providerUserInfo: [] }] }
      : { localId: 'impact-fixture-user', email, idToken: token,
        refreshToken: 'impact-fixture-refresh', expiresIn: '3600' }),
  }));
  await page.route('**/api/me/bootstrap', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      user: { id: 'impact-fixture-user', nickname: 'Impact Tester', avatar: 'leaf' },
      balance: 0,
      balanceVersion: 0,
    }),
  }));
  return token;
}

test('shows role-specific Impact, opens a report map sheet and restores history position', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const token = await stubAuthenticatedClient(page);
  const reports = makeReportSummaries();
  const impact = {
    ...fixtures.impact,
    items: reports.map((report, index) => ({
      report,
      roles: ['REPORTER', 'CLEANER', 'VERIFIER'],
      lastUpdatedAt: new Date(Date.UTC(2026, 9, 16 + index)).toISOString(),
    })),
    nextCursor: null,
  };
  await page.route('**/api/me/impact**', async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(impact) });
  });
  await page.route('**/api/reports**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/reports')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        items: reports,
        nextCursor: null,
      }) });
      return;
    }
    const reportId = path.split('/').at(-1);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...fixtures.publicReport,
      id: reportId,
    }) });
  });

  await page.goto('/impact');
  await page.locator('.deferred-card').getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.locator('.auth-form').getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Your impact' })).toBeVisible();
  await expect(page.getByText('Impact Score')).toBeVisible();
  await expect(page.getByText('Not configured')).toBeVisible();
  await expect(page.locator('.impact-history-link')).toHaveCount(12);
  await expect(page.locator('.impact-demo-label').first()).toHaveText('Demo activity');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const impactPage = page.locator('.impact-page');
  await impactPage.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const previousScrollTop = await impactPage.evaluate((element) => element.scrollTop);
  await page.locator('.impact-history-link').last().click();
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.locator('.report-sheet')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/impact$/);
  await expect(page.getByRole('heading', { name: 'Your impact' })).toBeVisible();
  await expect.poll(() => impactPage.evaluate((element) => element.scrollTop)).toBe(previousScrollTop);
});
