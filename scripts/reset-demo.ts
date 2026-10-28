import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Pool, type PoolConfig } from 'pg';
import { fileURLToPath } from 'node:url';
import { PostgresTransactionDatabase, type CheckedOutClient, type TransactionDatabase } from '../src/worker/db/client';
import { POLICY } from '../src/shared/contracts';
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
  readonly photoIds: readonly string[];
  readonly objectKeys: readonly string[];
  readonly reports: readonly { readonly id: string; readonly authorUserId: string }[];
  readonly analyses: readonly { readonly id: string; readonly ownerUserId: string; readonly reportId: string | null }[];
  readonly leases: readonly { readonly analysisId: string; readonly ownerUserId: string; readonly kind: string; readonly inputHash: string }[];
  readonly cleanups: readonly { readonly id: string; readonly reportId: string; readonly cleanerUserId: string; readonly analysisId: string }[];
  readonly photos: readonly {
    readonly id: string; readonly ownerUserId: string; readonly reportId: string | null;
    readonly cleanupId: string | null; readonly objectKey: string; readonly purpose: string;
    readonly byteSize: number; readonly sha256: string;
  }[];
  readonly votes: readonly {
    readonly id: string; readonly reportId: string; readonly voterUserId: string;
    readonly stage: 'EXISTENCE' | 'RESOLUTION';
  }[];
  readonly ledger: readonly {
    readonly userId: string; readonly kind: string; readonly delta: number; readonly sourceRef: string;
    readonly reportId: string; readonly voteId: string | null;
  }[];
  readonly notifications: readonly { readonly reportId: string; readonly userId: string; readonly kind: string }[];
  readonly idempotencyKeys: readonly {
    readonly userId: string; readonly operation: string; readonly key: string;
    readonly resourceId: string; readonly responseStatus: number;
  }[];
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

export function assertDemoObjectKeys(keys: readonly string[], expectedKeys?: readonly string[]): void {
  if (keys.length > MAX_DEMO_OBJECTS || new Set(keys).size !== keys.length
    || keys.some((key) => !key.startsWith(DEMO_SEED_OBJECT_PREFIX)
      || key.split('/').some((segment) => segment === '.' || segment === '..')
      || !/^demo-fixtures\/seed-v1\/[a-z-]+\/(?:before|after)-[0-9a-f]{64}\.jpg$/.test(key))
    || (expectedKeys !== undefined && !sameKeys(keys, expectedKeys))) {
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
  const users = DEMO_SEED_USER_IDS;
  const cleanupIds = [await stableUuid('cleanup/green-resolved')];
  const voteDefinitions = [
    ...Array.from({ length: 5 }, (_, index) => ({
      label: 'green-existence-' + (index + 1), reportId: reportIds[0]!, voterUserId: users[4 + index]!, stage: 'EXISTENCE' as const,
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      label: 'green-resolution-' + (index + 1), reportId: reportIds[0]!, voterUserId: users[9 + index]!, stage: 'RESOLUTION' as const,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      label: 'yellow-existence-' + (index + 1), reportId: reportIds[1]!, voterUserId: users[12 + index]!, stage: 'EXISTENCE' as const,
    })),
  ];
  const voteIds = await Promise.all(voteDefinitions.map(({ label }) => stableUuid('vote/' + label)));
  const photoIds = await Promise.all([
    stableUuid('photo/report/green-resolved/before'),
    stableUuid('photo/report/yellow-pending/before'),
    stableUuid('photo/report/red-pending/before'),
    stableUuid('photo/cleanup/green-resolved/after'),
  ]);
  const fixture = await readFile(new URL('../tests/fixtures/photos/restart.jpg', import.meta.url));
  const sha256 = createHash('sha256').update(fixture).digest('hex');
  const objectKeys = [
    `${DEMO_SEED_OBJECT_PREFIX}green-resolved/before-${sha256}.jpg`,
    `${DEMO_SEED_OBJECT_PREFIX}yellow-pending/before-${sha256}.jpg`,
    `${DEMO_SEED_OBJECT_PREFIX}red-pending/before-${sha256}.jpg`,
    `${DEMO_SEED_OBJECT_PREFIX}green-resolved/after-${sha256}.jpg`,
  ].sort();
  const reports = [
    { id: reportIds[0]!, authorUserId: users[0]! },
    { id: reportIds[1]!, authorUserId: users[1]! },
    { id: reportIds[2]!, authorUserId: users[2]! },
  ];
  const analyses = [
    { id: analysisIds[0]!, ownerUserId: users[0]!, reportId: null },
    { id: analysisIds[1]!, ownerUserId: users[1]!, reportId: null },
    { id: analysisIds[2]!, ownerUserId: users[2]!, reportId: null },
    { id: analysisIds[3]!, ownerUserId: users[3]!, reportId: reportIds[0]! },
  ];
  const leases = [
    ...analyses.slice(0, 3).map((analysis, index) => ({
      analysisId: analysis.id, ownerUserId: analysis.ownerUserId, kind: 'REPORT',
      inputHash: `demo-seed-v1/report/${['green-resolved', 'yellow-pending', 'red-pending'][index]}`,
    })),
    { analysisId: analysisIds[3]!, ownerUserId: users[3]!, kind: 'CLEANUP', inputHash: 'demo-seed-v1/cleanup/green-resolved' },
  ];
  const cleanups = [{ id: cleanupIds[0]!, reportId: reportIds[0]!, cleanerUserId: users[3]!, analysisId: analysisIds[3]! }];
  const photos = [
    { id: photoIds[0]!, ownerUserId: users[0]!, reportId: reportIds[0]!, cleanupId: null,
      objectKey: `${DEMO_SEED_OBJECT_PREFIX}green-resolved/before-${sha256}.jpg`, purpose: 'REPORT', byteSize: fixture.byteLength, sha256 },
    { id: photoIds[1]!, ownerUserId: users[1]!, reportId: reportIds[1]!, cleanupId: null,
      objectKey: `${DEMO_SEED_OBJECT_PREFIX}yellow-pending/before-${sha256}.jpg`, purpose: 'REPORT', byteSize: fixture.byteLength, sha256 },
    { id: photoIds[2]!, ownerUserId: users[2]!, reportId: reportIds[2]!, cleanupId: null,
      objectKey: `${DEMO_SEED_OBJECT_PREFIX}red-pending/before-${sha256}.jpg`, purpose: 'REPORT', byteSize: fixture.byteLength, sha256 },
    { id: photoIds[3]!, ownerUserId: users[3]!, reportId: null, cleanupId: cleanupIds[0]!,
      objectKey: `${DEMO_SEED_OBJECT_PREFIX}green-resolved/after-${sha256}.jpg`, purpose: 'CLEANUP', byteSize: fixture.byteLength, sha256 },
  ];
  const voteExpectations = voteDefinitions.map((definition, index) => ({
    id: voteIds[index]!, reportId: definition.reportId, voterUserId: definition.voterUserId, stage: definition.stage,
  }));
  const ledger = [
    ...reports.map((report) => ({
      userId: report.authorUserId, kind: 'REPORT_INITIAL', delta: POLICY.reporterInitialRp,
      sourceRef: 'report-initial:' + report.id, reportId: report.id, voteId: null,
    })),
    ...voteExpectations.map((vote) => ({
      userId: vote.voterUserId, kind: 'VOTE', delta: POLICY.voteRp,
      sourceRef: 'vote:' + vote.id, reportId: vote.reportId, voteId: vote.id,
    })),
    { userId: users[0]!, kind: 'REPORT_FINAL', delta: POLICY.reporterFinalRp,
      sourceRef: 'report-final:' + reportIds[0]!, reportId: reportIds[0]!, voteId: null },
    { userId: users[3]!, kind: 'CLEANUP', delta: POLICY.cleanerRp,
      sourceRef: 'cleanup-final:' + reportIds[0]!, reportId: reportIds[0]!, voteId: null },
  ];
  const idempotencyKeys = [
    ...reports.map((report, index) => ({
      userId: report.authorUserId, operation: 'REPORT_PUBLICATION',
      key: '', resourceId: report.id, responseStatus: 201,
      label: 'publish/' + ['green-resolved', 'yellow-pending', 'red-pending'][index]!,
    })),
    ...voteDefinitions.map((vote, index) => ({
      userId: vote.voterUserId, operation: 'REPORT_VOTE',
      key: '', resourceId: voteIds[index]!, responseStatus: 200, label: vote.label,
    })),
    { userId: users[3]!, operation: 'CLEANUP_SUBMISSION', key: '', resourceId: cleanupIds[0]!, responseStatus: 201, label: 'cleanup/green-resolved' },
  ];
  for (const item of idempotencyKeys) {
    item.key = await stableUuid('idempotency/' + item.label);
  }
  idempotencyKeys.push({
    userId: users[0]!, operation: DEMO_MARKER_OPERATION, key: DEMO_MARKER_KEY,
    resourceId: reportIds[0]!, responseStatus: 200, label: 'seed-marker',
  });
  const notifications = [
    { reportId: reportIds[0]!, userId: users[0]!, kind: 'EXISTENCE_VERIFIED' },
    { reportId: reportIds[0]!, userId: users[0]!, kind: 'REPORT_RESOLVED' },
  ];
  return {
    reporterId: DEMO_SEED_USER_IDS[0]!,
    userIds: DEMO_SEED_USER_IDS,
    reportIds,
    analysisIds,
    cleanupIds,
    voteIds,
    photoIds,
    objectKeys,
    reports,
    analyses,
    leases,
    cleanups,
    photos,
    votes: voteExpectations,
    ledger,
    notifications,
    idempotencyKeys,
  };
}

function parsePendingObjectKeys(value: unknown, expectedKeys: readonly string[]): readonly string[] | null {
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
  assertDemoObjectKeys(keys, expectedKeys);
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
  const pendingObjectKeys = parsePendingObjectKeys(marker?.response_body ?? null, manifest.objectKeys);
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
  const leases = await client.query<{ current_analysis_id: string; owner_user_id: string; kind: string; input_hash: string }>(
    'SELECT current_analysis_id, owner_user_id, kind, input_hash FROM analysis_leases '
      + 'WHERE owner_user_id = ANY($1::text[]) OR current_analysis_id = ANY($2::uuid[]) '
      + 'ORDER BY current_analysis_id',
    [manifest.userIds, manifest.analysisIds],
  );
  const cleanups = await client.query<{
    id: string; report_id: string; cleaner_user_id: string; analysis_id: string; is_demo: boolean;
  }>(
    'SELECT id, report_id, cleaner_user_id, analysis_id, is_demo FROM cleanup_submissions '
      + 'WHERE id = ANY($1::uuid[]) OR report_id = ANY($2::uuid[]) '
      + 'OR cleaner_user_id = ANY($3::text[]) ORDER BY id',
    [manifest.cleanupIds, manifest.reportIds, manifest.userIds],
  );
  const photos = await client.query<{
    id: string; owner_user_id: string; report_id: string | null; cleanup_id: string | null;
    object_key: string; purpose: string; byte_size: number; sha256: string;
  }>(
    'SELECT id, owner_user_id, report_id, cleanup_id, object_key, purpose, byte_size, sha256 FROM report_photos '
      + 'WHERE owner_user_id = ANY($1::text[]) OR report_id = ANY($2::uuid[]) '
      + 'OR cleanup_id = ANY($3::uuid[]) ORDER BY object_key',
    [manifest.userIds, manifest.reportIds, manifest.cleanupIds],
  );
  const votes = await client.query<{
    id: string; report_id: string; voter_user_id: string; stage: string; choice: string; is_demo: boolean;
  }>(
    'SELECT id, report_id, voter_user_id, stage, choice, is_demo FROM votes '
      + 'WHERE report_id = ANY($1::uuid[]) OR voter_user_id = ANY($2::text[]) ORDER BY id',
    [manifest.reportIds, manifest.userIds],
  );
  const ledger = await client.query<{
    report_id: string | null; user_id: string; is_demo: boolean; kind: string; delta: number;
    source_ref: string; vote_id: string | null;
  }>(
    'SELECT report_id, user_id, is_demo, kind, delta, source_ref, vote_id FROM reward_ledger '
      + 'WHERE report_id = ANY($1::uuid[]) OR user_id = ANY($2::text[]) OR vote_id = ANY($3::uuid[]) ORDER BY id',
    [manifest.reportIds, manifest.userIds, manifest.voteIds],
  );
  const notifications = await client.query<{ report_id: string; user_id: string; kind: string }>(
    'SELECT report_id, user_id, kind FROM notifications '
      + 'WHERE report_id = ANY($1::uuid[]) OR user_id = ANY($2::text[]) ORDER BY id',
    [manifest.reportIds, manifest.userIds],
  );
  const idempotency = await client.query<{
    user_id: string; operation: string; key: string; resource_id: string | null; response_status: number | null;
  }>(
    'SELECT user_id, operation, key, resource_id, response_status FROM idempotency_keys '
      + 'WHERE user_id = ANY($1::text[]) ORDER BY user_id, operation, key', [manifest.userIds],
  );

  const artifactCounts = [users.rows.length, reports.rows.length, analyses.rows.length, leases.rows.length,
    cleanups.rows.length, photos.rows.length, votes.rows.length, ledger.rows.length, notifications.rows.length];
  const noArtifacts = artifactCounts.every((count) => count === 0);
  if (!marker && noArtifacts && idempotency.rows.length === 0) {
    return { ...manifest, alreadyReset: true, pendingObjectKeys: null, objectKeys: [], photoIds: [] };
  }
  if (!marker) fail('Seed data exists without its completion marker; refusing partial reset.');
  if (noArtifacts) fail('Demo seed marker exists but its dataset is missing; refusing reset.');

  requireThat(users.rows.every((row) => row.is_demo), 'A reserved seed user is not marked demo; refusing deletion.');
  requireThat(reports.rows.length === manifest.reports.length && reports.rows.every((row) => {
    const expected = manifest.reports.find((item) => item.id === row.id);
    return expected?.authorUserId === row.author_user_id && row.is_demo;
  }),
    'A non-demo or unknown report is attached to the seed; refusing to delete foreign data.');
  requireThat(analyses.rows.length === manifest.analyses.length && analyses.rows.every((row) => {
    const expected = manifest.analyses.find((item) => item.id === row.id);
    return expected?.ownerUserId === row.owner_user_id && expected.reportId === row.report_id && row.is_demo;
  }),
  'A non-demo or unknown analysis is attached to the seed; refusing to delete foreign data.');
  requireThat(leases.rows.length === manifest.leases.length && leases.rows.every((row) => manifest.leases.some((item) =>
    item.analysisId === row.current_analysis_id && item.ownerUserId === row.owner_user_id
      && item.kind === row.kind && item.inputHash === row.input_hash)),
    'An unknown analysis lease is attached to the seed; refusing deletion.');
  requireThat(cleanups.rows.length === manifest.cleanups.length && cleanups.rows.every((row) => manifest.cleanups.some((item) =>
    item.id === row.id && item.reportId === row.report_id && item.cleanerUserId === row.cleaner_user_id
      && item.analysisId === row.analysis_id) && row.is_demo),
  'A non-demo or unknown cleanup is attached to the seed; refusing to delete foreign data.');
  requireThat(photos.rows.length === manifest.photos.length && photos.rows.every((row) => manifest.photos.some((item) =>
    item.id === row.id && item.ownerUserId === row.owner_user_id && item.reportId === row.report_id
      && item.cleanupId === row.cleanup_id && item.objectKey === row.object_key && item.purpose === row.purpose
      && item.byteSize === row.byte_size && item.sha256 === row.sha256)),
  'A foreign or unlisted photo is attached to the seed; refusing deletion.');
  const objectKeys = photos.rows.map((row) => row.object_key).sort();
  assertDemoObjectKeys(objectKeys, manifest.objectKeys);
  requireThat(votes.rows.length === manifest.votes.length && votes.rows.every((row) => manifest.votes.some((item) =>
    item.id === row.id && item.reportId === row.report_id && item.voterUserId === row.voter_user_id
      && item.stage === row.stage) && row.choice === 'YES' && row.is_demo),
  'A non-demo or unknown vote is attached to the seed; refusing to delete foreign data.');
  requireThat(ledger.rows.length === manifest.ledger.length && ledger.rows.every((row) => manifest.ledger.some((item) =>
    item.reportId === row.report_id && item.userId === row.user_id && item.kind === row.kind
      && item.delta === row.delta && item.sourceRef === row.source_ref && item.voteId === row.vote_id) && row.is_demo),
  'A non-demo or unknown ledger entry is attached to the seed; refusing to delete foreign data.');
  requireThat(notifications.rows.length === manifest.notifications.length && notifications.rows.every((row) => manifest.notifications.some((item) =>
    item.reportId === row.report_id && item.userId === row.user_id && item.kind === row.kind)),
    'A notification for a foreign user is attached to the seed; refusing deletion.');
  requireThat(idempotency.rows.length === manifest.idempotencyKeys.length && idempotency.rows.every((row) => manifest.idempotencyKeys.some((item) =>
    item.userId === row.user_id && item.operation === row.operation && item.key === row.key
      && item.resourceId === row.resource_id && item.responseStatus === row.response_status)),
    'An unknown idempotency row is attached to the seed; refusing deletion.');

  const pending = pendingObjectKeys !== null;
  if (!noArtifacts) {
    const complete = users.rows.length === DEMO_SEED_USER_IDS.length
      && reports.rows.length === 3 && analyses.rows.length === 4 && leases.rows.length === 4
      && cleanups.rows.length === 1 && photos.rows.length === manifest.photos.length
      && votes.rows.length === manifest.votes.length && ledger.rows.length === manifest.ledger.length
      && notifications.rows.length === manifest.notifications.length
      && idempotency.rows.length === manifest.idempotencyKeys.length;
    requireThat(complete, 'Demo seed data is partial or contains attached foreign rows; refusing reset.');
  }

  if (pending && photos.rows.length > 0) {
    requireThat(sameKeys(objectKeys, pendingObjectKeys!), 'Demo seed photos changed during reset; rerun after inspection.');
  }
  return {
    ...manifest,
    alreadyReset: false,
    pendingObjectKeys,
    objectKeys: pending ? pendingObjectKeys : objectKeys,
    photoIds: manifest.photoIds,
  };
}

async function lockDemoSeed(client: CheckedOutClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [DEMO_SEED_LOCK_KEY]);
}

/** Lock the seeded FK parents and their known children before preflight and hold them across local R2 deletion. */
async function lockSeedRows(client: CheckedOutClient, manifest: SeedManifest): Promise<void> {
  // Match the domain write order: idempotent services first reference an actor, then lock a report.
  await client.query('SELECT id FROM users WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [manifest.userIds]);
  await client.query('SELECT id FROM reports WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [manifest.reportIds]);
  await client.query('SELECT id FROM ai_analyses WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [manifest.analysisIds]);
  await client.query('SELECT id FROM cleanup_submissions WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [manifest.cleanupIds]);
  await client.query('SELECT id FROM votes WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [manifest.voteIds]);
  await client.query(
    'SELECT current_analysis_id FROM analysis_leases WHERE owner_user_id = ANY($1::text[]) '
      + 'OR current_analysis_id = ANY($2::uuid[]) ORDER BY current_analysis_id FOR UPDATE',
    [manifest.userIds, manifest.analysisIds],
  );
  await client.query(
    'SELECT id FROM report_photos WHERE owner_user_id = ANY($1::text[]) '
      + 'OR report_id = ANY($2::uuid[]) OR cleanup_id = ANY($3::uuid[]) ORDER BY id FOR UPDATE',
    [manifest.userIds, manifest.reportIds, manifest.cleanupIds],
  );
  await client.query(
    'SELECT id FROM reward_ledger WHERE report_id = ANY($1::uuid[]) '
      + 'OR user_id = ANY($2::text[]) OR vote_id = ANY($3::uuid[]) ORDER BY id FOR UPDATE',
    [manifest.reportIds, manifest.userIds, manifest.voteIds],
  );
  await client.query(
    'SELECT id FROM notifications WHERE report_id = ANY($1::uuid[]) '
      + 'OR user_id = ANY($2::text[]) ORDER BY id FOR UPDATE',
    [manifest.reportIds, manifest.userIds],
  );
  await client.query(
    'SELECT user_id, operation, key FROM idempotency_keys WHERE user_id = ANY($1::text[]) '
      + 'ORDER BY user_id, operation, key FOR UPDATE',
    [manifest.userIds],
  );
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
      + 'UNION ALL SELECT 1 FROM analysis_leases WHERE owner_user_id = ANY($1::text[]) '
        + 'OR current_analysis_id = ANY($3::uuid[]) '
      + 'UNION ALL SELECT 1 FROM cleanup_submissions WHERE id = ANY($4::uuid[]) '
        + 'OR report_id = ANY($2::uuid[]) OR cleaner_user_id = ANY($1::text[]) '
      + 'UNION ALL SELECT 1 FROM votes WHERE id = ANY($5::uuid[]) '
        + 'OR report_id = ANY($2::uuid[]) OR voter_user_id = ANY($1::text[]) '
      + 'UNION ALL SELECT 1 FROM reward_ledger WHERE report_id = ANY($2::uuid[]) '
        + 'OR user_id = ANY($1::text[]) OR vote_id = ANY($5::uuid[]) '
      + 'UNION ALL SELECT 1 FROM notifications WHERE report_id = ANY($2::uuid[]) OR user_id = ANY($1::text[]) '
      + 'UNION ALL SELECT 1 FROM report_photos WHERE id = ANY($6::uuid[]) '
        + 'OR owner_user_id = ANY($1::text[]) OR report_id = ANY($2::uuid[]) OR cleanup_id = ANY($4::uuid[]) '
        + 'OR object_key = ANY($7::varchar[]) '
      + 'UNION ALL SELECT 1 FROM idempotency_keys WHERE user_id = ANY($1::text[])'
      + ') AS present',
    [manifest.userIds, manifest.reportIds, manifest.analysisIds, manifest.cleanupIds, manifest.voteIds,
      manifest.photoIds, manifest.objectKeys],
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

  return database.withTransaction(async (client) => {
    await lockDemoSeed(client);
    await lockSeedRows(client, manifest);
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

    assertDemoObjectKeys(current.objectKeys, manifest.objectKeys);
    if (current.objectKeys.length > 0) await objectStore.deleteObjectKeys(current.objectKeys);

    // Keep the FK locks while checking the exact manifest again and deleting its DB rows.
    const lockedPlan = await loadResetPlan(client, manifest);
    requireThat(!lockedPlan.alreadyReset && lockedPlan.pendingObjectKeys !== null
      && sameKeys(lockedPlan.objectKeys, current.objectKeys)
      && sameKeys(lockedPlan.photoIds, manifest.photoIds),
    'Demo reset manifest changed while removing objects; database rows were not deleted.');

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
        'DELETE FROM reward_ledger WHERE source_ref = ANY($1::varchar[]) AND is_demo = true',
        [manifest.ledger.map((item) => item.sourceRef)]),
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
    hasPassword: Boolean(url.password),
    hasSearch: Boolean(url.search),
    hasHash: Boolean(url.hash),
    password: decodeURIComponent(url.password),
  };
}

export function createWranglerObjectStore(
  bucket: string,
  localPersistPath = fileURLToPath(new URL('../.wrangler/state', import.meta.url)),
): DemoObjectStore {
  assertDemoResetBucket(bucket);
  const wranglerCli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
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
