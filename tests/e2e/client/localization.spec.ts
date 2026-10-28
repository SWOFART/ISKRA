import { expect, test } from '../fixtures';

test('switches to German, persists the choice and keeps the selected tab', async ({ page }) => {
  await page.goto('/impact');
  await expect(page.locator('.nav-tab[aria-selected="true"] .nav-label')).toHaveText('My Impact');

  await page.getByRole('button', { name: 'Deutsch' }).click();

  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('.nav-tab[aria-selected="true"] .nav-label')).toHaveText('Mein Einfluss');
  await expect(page.locator('.deferred-card h1')).toHaveText('Dein Einfluss');
  await expect(page).toHaveURL(/\/impact$/);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('.nav-tab[aria-selected="true"] .nav-label')).toHaveText('Mein Einfluss');
  await expect(page.locator('.deferred-card h1')).toHaveText('Dein Einfluss');
  await expect(page).toHaveURL(/\/impact$/);
});

test('offers a focusable main target for skip navigation', async ({ page }) => {
  await page.goto('/map');
  const main = page.locator('#main-content');
  await expect(main).toHaveAttribute('tabindex', '-1');
  await page.locator('.skip-link').click();
  await expect(page).toHaveURL(/#main-content$/);
});

test('uses English by default for an English browser', async ({ page }) => {
  await page.goto('/map');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.nav-tab[aria-selected="true"] .nav-label')).toHaveText('Map');
});
