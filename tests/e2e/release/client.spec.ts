import { expect, test } from '@playwright/test';

for (const [path, selected] of [
  ['/', 'Map'], ['/impact', 'My Impact'], ['/rewards', 'Rewards'], ['/reports/123', 'Map'],
]) {
  test(`direct ${path} loads the client through the Worker`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toContain('text/html');
    expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
    await expect(page.getByRole('tab')).toHaveCount(3);
    await expect(page.getByRole('tab', { name: selected, exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(new URL(page.url()).pathname).toBe(path);
    await expect(page.locator('.app-shell')).toHaveCSS('display', 'grid');
    if (selected !== 'Map') await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('mobile navigation, keyboard and browser Back work without requesting camera or location', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const unexpected = () => { throw new Error('Unexpected camera or location request'); };
    navigator.geolocation.getCurrentPosition = unexpected;
    navigator.geolocation.watchPosition = unexpected;
    navigator.mediaDevices.getUserMedia = unexpected;
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start a litter report' }).click();
  await expect(page.getByRole('status')).toContainText('Camera reporting is not connected yet');
  await page.getByRole('tab', { name: 'My Impact', exact: true }).click();
  await expect(page).toHaveURL(/\/impact$/);
  await page.getByRole('tab', { name: 'My Impact', exact: true }).press('ArrowRight');
  await expect(page).toHaveURL(/\/rewards$/);
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'My Impact', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
