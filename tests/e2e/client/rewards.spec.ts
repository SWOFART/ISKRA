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
  await expect(page.locator('.rewards-card-title')).toHaveText([
    '10% off a café drink',
    'Coffee + apple cake',
    '15% off a reusable cup',
  ]);
  const offerImages = page.locator('.rewards-card-image');
  await expect(offerImages).toHaveCount(3);
  await expect.poll(() => offerImages.evaluateAll((images) =>
    images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(page.locator('.rewards-progress').nth(2)).toHaveAttribute('max', '40');
  await expect(page.locator('.rewards-progress').nth(2)).toHaveAttribute('value', '40');

  const columns = await page.locator('.rewards-catalog-grid').evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length);
  expect(columns).toBe(2);

  await page.locator('.rewards-card').first().getByRole('button', { name: 'View sample offer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review sample offer' });
  await expect(dialog).toContainText('Current: 45 RP');
  await expect(dialog).toContainText('10% off a café drink');
  await expect(dialog).toContainText('Cost: 5 RP');
  await expect(dialog).toContainText('Remaining after purchase: 40 RP');
  await expect(dialog).toContainText('No real café, shop, discount, QR code, expiry, or fulfillment is available.');
  await dialog.getByRole('button', { name: 'Confirm local demo redemption' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator('.rewards-balance-value')).toHaveText('40 RP');
  await expect(page.getByText('Local demo voucher added. 5 demo RP spent; 40 RP remain.')).toBeVisible();
  const voucher = page.locator('.rewards-voucher');
  await expect(voucher).toHaveCount(1);
  await expect(voucher).toContainText('Received · demo only');
  await expect(voucher.locator('.rewards-voucher-code')).toHaveText(/^DEMO-[0-9A-F-]+$/);
  const voucherImage = voucher.locator('.rewards-voucher-image');
  await expect(voucherImage).toHaveCount(1);
  await expect(voucherImage).toHaveAttribute('alt', 'Cappuccino with leaf latte art and a croissant by a café window.');
  await expect.poll(() => voucherImage.evaluate((image) =>
    (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  await expect(voucher.locator('canvas, svg')).toHaveCount(0);
  await expect(voucher).not.toContainText(/expires|expiration|giltig bis/i);
  expect(apiRequests).toEqual([]);

  await page.reload();
  await expect(page.locator('.rewards-balance-value')).toHaveText('40 RP');
  await expect(page.locator('.rewards-voucher')).toHaveCount(1);
  await expect(page.locator('.rewards-voucher-image')).toHaveCount(1);
  expect(apiRequests).toEqual([]);
});

test('localizes the mock offers and their photo descriptions into German', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('iskra.locale', 'de'));
  await page.goto('/rewards');

  await expect(page.getByRole('heading', { name: 'Lokale Beispielangebote' })).toBeVisible();
  await expect(page.locator('.rewards-card-title')).toHaveText([
    '10 % Rabatt auf ein Getränk im Café',
    'Kaffee + Apfelkuchen',
    '15 % Rabatt auf einen Mehrwegbecher',
  ]);
  await expect(page.locator('.rewards-card-image').first())
    .toHaveAttribute('alt', 'Cappuccino mit Blatt-Latte-Art und Croissant am Caféfenster.');
});
