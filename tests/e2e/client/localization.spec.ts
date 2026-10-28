import { expect, test } from '@playwright/test';

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
});

test('uses English by default for an English browser', async ({ page }) => {
  await page.goto('/map');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.nav-tab[aria-selected="true"] .nav-label')).toHaveText('Map');
});
