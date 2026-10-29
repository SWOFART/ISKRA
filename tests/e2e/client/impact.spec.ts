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

test('shows quiet localized resolution notifications once, marks them read and returns to current Impact', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const token = await stubAuthenticatedClient(page);
  const report = fixtures.impact.items[0].report;
  const existenceId = '11111111-1111-4111-8111-000000000031';
  const resolutionId = '11111111-1111-4111-8111-000000000032';
  const notifications = [{
    id: existenceId,
    kind: 'EXISTENCE_VERIFIED',
    message: 'Residents confirmed your report.',
    reportId: report.id,
    readAt: null as string | null,
  }];
  let notificationReads = 0;
  let failNotificationRequests = false;
  let impactBalance = 20;
  let impactReads = 0;
  const notificationLocales: string[] = [];

  await page.route('**/api/me/impact**', async (route) => {
    impactReads += 1;
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...fixtures.impact,
      totals: { ...fixtures.impact.totals, balanceRp: impactBalance },
      balanceVersion: impactReads,
    }) });
  });
  await page.route('**/api/me/notifications**', async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    if (route.request().method() === 'PATCH') {
      const notificationId = new URL(route.request().url()).pathname.split('/').at(-1)!;
      const notification = notifications.find((item) => item.id === notificationId);
      if (notification) notification.readAt ??= '2026-10-28T20:00:00.000Z';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: notificationId,
        readAt: notification?.readAt ?? '2026-10-28T20:00:00.000Z',
      }) });
      return;
    }
    notificationReads += 1;
    if (failNotificationRequests) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: {
        code: 'UNAVAILABLE',
        message: 'Notifications are temporarily unavailable.',
        requestId: '11111111-1111-4111-8111-000000000033',
        retryable: true,
      } }) });
      return;
    }
    const locale = new URL(route.request().url()).searchParams.get('locale') ?? 'en';
    notificationLocales.push(locale);
    const items = notifications.map((item) => ({
      ...item,
      message: item.kind === 'REPORT_RESOLVED'
        ? locale === 'de' ? 'Dank dir ist deine Stadt sauberer!' : 'Your city is cleaner thanks to you!'
        : locale === 'de' ? 'Die Bewohner haben deinen Bericht bestätigt.' : 'Residents confirmed your report.',
    }));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, nextCursor: null }) });
  });
  await page.route('**/api/reports**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/reports')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        items: [report],
        nextCursor: null,
      }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...fixtures.publicReport,
      id: report.id,
    }) });
  });

  await page.goto('/impact');
  await page.locator('.deferred-card').getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.locator('.auth-form').getByRole('button', { name: 'Sign in', exact: true }).click();

  const existenceCard = page.locator(`.impact-notification-item[data-notification-id="${existenceId}"]`);
  await expect(existenceCard).toContainText('Residents confirmed your report.');
  const markRead = existenceCard.getByRole('button', { name: 'Mark as read' });
  await markRead.focus();
  const readsBeforeFocusRefresh = notificationReads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => notificationReads).toBe(readsBeforeFocusRefresh + 1);
  await expect(markRead).toBeFocused();
  await markRead.click();
  await expect(existenceCard).toContainText('Read');
  await expect(existenceCard.getByRole('button', { name: 'Open report' })).toBeFocused();

  failNotificationRequests = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const notificationStatus = page.locator('.impact-notifications-status');
  await expect(notificationStatus).toHaveText('Notifications are temporarily unavailable.');
  const refreshNotifications = page.getByRole('button', { name: 'Refresh notifications' });
  await refreshNotifications.focus();
  const readsBeforeRetry = notificationReads;
  failNotificationRequests = false;
  await refreshNotifications.click();
  await expect.poll(() => notificationReads).toBe(readsBeforeRetry + 1);
  await expect(notificationStatus).toBeFocused();

  notifications.unshift({
    id: resolutionId,
    kind: 'REPORT_RESOLVED',
    message: 'Your city is cleaner thanks to you!',
    reportId: report.id,
    readAt: null,
  });
  impactBalance = 35;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const toast = page.locator('.app-notification-toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Your city is cleaner thanks to you!');

  const callsBeforeHidden = notificationReads;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForTimeout(100);
  expect(notificationReads).toBe(callsBeforeHidden);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => notificationReads).toBe(callsBeforeHidden + 1);
  await expect(toast).toContainText('Your city is cleaner thanks to you!');

  await page.getByRole('button', { name: 'Deutsch', exact: true }).click();
  await expect(toast).toContainText('Dank dir ist deine Stadt sauberer!');
  expect(notificationLocales).toContain('en');
  expect(notificationLocales).toContain('de');
  await toast.getByRole('button', { name: 'Benachrichtigung schließen' }).click();
  await expect(page.locator('.bottom-nav [role="tab"][aria-selected="true"]')).toBeFocused();
  const callsBeforeReplay = notificationReads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => notificationReads).toBe(callsBeforeReplay + 1);
  await expect(toast).toHaveJSProperty('hidden', true);

  const resolutionCard = page.locator(`.impact-notification-item[data-notification-id="${resolutionId}"]`);
  await expect(resolutionCard).toContainText('Dank dir ist deine Stadt sauberer!');
  await resolutionCard.getByRole('button', { name: 'Meldung öffnen' }).click();
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.locator('.report-sheet')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/impact$/);
  await expect(page.locator('.impact-metric-grid--totals .impact-metric-value').nth(1)).toHaveText('35 RP');
  await expect(page.locator(`.impact-notification-item[data-notification-id="${resolutionId}"]`)).toContainText('Gelesen');
  expect(impactReads).toBeGreaterThanOrEqual(3);
});

test('keeps a newer balance and cleanup stage when an older impact page arrives', async ({ page }) => {
  const token = await stubAuthenticatedClient(page);
  const current = {
    ...fixtures.impact,
    totals: { ...fixtures.impact.totals, balanceRp: 80 },
    balanceVersion: 9,
    nextCursor: 'older-page',
  };
  const staleReport = {
    ...fixtures.impact.items[0].report,
    status: 'VERIFIED',
    resolutionYesCount: 0,
    version: 4,
  };
  const stale = {
    ...fixtures.impact,
    totals: { ...fixtures.impact.totals, balanceRp: 10 },
    balanceVersion: 2,
    items: [{ ...fixtures.impact.items[0], report: staleReport }],
    nextCursor: null,
  };
  await page.route('**/api/me/impact**', async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cursor ? stale : current),
    });
  });
  await page.route('**/api/me/notifications*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [], nextCursor: null }),
  }));
  await page.goto('/impact');
  await page.locator('.deferred-card').getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.locator('.auth-form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.impact-metric-grid--totals .impact-metric-value').nth(1)).toHaveText('80 RP');
  await expect(page.locator('.impact-report-status')).toHaveText('Cleanup awaiting verification');
  await page.getByRole('button', { name: 'Load more activity' }).click();
  await expect(page.locator('.impact-metric-grid--totals .impact-metric-value').nth(1)).toHaveText('80 RP');
  await expect(page.locator('.impact-report-status')).toHaveText('Cleanup awaiting verification');
});
