import { expect, test } from '@playwright/test';

test('Chromium receives honest Worker health and safe cache headers', async ({ page }) => {
  const response = await page.goto('/api/health');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['cache-control']).toBe('no-store');
  expect(await response?.json()).toMatchObject({ ok: true, applicationReady: false });
});

test('unknown API routes stay JSON and cross-origin mutations fail', async ({ request }) => {
  const missing = await request.get('/api/unknown');
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  const denied = await request.post('/api/unknown', { headers: { Origin: 'https://other.example' } });
  expect(denied.status()).toBe(403);
  expect(await denied.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
});
