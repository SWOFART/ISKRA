import { expect, test } from '../fixtures';

test('shows browser-only demo rewards and redeems a local voucher without Rewards API calls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const apiRequests: string[] = [];
  await page.route('**/api/**', async (route) => {
    apiRequests.push(new URL(route.request().url()).pathname);
    await route.abort();
  });

  await page.goto('/rewards');

  await expect(page.getByRole('heading', { name: 'Rewards' })).toBeVisible();
  await expect(page.getByText(/Browser-only demo/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Local demo balance' })).toBeVisible();
  await expect(page.locator('.rewards-balance-value')).toHaveText('45 RP');
  await expect(page.locator('.rewards-card')).toHaveCount(3);
  await expect(page.locator('.rewards-progress').nth(2)).toHaveAttribute('max', '40');
  await expect(page.locator('.rewards-progress').nth(2)).toHaveAttribute('value', '40');

  const columns = await page.locator('.rewards-catalog-grid').evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length);
  expect(columns).toBe(2);

  await page.locator('.rewards-card').first().getByRole('button', { name: 'Try demo reward' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm demo reward' });
  await expect(dialog).toContainText('Current: 45 RP');
  await expect(dialog).toContainText('Cost: 5 RP');
  await expect(dialog).toContainText('Remaining after purchase: 40 RP');
  await expect(dialog).toContainText('It sends no request and creates no real voucher.');
  await dialog.getByRole('button', { name: 'Confirm local demo redemption' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator('.rewards-balance-value')).toHaveText('40 RP');
  await expect(page.getByText('Local demo voucher added. 5 demo RP spent; 40 RP remain.')).toBeVisible();
  const voucher = page.locator('.rewards-voucher');
  await expect(voucher).toHaveCount(1);
  await expect(voucher).toContainText('Received · demo only');
  await expect(voucher.locator('.rewards-voucher-code')).toHaveText(/^DEMO-[0-9A-F-]+$/);
  await expect(voucher.locator('canvas, img, svg')).toHaveCount(0);
  await expect(voucher).not.toContainText(/expires|expiration|giltig bis/i);
  expect(apiRequests).toEqual([]);

  await page.reload();
  await expect(page.locator('.rewards-balance-value')).toHaveText('40 RP');
  await expect(page.locator('.rewards-voucher')).toHaveCount(1);
  expect(apiRequests).toEqual([]);
});
