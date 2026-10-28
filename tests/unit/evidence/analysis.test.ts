import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/worker/index';
import type { TransactionDatabase } from '../../../src/worker/db/client';

const input = { photoIds: [crypto.randomUUID()], comment: '', measuredLocation: {
  lat: 49.14, lng: 9.22, accuracyM: 10, observedAt: new Date().toISOString(),
}, pin: { lat: 49.14, lng: 9.22 }, cityId: 'heilbronn', outputLocale: 'en' };

function setup() {
  const query = vi.fn();
  const database: TransactionDatabase = { withTransaction: query };
  const app = createApp({ database, verify: async (token) => {
    if (token !== 'resident') throw new Error('Invalid test identity');
    return { uid: 'resident' };
  } });
  const env = { FIREBASE_PROJECT_ID: 'iskra-test' };
  const start = (body: unknown = input, headers: Record<string, string> = {}) => app.request('https://iskra.test/api/ai/analyze-report', {
    method: 'POST', headers: { Authorization: 'Bearer resident', 'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }, env);
  return { app, env, query, start };
}

describe('analysis request boundary', () => {
  it('pauses analysis when AI_RATE_PER_MINUTE is 0 before any database call', async () => {
    const { app, env, query } = setup();
    const response = await app.request('https://iskra.test/api/ai/analyze-report', {
      method: 'POST', headers: { Authorization: 'Bearer resident', 'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(input),
    }, { ...env, AI_RATE_PER_MINUTE: '0' });
    expect(response.status).toBe(503);
    expect(query).not.toHaveBeenCalled();
  });

  it('requires verified authentication for report, cleanup and polling', async () => {
    const { app, env, query } = setup();
    for (const path of ['/ai/analyze-report', '/ai/analyze-cleanup', '/ai/analyses/' + crypto.randomUUID()]) {
      const response = await app.request('https://iskra.test/api' + path, {
        method: path.includes('/analyses/') ? 'GET' : 'POST', headers: { Authorization: 'Bearer forged' },
      }, env);
      expect(response.status).toBe(401);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, route: 'GREEN' }, { ...input, userId: 'other' }, { ...input, photoIds: [] },
    { ...input, photoIds: Array.from({ length: 6 }, () => crypto.randomUUID()) },
    { ...input, photoIds: [input.photoIds[0], input.photoIds[0]] },
    { ...input, outputLocale: 'fr' }, { ...input, cityId: 'other' },
  ])('rejects invalid or client-authoritative inputs before SQL', async (body) => {
    const { start, query } = setup();
    expect((await start(body)).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('requires an operation key and reports unavailable storage honestly', async () => {
    const { start, query } = setup();
    expect((await start(input, { 'Idempotency-Key': 'bad-key' })).status).toBe(400);
    const response = await start();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAVAILABLE', retryable: true } });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects lookup query extras and mutation origin attacks before SQL', async () => {
    const { app, env, start, query } = setup();
    const response = await app.request('https://iskra.test/api/ai/analyses/' + crypto.randomUUID() + '?uid=other', {
      headers: { Authorization: 'Bearer resident' },
    }, env);
    expect(response.status).toBe(400);
    expect((await start(input, { Origin: 'https://foreign.test' })).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps cleanup unavailable pending durable target binding', async () => {
    const { app, env, query } = setup();
    const response = await app.request('https://iskra.test/api/ai/analyze-cleanup', {
      method: 'POST', headers: { Authorization: 'Bearer resident' },
    }, env);
    expect(response.status).toBe(503);
    expect(query).not.toHaveBeenCalled();
  });
});
