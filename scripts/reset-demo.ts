import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool, type PoolConfig } from 'pg';
import { fileURLToPath } from 'node:url';
import { PostgresTransactionDatabase, type CheckedOutClient, type TransactionDatabase } from '../src/worker/db/client';
import {
  assertDemoSeedTarget,
  assertMarkedDemoSchema,
  DEMO_MARKER_KEY,
  DEMO_MARKER_OPERATION,
  DEMO_SEED_LOCK_KEY,
  DEMO_SEED_OBJECT_PREFIX,
  DEMO_SEED_REQUEST_HASH,
  DEMO_SEED_USER_IDS,
  stableUuid,
} from '../src/worker/services/demo-seeds';

const execFileAsync = promisify(execFile);
const DEMO_DATASET = 'iskra-demo';
const DEMO_R2_BUCKET = 'iskra-demo';
const DEMO_SCHEMA = 'iskra_demo_seed';
const MAX_DEMO_OBJECTS = 4;

export interface DemoObjectStore {
  deleteObjectKeys(keys: readonly string[]): Promise<void>;
}

export interface DemoResetResult {
  readonly alreadyReset: boolean;
  readonly deleted: {
    readonly users: number;
    readonly reports: number;
    readonly analyses: number;
    readonly leases: number;
    readonly cleanups: number;
    readonly photos: number;
    readonly votes: number;
    readonly ledger: number;
    readonly notifications: number;
    readonly idempotencyKeys: number;
  };
  readonly objectKeysProcessed: number;
}

interface SeedManifest {
  readonly reporterId: string;
  readonly userIds: readonly string[];
  readonly reportIds: readonly string[];
  readonly analysisIds: readonly string[];
  readonly cleanupIds: readonly string[];
  readonly voteIds: readonly string[];
}

interface ResetPlan extends SeedManifest {
  readonly alreadyReset: boolean;
  readonly pendingObjectKeys: readonly string[] | null;
  readonly objectKeys: readonly string[];
  readonly photoIds: readonly string[];
}

function fail(message: string): never {
  throw new Error(message);
}

function requireThat(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

export function assertDemoResetBucket(bucket: string): void {
  if (bucket !== DEMO_R2_BUCKET) {
    fail('Demo reset accepts only the explicitly allowlisted local demo bucket.');
  }
}

export function assertDemoObjectKeys(keys: readonly string[]): void {
  if (keys.length > MAX_DEMO_OBJECTS || new Set(keys).size !== keys.length
    || keys.some((key) => !key.startsWith(DEMO_SEED_OBJECT_PREFIX)
      || key.split('/').some((segment) => segment === '.' || segment === '..')
      || !/^demo-fixtures\/seed-v1\/[a-z-]+\/(?:before|after)-[0-9a-f]{64}\.jpg$/.test(key))) {
    fail('Demo reset found an object key outside the exact seeded photo manifest; refusing deletion.');
  }
}

export function assertDemoResetArguments(args: readonly string[]): string {
  const expected = [
    '--environment', 'demo', '--dataset', DEMO_DATASET,
    '--r2-bucket', DEMO_R2_BUCKET, '--confirm-sandbox',
  ];
  if (args.length !== expected.length || args.some((value, index) => value !== expected[index])) {
    fail('Usage: node scripts/reset-demo.cli.mjs --environment demo --dataset iskra-demo --r2-bucket iskra-demo --confirm-sandbox');
  }
  return DEMO_R2_BUCKET;
}

async function getSeedManifest(): Promise<SeedManifest> {
  const reportIds = await Promise.all([
    stableUuid('report/green-resolved'),
    stableUuid('report/yellow-pending'),
    stableUuid('report/red-pending'),
  ]);
  const analysisIds = await Promise.all([
    stableUuid('analysis/report/green-resolved'),
    stableUuid('analysis/report/yellow-pending'),
    stableUuid('analysis/report/red-pending'),
    stableUuid('analysis/cleanup/green-resolved'),
  ]);
  const cleanupIds = [await stableUuid('cleanup/green-resolved')];
  const voteLabels = [
    ...Array.from({ length: 5 }, (_, index) => 'green-existence-' + (index + 1)),
    ...Array.from({ length: 3 }, (_, index) => 'green-resolution-' + (index + 1)),
    ...Array.from({ length: 2 }, (_, index) => 'yellow-existence-' + (index + 1)),
  ];
  const voteIds = await Promise.all(voteLabels.map((label) => stableUuid('vote/' + label)));
  return {
    reporterId: DEMO_SEED_USER_IDS[0]!,
    userIds: DEMO_SEED_USER_IDS,
    reportIds,
    analysisIds,
    cleanupIds,
    voteIds,
  };
}

function parsePendingObjectKeys(value: unknown): readonly string[] | null {
  if (value === null) return null;
  let pending: unknown = value;
  if (typeof value === 'string') {
    try {
      pending = JSON.parse(value);
    } catch {
      fail('Demo reset marker is malformed; refusing to continue.');
    }
  }
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) {
    fail('Demo reset marker is malformed; refusing to continue.');
  }
  const record = pending as { resetState?: unknown; objectKeys?: unknown };
  if (record.resetState !== 'pending' || !Array.isArray(record.objectKeys)
    || record.objectKeys.some((key) => typeof key !== 'string')) {
    fail('Demo reset marker is malformed; refusing to continue.');
  }
  const keys = record.objectKeys as string[];
  assertDemoObjectKeys(keys);
  return keys;
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

async function loadResetPlan(client: CheckedOutClient, manifest: SeedManifest): Promise<ResetPlan> {
  await assertMarkedDemoSchema(client);
  const markerResult = await client.query<{
    request_hash: string;
    resource_id: string | null;
    response_body: unknown;
  }>(
    'SELECT request_hash, resource_id, response_body FROM idempotency_keys '
      + 'WHERE user_id = $1::text AND operation = $2::varchar AND key = $3::varchar',
    [manifest.reporterId, DEMO_MARKER_OPERATION, DEMO_MARKER_KEY],
  );
  const marker = markerResult.rows[0];
  const pendingObjectKeys = parsePendingObjectKeys(marker?.response_body ?? null);
  if (marker && (marker.request_hash !== DEMO_SEED_REQUEST_HASH
    || marker.resource_id !== manifest.reportIds[0])) {
    fail('Demo seed marker does not match this reset manifest; refusing deletion.');
  }

  const users = await client.query<{ id: string; is_demo: boolean }>(
    'SELECT id, is_demo FROM users WHERE id = ANY($1::text[]) ORDER BY id', [manifest.userIds],
  );
  const reports = await client.query<{ id: string; author_user_id: string; is_demo: boolean }>(
    'SELECT id, author_user_id, is_demo FROM reports '
      + 'WHERE id = ANY($1::uuid[]) OR author_user_id = ANY($2::text[]) ORDER BY id',
    [manifest.reportIds, manifest.userIds],
  );
  const analyses = await client.query<{ id: string; owner_user_id: string; report_id: string | null; is_demo: boolean }>(
    'SELECT id, owner_user_id, report_id, is_demo FROM ai_analyses '
      + 'WHERE id = ANY($1::uuid[]) OR owner_user_id = ANY($2::text[]) OR report_id = ANY($3::uuid[]) ORDER BY id',
    [manifest.analysisIds, manifest.userIds, manifest.reportIds],
  );
  const leases = await client.query<{ current_analysis_id: string; owner_user_id: string }>(
    'SELECT current_analysis_id, owner_user_id FROM analysis_leases '
      + 'WHERE owner_user_id = ANY($1::text[]) OR current_analysis_id = ANY($2::uuid[]) '
      + 'ORDER BY current_analysis_id',
    [manifest.userIds, manifest.analysisIds],
  );
  const cleanups = await client.query<{
    id: string; report_id: string; cleaner_user_id: string; is_demo: boolean;
  }>(
    'SELECT id, report_id, cleaner_user_id, is_demo FROM cleanup_submissions '
      + 'WHERE id = ANY($1::uuid[]) OR report_id = ANY($2::uuid[]) '
      + 'OR cleaner_user_id = ANY($3::text[]) ORDER BY id',
    [manifest.cleanupIds, manifest.reportIds, manifest.userIds],
  );
  const photos = await client.query<{
    id: string; owner_user_id: string; report_id: string | null; cleanup_id: string | null; object_key: string;
  }>(
    'SELECT id, owner_user_id, report_id, cleanup_id, object_key FROM report_photos '
      + 'WHERE owner_user_id = ANY($1::text[]) OR report_id = ANY($2::uuid[]) '
      + 'OR cleanup_id = ANY($3::uuid[]) ORDER BY object_key',
    [manifest.userIds, manifest.reportIds, manifest.cleanupIds],
  );
  const votes = await client.query<{
    id: string; report_id: string; voter_user_id: string; is_demo: boolean;
  }>(
    'SELECT id, report_id, voter_user_id, is_demo FROM votes '
      + 'WHERE report_id = ANY($1::uuid[]) OR voter_user_id = ANY($2::text[]) ORDER BY id',
    [manifest.reportIds, manifest.userIds],
  );
  const ledger = await client.query<{ report_id: string | null; user_id: string; is_demo: boolean }>(
    'SELECT report_id, user_id, is_demo FROM reward_ledger '
      + 'WHERE report_id = ANY($1::uuid[]) OR user_id = ANY($2::text[]) ORDER BY id',
    [manifest.reportIds, manifest.userIds],
  );
  const notifications = await client.query<{ report_id: string; user_id: string }>(
    'SELECT report_id, user_id FROM notifications '
      + 'WHERE report_id = ANY($1::uuid[]) OR user_id = ANY($2::text[]) ORDER BY id',
    [manifest.reportIds, manifest.userIds],
  );
  const idempotency = await client.query<{ user_id: string }>(
    'SELECT user_id FROM idempotency_keys WHERE user_id = ANY($1::text[])', [manifest.userIds],
  );

  const reportSet = new Set(manifest.reportIds);
  const analysisSet = new Set(manifest.analysisIds);
  const cleanupSet = new Set(manifest.cleanupIds);
  const voteSet = new Set(manifest.voteIds);
  const userSet = new Set(manifest.userIds);
  requireThat(users.rows.every((row) => row.is_demo), 'A reserved seed user is not marked demo; refusing deletion.');
  requireThat(reports.rows.every((row) => reportSet.has(row.id) && userSet.has(row.author_user_id) && row.is_demo),
    'A non-demo or unknown report is attached to the seed; refusing to delete foreign data.');
  requireThat(analyses.rows.every((row) => analysisSet.has(row.id) && userSet.has(row.owner_user_id)
    && (row.report_id === null || reportSet.has(row.report_id)) && row.is_demo),
  'A non-demo or unknown analysis is attached to the seed; refusing to delete foreign data.');
  requireThat(leases.rows.every((row) => analysisSet.has(row.current_analysis_id) && userSet.has(row.owner_user_id)),
    'An unknown analysis lease is attached to the seed; refusing deletion.');
  requireThat(cleanups.rows.every((row) => cleanupSet.has(row.id) && reportSet.has(row.report_id)
    && userSet.has(row.cleaner_user_id) && row.is_demo),
  'A non-demo or unknown cleanup is attached to the seed; refusing to delete foreign data.');
  requireThat(photos.rows.every((row) => userSet.has(row.owner_user_id)
    && (row.report_id === null || reportSet.has(row.report_id))
    && (row.cleanup_id === null || cleanupSet.has(row.cleanup_id))),
  'A foreign photo is attached to the seed; refusing deletion.');
  const objectKeys = photos.rows.map((row) => row.object_key);
  assertDemoObjectKeys(objectKeys);
  requireThat(votes.rows.every((row) => voteSet.has(row.id) && reportSet.has(row.report_id)
    && userSet.has(row.voter_user_id) && row.is_demo),
  'A non-demo or unknown vote is attached to the seed; refusing to delete foreign data.');
  requireThat(ledger.rows.every((row) => reportSet.has(row.report_id ?? '')
    && userSet.has(row.user_id) && row.is_demo),
  'A non-demo or unknown ledger entry is attached to the seed; refusing to delete foreign data.');
  requireThat(notifications.rows.every((row) => reportSet.has(row.report_id) && userSet.has(row.user_id)),
    'A notification for a foreign user is attached to the seed; refusing deletion.');
  requireThat(idempotency.rows.every((row) => userSet.has(row.user_id)),
    'A foreign idempotency row is attached to the seed; refusing deletion.');

  const artifactCounts = [users.rows.length, reports.rows.length, analyses.rows.length, leases.rows.length,
    cleanups.rows.length, photos.rows.length, votes.rows.length, ledger.rows.length, notifications.rows.length];
  const noArtifacts = artifactCounts.every((count) => count === 0);
  if (!marker) {
    if (noArtifacts && idempotency.rows.length === 0) {
      return { ...manifest, alreadyReset: true, pendingObjectKeys: null, objectKeys: [], photoIds: [] };
    }
    fail('Seed data exists without its completion marker; refusing partial reset.');
  }

  const pending = pendingObjectKeys !== null;
  if (!noArtifacts) {
    const complete = users.rows.length === DEMO_SEED_USER_IDS.length
      && reports.rows.length === 3 && analyses.rows.length === 4 && leases.rows.length === 4
      && cleanups.rows.length === 1 && photos.rows.length === 4 && votes.rows.length === 10
      && ledger.rows.length === 15 && notifications.rows.length === 2;
    requireThat(complete, 'Demo seed data is partial or contains attached foreign rows; refusing reset.');
  } else if (marker && !pending) {
    fail('Demo seed marker exists but its dataset is missing; refusing reset.');
  }

  const photoIds = photos.rows.map((row) => row.id);
  if (pending && photos.rows.length > 0) {
    requireThat(sameKeys(objectKeys, pendingObjectKeys), 'Demo seed photos changed during reset; rerun after inspection.');
  }
  return {
    ...manifest,
    alreadyReset: false,
    pendingObjectKeys,
    objectKeys: pending ? pendingObjectKeys : objectKeys,
    photoIds,
  };
}

async function lockDemoSeed(client: CheckedOutClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [DEMO_SEED_LOCK_KEY]);
}

async function deleteCount(client: CheckedOutClient, sql: string, parameters: readonly unknown[]): Promise<number> {
  const result = await client.query(sql, parameters);
  return result.rowCount ?? 0;
}

async function assertResetInvariants(client: CheckedOutClient, manifest: SeedManifest): Promise<void> {
  const residue = await client.query<{ present: boolean }>(
    'SELECT EXISTS ('
      + 'SELECT 1 FROM users WHERE id = ANY($1::text[]) '
      + 'UNION ALL SELECT 1 FROM reports WHERE id = ANY($2::uuid[]) '
      + 'UNION ALL SELECT 1 FROM ai_analyses WHERE id = ANY($3::uuid[]) '
      + 'UNION ALL SELECT 1 FROM cleanup_submissions WHERE id = ANY($4::uuid[]) '
      + 'UNION ALL SELECT 1 FROM votes WHERE id = ANY($5::uuid[]) '
      + 'UNION ALL SELECT 1 FROM report_photos WHERE id = ANY($6::uuid[])'
      + ') AS present',
    [manifest.userIds, manifest.reportIds, manifest.analysisIds, manifest.cleanupIds, manifest.voteIds,
      await Promise.all([
        stableUuid('photo/report/green-resolved/before'),
        stableUuid('photo/report/yellow-pending/before'),
        stableUuid('photo/report/red-pending/before'),
        stableUuid('photo/cleanup/green-resolved/after'),
      ])],
  );
  const marker = await client.query<{ present: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM idempotency_keys WHERE user_id = $1::text '
      + 'AND operation = $2::varchar AND key = $3::varchar) AS present',
    [manifest.reporterId, DEMO_MARKER_OPERATION, DEMO_MARKER_KEY],
  );
  requireThat(!residue.rows[0]?.present && !marker.rows[0]?.present,
    'Post-reset invariant failed: known seed rows or reset marker remain.');
}

export async function resetDemoSeed(
  database: TransactionDatabase,
  objectStore: DemoObjectStore,
): Promise<DemoResetResult> {
  const manifest = await getSeedManifest();
  const prepared = await database.withTransaction(async (client) => {
    await lockDemoSeed(client);
    const plan = await loadResetPlan(client, manifest);
    if (plan.alreadyReset) return plan;
    if (plan.pendingObjectKeys === null) {
      await client.query(
        'UPDATE idempotency_keys SET response_body = $4::jsonb '
          + 'WHERE user_id = $1::text AND operation = $2::varchar AND key = $3::varchar',
        [manifest.reporterId, DEMO_MARKER_OPERATION, DEMO_MARKER_KEY,
          JSON.stringify({ resetState: 'pending', objectKeys: plan.objectKeys })],
      );
    }
    return plan;
  });

  if (prepared.alreadyReset) {
    return {
      alreadyReset: true,
      deleted: { users: 0, reports: 0, analyses: 0, leases: 0, cleanups: 0, photos: 0,
        votes: 0, ledger: 0, notifications: 0, idempotencyKeys: 0 },
      objectKeysProcessed: 0,
    };
  }

  assertDemoObjectKeys(prepared.objectKeys);
  if (prepared.objectKeys.length > 0) await objectStore.deleteObjectKeys(prepared.objectKeys);

  return database.withTransaction(async (client) => {
    await lockDemoSeed(client);
    const current = await loadResetPlan(client, manifest);
    if (current.alreadyReset) {
      return {
        alreadyReset: true,
        deleted: { users: 0, reports: 0, analyses: 0, leases: 0, cleanups: 0, photos: 0,
          votes: 0, ledger: 0, notifications: 0, idempotencyKeys: 0 },
        objectKeysProcessed: prepared.objectKeys.length,
      };
    }
    requireThat(current.pendingObjectKeys !== null && sameKeys(current.objectKeys, prepared.objectKeys),
      'Demo reset state changed while removing objects; rerun after inspection.');

    const users = [manifest.userIds];
    const reports = [manifest.reportIds];
    const analyses = [manifest.analysisIds];
    const cleanups = [manifest.cleanupIds];
    const votes = [manifest.voteIds];
    const photos = [current.photoIds];
    const deleted = {
      idempotencyKeys: await deleteCount(client,
        'DELETE FROM idempotency_keys WHERE user_id = ANY($1::text[])', users),
      notifications: await deleteCount(client,
        'DELETE FROM notifications WHERE report_id = ANY($1::uuid[]) AND user_id = ANY($2::text[])',
        [manifest.reportIds, manifest.userIds]),
      ledger: await deleteCount(client,
        'DELETE FROM reward_ledger WHERE report_id = ANY($1::uuid[]) AND user_id = ANY($2::text[])',
        [manifest.reportIds, manifest.userIds]),
      votes: await deleteCount(client,
        'DELETE FROM votes WHERE id = ANY($1::uuid[]) AND report_id = ANY($2::uuid[])',
        [manifest.voteIds, manifest.reportIds]),
      photos: await deleteCount(client,
        'DELETE FROM report_photos WHERE id = ANY($1::uuid[]) AND owner_user_id = ANY($2::text[])',
        [current.photoIds, manifest.userIds]),
      leases: await deleteCount(client,
        'DELETE FROM analysis_leases WHERE current_analysis_id = ANY($1::uuid[]) AND owner_user_id = ANY($2::text[])',
        [manifest.analysisIds, manifest.userIds]),
      cleanups: await deleteCount(client,
        'DELETE FROM cleanup_submissions WHERE id = ANY($1::uuid[]) AND report_id = ANY($2::uuid[])',
        [manifest.cleanupIds, manifest.reportIds]),
      analyses: 0,
      reports: 0,
      users: 0,
    };
    const cleanupAnalysis = manifest.analysisIds[3]!;
    deleted.analyses += await deleteCount(client,
      'DELETE FROM ai_analyses WHERE id = $1::uuid AND owner_user_id = ANY($2::text[])',
      [cleanupAnalysis, manifest.userIds]);
    deleted.reports = await deleteCount(client,
      'DELETE FROM reports WHERE id = ANY($1::uuid[]) AND author_user_id = ANY($2::text[])',
      [manifest.reportIds, manifest.userIds]);
    deleted.analyses += await deleteCount(client,
      'DELETE FROM ai_analyses WHERE id = ANY($1::uuid[]) AND owner_user_id = ANY($2::text[])',
      [analyses[0], manifest.userIds]);
    deleted.users = await deleteCount(client,
      'DELETE FROM users WHERE id = ANY($1::text[]) AND is_demo = true', users);
    await assertResetInvariants(client, manifest);

    return { alreadyReset: false, deleted, objectKeysProcessed: prepared.objectKeys.length };
  });
}

function readTarget(rawUrl: string | undefined) {
  let url: URL;
  try {
    url = new URL(rawUrl ?? '');
  } catch {
    fail('TEST_DATABASE_URL must target the disposable local PostgreSQL database.');
  }
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: Number(url.port),
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    hasSearch: Boolean(url.search),
    hasHash: Boolean(url.hash),
    password: decodeURIComponent(url.password),
  };
}

function createWranglerObjectStore(bucket: string): DemoObjectStore {
  assertDemoResetBucket(bucket);
  const wranglerCli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const localPersistPath = fileURLToPath(new URL('../.wrangler/state', import.meta.url));
  return {
    async deleteObjectKeys(keys) {
      assertDemoObjectKeys(keys);
      for (const key of keys) {
        try {
          await execFileAsync(process.execPath, [wranglerCli, 'r2', 'object', 'delete',
            bucket + '/' + key, '--local', '--persist-to', localPersistPath, '--force'], {
            cwd: repoRoot,
            timeout: 30_000,
            maxBuffer: 16 * 1024,
            windowsHide: true,
          });
        } catch {
          fail('Local R2 demo-object deletion failed; the database was left intact. Retry the guarded reset after checking the local storage state.');
        }
      }
    },
  };
}

export async function runDemoResetCli(args = process.argv.slice(2)): Promise<void> {
  const bucket = assertDemoResetArguments(args);
  const target = readTarget(process.env.TEST_DATABASE_URL);
  assertDemoSeedTarget({
    ...target,
    appEnvironment: process.env.APP_ENV,
    demoData: process.env.DEMO_DATA,
  });
  const config: PoolConfig = {
    host: '127.0.0.1',
    port: target.port,
    database: 'iskra_test',
    user: 'iskra_test',
    password: target.password || 'iskra-test-only',
    ssl: false,
    options: '-c search_path=iskra_demo_seed,pg_catalog',
    application_name: 'iskra-demo-reset',
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 8_000,
    max: 1,
  };
  const pool = new Pool(config);
  try {
    const result = await resetDemoSeed(new PostgresTransactionDatabase(pool), createWranglerObjectStore(bucket));
    console.log(JSON.stringify({
      outcome: 'reset', environment: 'demo', dataset: DEMO_DATASET, database: 'iskra_test', schema: DEMO_SCHEMA,
      r2Mode: 'local', r2Bucket: bucket, ...result,
    }, null, 2));
  } finally {
    await pool.end();
  }
}
