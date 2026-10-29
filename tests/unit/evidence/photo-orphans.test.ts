import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertOrphanSweepTarget, parseOrphanObjects, removeOrphanObject, runOrphanSweep } from '../../../scripts/sweep-photo-orphans';
import { sweepUnindexedPhotos, type UnindexedPhotoObject } from '../../../src/worker/db/evidence-store';
import type { TransactionDatabase } from '../../../src/worker/db/client';
import { vertexAuthJson } from '../../fixtures/ai/vertex';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const id = '11111111-1111-4111-8111-111111111111';
const old = '2026-10-27T00:00:00.000Z';
const object: UnindexedPhotoObject = { id, key: 'photos/' + id, createdAt: old, updatedAt: old, expiresAt: old,
  generation: '1234', metageneration: '1' };
const listed = { name: object.key, timeCreated: old, updated: old, generation: '1234', metageneration: '1',
  metadata: { photoId: id, sha256: 'a'.repeat(64), expiresAt: old } };
afterEach(() => vi.useRealTimers());

describe('staging object-only orphan safeguards', () => {
  it('rejects production, foreign origin/project and foreign bucket configuration', () => {
    const config = { APP_ENV: 'staging', VERTEX_AUTH_JSON: vertexAuthJson,
      GCS_PHOTOS_BUCKET: 'iskra-test-staging-photos', APP_URL: 'https://iskra.test' };
    expect(() => assertOrphanSweepTarget(config, 'iskra-test')).not.toThrow();
    for (const change of [{ APP_ENV: 'production' }, { APP_URL: 'https://foreign.test' },
      { GCS_PHOTOS_BUCKET: 'iskra-test-production-photos' }]) {
      expect(() => assertOrphanSweepTarget({ ...config, ...change }, 'iskra-test')).toThrow();
    }
    expect(() => assertOrphanSweepTarget(config, 'foreign-project')).toThrow();
  });

  it('recognizes only protocol-owned objects and refuses a truncated or malformed listing', () => {
    expect(parseOrphanObjects({ items: [listed] })).toEqual([object]);
    for (const entry of [{ ...listed, name: 'unrelated/' + id }, { ...listed, metadata: {} },
      { ...listed, metadata: { ...listed.metadata, photoId: id.toUpperCase() + 'bad' } },
      { ...listed, metadata: { ...listed.metadata, sha256: 'bad' } }, null]) {
      expect(parseOrphanObjects({ items: [entry] })).toEqual([]);
    }
    for (const reply of [{ nextPageToken: 'more', items: [listed] }, { items: {} }, { items: Array(1001).fill(listed) }]) {
      expect(() => parseOrphanObjects(reply)).toThrow();
    }
    expect(parseOrphanObjects({})).toEqual([]);
  });

  it('binds deletes to both object and metadata generations and fails closed on redirects/provider errors', async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(null, { status: 204 }));
    expect(await removeOrphanObject('iskra-test-staging-photos', 'test-only-token', object, fetcher)).toBe('deleted');
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain('/o/' + encodeURIComponent(object.key));
    expect(new URL(String(url)).searchParams.get('ifGenerationMatch')).toBe('1234');
    expect(new URL(String(url)).searchParams.get('ifMetagenerationMatch')).toBe('1');
    expect(init).toMatchObject({ method: 'DELETE', redirect: 'manual' });
    for (const [status, expected] of [[404, 'missing'], [412, 'changed']] as const) {
      fetcher.mockImplementation(async () => new Response(null, { status }));
      expect(await removeOrphanObject('iskra-test-staging-photos', 'test-only-token', object, fetcher)).toBe(expected);
    }
    for (const status of [302, 403, 500]) {
      fetcher.mockImplementation(async () => new Response('private-provider-detail', { status }));
      await expect(removeOrphanObject('iskra-test-staging-photos', 'test-only-token', object, fetcher))
        .rejects.toThrow('Conditional orphan deletion failed.');
    }
  });

  it('uses the SQL clock even when the operator clock is far ahead, and defaults to no deletion', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2040-01-01');
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('clock_timestamp() AS now')
      ? [{ now: new Date('2026-10-29T00:00:00Z') }] : [] }));
    const database = { withTransaction: (work: (client: unknown) => unknown) => work({ query }) } as TransactionDatabase;
    const remove = vi.fn(async () => 'deleted' as const);
    const fresh = { ...object, id: crypto.randomUUID(), createdAt: '2026-10-28T23:00:00Z',
      updatedAt: '2026-10-28T23:00:00Z', expiresAt: '2026-10-28T23:00:00Z' }; fresh.key = 'photos/' + fresh.id;
    const atBoundary = '2026-10-28T00:00:00.000Z';
    const boundary = { ...object, id: crypto.randomUUID(), createdAt: atBoundary, updatedAt: atBoundary, expiresAt: atBoundary };
    boundary.key = 'photos/' + boundary.id;
    const result = await sweepUnindexedPhotos(database, [object, fresh, boundary], remove);
    expect(result).toMatchObject({ scanned: 3, aged: 1, selected: 1, deleted: 0, dryRun: true });
    expect(remove).not.toHaveBeenCalled();
    const invalid = [object, { ...object, id: 'invalid' }, { ...object, expiresAt: '0' }, { ...object, generation: '-1' }];
    expect((await sweepUnindexedPhotos(database, invalid, remove)).selected).toBe(1);
    await expect(sweepUnindexedPhotos(database, [object, object], remove, true)).rejects.toThrow('Duplicate');
    await expect(sweepUnindexedPhotos(database, Array(1001).fill(object), remove, true)).rejects.toThrow('safety bound');
    expect(remove).not.toHaveBeenCalled();
  });

  it('refuses missing/bad proxy ports and unexpected CLI flags before any cloud work', async () => {
    for (const args of [[], ['--proxy-port', '0'], ['--proxy-port', '70000'], ['--environment', 'production']]) {
      await expect(runOrphanSweep(args)).rejects.toThrow();
    }
  });

  it('loads the real Node CLI without native TypeScript transform flags before rejecting invalid arguments', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../scripts/sweep-photo-orphans.cli.mjs', import.meta.url)),
      '--proxy-port', '0'], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Staging orphan sweep stopped.');
    expect(result.stderr).not.toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
    expect(result.stdout).toBe('');
  });
});
