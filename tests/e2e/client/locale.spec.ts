import { expect, test } from '@playwright/test';

test('language can be changed and persisted while preserving the active tab', async ({ page }) => {
  await page.goto('/impact');
  await expect(page.getByRole('heading', { name: 'Your impact' })).toBeVisible();

  await page.getByRole('combobox', { name: 'Language' }).selectOption('de');
  await expect(page).toHaveURL(/\/impact$/);
  await expect(page.getByRole('heading', { name: 'Dein Beitrag' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Mein Beitrag' })).toHaveAttribute('aria-selected', 'true');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dein Beitrag' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Sprache' })).toHaveValue('de');
});
