import { expect, test } from '../fixtures';

test('Chromium receives honest Worker health and safe cache headers', async ({ page }) => {
  const response = await page.goto('/api/health');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['cache-control']).toBe('no-store');
  expect(await response?.json()).toMatchObject({ ok: true, applicationReady: false });
});

test('unknown API routes stay JSON and cross-origin mutations fail', async ({ request }) => {
  for (const path of ['/api', '/api/unknown']) {
    const missing = await request.get(path, { headers: { Accept: 'text/html' } });
    expect(missing.status()).toBe(404);
    expect(missing.headers()['cache-control']).toBe('no-store');
    expect(missing.headers()['content-type']).toContain('application/json');
    expect(await missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  }
  const denied = await request.post('/api/unknown', { headers: { Origin: 'https://other.example' } });
  expect(denied.status()).toBe(403);
  expect(await denied.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
});
