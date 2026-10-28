import { expect, test } from '@playwright/test';
import fixtures from '../../fixtures/contracts/p0.json' with { type: 'json' };

test('shows the Heilbronn report map, route filters and stage-aware status labels', async ({ page }) => {
  const report = fixtures.publicReport;
  const summary = {
    id: report.id,
    route: report.route,
    status: report.status,
    location: report.location,
    coverPhotoId: report.coverPhotoId,
    description: report.description,
    existenceYesCount: report.existenceYesCount,
    resolutionYesCount: report.resolutionYesCount,
    existenceVerifiedAt: report.existenceVerifiedAt,
    lastExistenceConfirmedAt: report.lastExistenceConfirmedAt,
    version: report.version,
    updatedAt: report.updatedAt,
    isDemo: report.isDemo,
  };
  const requestUrls: string[] = [];
  await page.route('**/api/reports**', async (route) => {
    requestUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [summary], nextCursor: null }),
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/map');

  await expect(page.getByRole('region', { name: 'Report map overview centered on Heilbronn' })).toBeVisible();
  await expect(page.locator('.nav-tab')).toHaveCount(3);
  await expect(page.locator('.route-filter')).toHaveText(['Green', 'Yellow', 'Red']);
  await expect(page.locator('.map-marker')).toHaveCount(1);
  await expect(page.locator('.map-marker')).toHaveAttribute('aria-label', /Green route.*Cleanup awaiting verification/);
  await expect(page.locator('.report-list-item')).toContainText('Cleanup awaiting verification');
  await expect(page.locator('.report-list-item')).toContainText('3/3 threshold · 8 confirmations');
  await expect(page.locator('.report-list-item')).toBeVisible();

  const verificationFilter = page.getByRole('button', { name: 'Needs verification' });
  await verificationFilter.click();
  await expect(verificationFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.report-list-item')).toHaveCount(1);
  await expect.poll(() => requestUrls.length).toBe(2);
  const verificationQuery = new URL(requestUrls[1]).searchParams;
  expect(verificationQuery.get('needsVerification')).toBe('true');
  expect(verificationQuery.get('bbox')).toBeNull();

  await page.getByRole('button', { name: 'Green', exact: true }).click();
  await expect(page.locator('.route-filter[data-route="GREEN"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.report-list-empty')).toContainText('No reports match these filters.');
  await expect(page.locator('.map-marker')).toHaveCount(0);
});
