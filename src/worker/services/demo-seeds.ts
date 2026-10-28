import {
  CleanupAssessmentSchema,
  POLICY,
  ReportAnalysisContextSchema,
  ReportAssessmentSchema,
  type Location,
} from '../../shared/contracts';
import type { TransactionDatabase, CheckedOutClient } from '../db/client';
import { PostgresCleanupSubmissionService } from './cleanup';
import { PostgresImpactService } from './impact';
import { PostgresReportPublicationService } from './publication';
import { hashBeforeEvidence, type ReportMediaResolver } from './report-context';
import { PostgresReportVotingService } from './voting';

export const DEMO_SCHEMA_VERSION = 1;
export const DEMO_MARKER_OPERATION = 'DEMO_SEED';
export const DEMO_MARKER_KEY = 'seed-v1';
export const DEMO_SEED_LOCK_KEY = 'iskra-demo-seed-v1';
export const DEMO_SEED_USER_PREFIX = 'iskra-demo-seed:v1:';
export const DEMO_SEED_OBJECT_PREFIX = 'demo-fixtures/seed-v1/';
const MODEL_ID = 'demo-recorded-fixture-v1';
const PROMPT_VERSION = 'demo-seed-v1';
const UUID_NAMESPACE = '6ba7b8109dad11d180b400c04fd430c8';
export const DEMO_SEED_REQUEST_HASH = 'demo-seed-v1:reporter-20:verifier-5:cleaner-40:green-5-existence-3-resolution';

export interface DemoSeedTarget {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly hasPassword: boolean;
  readonly hasSearch: boolean;
  readonly hasHash: boolean;
  readonly appEnvironment: string | undefined;
  readonly demoData: string | undefined;
}

/** The seed CLI is intentionally limited to the loopback disposable database used by the test harness. */
export function assertDemoSeedTarget(target: DemoSeedTarget): void {
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['127.0.0.1', 'localhost'].includes(target.hostname.toLowerCase())
    || !Number.isInteger(target.port) || target.port < 1 || target.port > 65_535
    || target.database !== 'iskra_test' || target.user !== 'iskra_test'
    || target.hasPassword || target.hasSearch || target.hasHash
    || target.appEnvironment !== 'demo' || target.demoData !== 'true') {
    throw new Error('Demo seeding requires APP_ENV=demo, DEMO_DATA=true, and the password-free loopback iskra_test test fixture.');
  }
}

export interface DemoPhotoFixture {
  readonly byteSize: number;
  readonly sha256: string;
}

export interface DemoSeedPhotoObjectKeys {
  readonly greenBefore: string;
  readonly yellowBefore: string;
  readonly redBefore: string;
  readonly greenAfter: string;
}

export function demoSeedPhotoObjectKeys(sha256: string): DemoSeedPhotoObjectKeys {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('The controlled demo photo hash is invalid.');
  return {
    greenBefore: `${OBJECT_PREFIX}green-resolved/before-${sha256}.jpg`,
    yellowBefore: `${OBJECT_PREFIX}yellow-pending/before-${sha256}.jpg`,
    redBefore: `${OBJECT_PREFIX}red-pending/before-${sha256}.jpg`,
    greenAfter: `${OBJECT_PREFIX}green-resolved/after-${sha256}.jpg`,
  };
}

export interface DemoSeedResult {
  readonly alreadySeeded: boolean;
  readonly reports: { readonly greenResolved: string; readonly yellowPending: string; readonly redPending: string };
  readonly snapshots: {
    readonly reporterTotalRp: number;
    readonly reporterBalanceRp: number;
    readonly initialRp: number;
    readonly verifierBalanceRp: number;
    readonly cleanerRp: number;
    readonly cleanerBalanceRp: number;
    readonly existenceYesCount: number;
    readonly resolutionYesCount: number;
  };
}

const userIds = {
  reporterGreen: `${DEMO_SEED_USER_PREFIX}reporter-resolved`,
  reporterYellow: `${DEMO_SEED_USER_PREFIX}reporter-yellow`,
  reporterRed: `${DEMO_SEED_USER_PREFIX}reporter-red`,
  cleaner: `${DEMO_SEED_USER_PREFIX}cleaner-green`,
  existence: Array.from({ length: 5 }, (_, index) => `${DEMO_SEED_USER_PREFIX}existence-voter-${index + 1}`),
  resolution: Array.from({ length: 3 }, (_, index) => `${DEMO_SEED_USER_PREFIX}resolution-voter-${index + 1}`),
  yellow: Array.from({ length: 2 }, (_, index) => `${DEMO_SEED_USER_PREFIX}yellow-voter-${index + 1}`),
};

const allUserIds = [
  userIds.reporterGreen,
  userIds.reporterYellow,
  userIds.reporterRed,
  userIds.cleaner,
  ...userIds.existence,
  ...userIds.resolution,
  ...userIds.yellow,
];

export const DEMO_SEED_USER_IDS: readonly string[] = Object.freeze([...allUserIds]);

export async function stableUuid(label: string): Promise<string> {
  const namespace = Uint8Array.from(UUID_NAMESPACE.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)));
  const name = new TextEncoder().encode(`swofart.iskra.${label}`);
  const bytes = new Uint8Array(namespace.length + name.length);
  bytes.set(namespace);
  bytes.set(name, namespace.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
  const uuid = digest.slice(0, 16);
  uuid[6] = (uuid[6] & 0x0f) | 0x50;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  const hex = [...uuid].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function assertMarkedDemoSchema(client: CheckedOutClient): Promise<void> {
  let marker;
  try {
    marker = await client.query<{
      environment: string;
      database_name: string;
      database_user: string;
      schema_name: string;
      schema_version: number;
    }>(
      `SELECT environment, database_name, database_user, schema_name, schema_version
       FROM demo_seed_metadata WHERE singleton = true`,
    );
  } catch {
    throw new Error('Demo seed metadata is missing; refuse to seed an unmarked database schema.');
  }
  const identity = await client.query<{ database_name: string; database_user: string; schema_name: string }>(
    `SELECT current_database() AS database_name, current_user AS database_user,
       current_schema() AS schema_name`,
  );
  const actual = identity.rows[0];
  const expected = marker.rows[0];
  if (!actual || !expected
    || expected.environment !== 'demo'
    || expected.schema_version !== DEMO_SCHEMA_VERSION
    || actual.database_name !== 'iskra_test'
    || actual.database_user !== 'iskra_test'
    || actual.database_name !== expected.database_name
    || actual.database_user !== expected.database_user
    || actual.schema_name !== expected.schema_name
    || !/^(?:iskra_demo_seed|iskra_test_[0-9a-f]{32})$/.test(actual.schema_name)) {
    throw new Error('Demo seed database identity does not match the expected marked sandbox.');
  }
}

function fixtureLocation(): Location {
  return {
    lat: 49.14,
    lng: 9.22,
    accuracyM: 10,
    observedAt: new Date().toISOString(),
  };
}

function makeAssessment(route: 'GREEN' | 'YELLOW' | 'RED', score: number) {
  return ReportAssessmentSchema.parse({
    decision: 'ACCEPT',
    route,
    description: `DEMO FIXTURE ONLY — controlled ${route.toLowerCase()} example.`,
    hazardLevel: route === 'RED' ? 'URGENT' : 'NONE',
    safetyMessage: route === 'RED' ? 'DEMO ONLY: do not treat this recorded fixture as a live hazard.' : '',
    reason: 'Recorded deterministic demonstration result; no live AI call was made.',
    confidence: score,
  });
}

function createMediaResolver(): ReportMediaResolver {
  return {
    async resolveAttachedPhotos(photos) {
      return photos.map((photo) => ({
        id: photo.id,
        ordinal: photo.ordinal,
        mediaUrl: `https://demo.invalid/${photo.id}`,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }));
    },
  };
}

async function createReportAnalysis(
  client: CheckedOutClient,
  key: 'green-resolved' | 'yellow-pending' | 'red-pending',
  ownerId: string,
  route: 'GREEN' | 'YELLOW' | 'RED',
  confidence: number,
  photo: DemoPhotoFixture,
  objectKey: string,
) {
  const analysisId = await stableUuid(`analysis/report/${key}`);
  const photoId = await stableUuid(`photo/report/${key}/before`);
  const inputHash = `demo-seed-v1/report/${key}`;
  const location = fixtureLocation();
  const photoIds = [photoId];
  const context = ReportAnalysisContextSchema.parse({
    comment: 'DEMO FIXTURE ONLY — synthetic controlled JPEG; recorded AI result, not a live assessment.',
    measuredLocation: location,
    pin: { lat: location.lat, lng: location.lng },
    cityId: 'heilbronn',
    outputLocale: 'en',
  });

  await client.query(
    `INSERT INTO report_photos (
       id, owner_user_id, purpose, state, object_key, ordinal, mime_type, byte_size, sha256, upload_expires_at
     ) VALUES ($1::uuid, $2::text, 'REPORT', 'UPLOADED', $3::varchar, 0, 'image/jpeg', $4::integer,
       $5::char(64), clock_timestamp() + interval '15 minutes')`,
    [photoId, ownerId, objectKey, photo.byteSize, photo.sha256],
  );
  await client.query(
    `INSERT INTO ai_analyses (
       id, owner_user_id, kind, status, input_hash, photo_ids, context, result, model_id, prompt_version,
       expires_at, is_demo
     ) VALUES ($1::uuid, $2::text, 'REPORT', 'READY', $3::varchar, $4::jsonb, $5::jsonb, $6::jsonb,
       $7::varchar, $8::varchar, clock_timestamp() + interval '15 minutes', false)`,
    [analysisId, ownerId, inputHash, JSON.stringify(photoIds), JSON.stringify(context),
      JSON.stringify(makeAssessment(route, confidence)), MODEL_ID, PROMPT_VERSION],
  );
  await client.query(
    `INSERT INTO analysis_leases (owner_user_id, kind, input_hash, current_analysis_id, lease_until)
     VALUES ($1::text, 'REPORT', $2::varchar, $3::uuid, clock_timestamp() + interval '15 minutes')`,
    [ownerId, inputHash, analysisId],
  );
  return { analysisId, photoId, reportId: await stableUuid(`report/${key}`) };
}

async function addYesVote(
  voting: PostgresReportVotingService,
  reportId: string,
  stage: 'EXISTENCE' | 'RESOLUTION',
  voterId: string,
  key: string,
) {
  const voteId = await stableUuid(`vote/${key}`);
  await voting.vote(voterId, await stableUuid(`idempotency/${key}`), reportId, {
    stage,
    choice: 'YES',
    location: fixtureLocation(),
  }, { deterministicVoteId: voteId });
}

async function createCleanupCandidate(
  client: CheckedOutClient,
  reportId: string,
  cleanerId: string,
  beforePhotoId: string,
  photo: DemoPhotoFixture,
  objectKey: string,
) {
  const analysisId = await stableUuid('analysis/cleanup/green-resolved');
  const photoId = await stableUuid('photo/cleanup/green-resolved/after');
  const inputHash = 'demo-seed-v1/cleanup/green-resolved';
  const location = fixtureLocation();
  const beforeEvidenceHash = await hashBeforeEvidence([{
    id: beforePhotoId,
    ordinal: 0,
    sha256: photo.sha256,
  }]);
  const context = {
    reportContext: {
      reportId,
      route: 'GREEN',
      status: 'VERIFIED',
      beforeEvidenceHash,
    },
    location,
  };
  const result = CleanupAssessmentSchema.parse({
    decision: 'ACCEPT',
    sameScene: 'LIKELY',
    appearsClean: true,
    hazardRemaining: false,
    reason: 'DEMO FIXTURE ONLY — controlled after-photo; no live AI assessment was made.',
    confidence: 0.95,
  });

  await client.query(
    `INSERT INTO report_photos (
       id, owner_user_id, purpose, state, object_key, ordinal, mime_type, byte_size, sha256, upload_expires_at
     ) VALUES ($1::uuid, $2::text, 'CLEANUP', 'UPLOADED', $3::varchar, 0, 'image/jpeg', $4::integer,
       $5::char(64), clock_timestamp() + interval '15 minutes')`,
    [photoId, cleanerId, objectKey, photo.byteSize, photo.sha256],
  );
  await client.query(
    `INSERT INTO ai_analyses (
       id, owner_user_id, kind, status, report_id, input_hash, photo_ids, context, result, model_id,
       prompt_version, expires_at, is_demo
     ) VALUES ($1::uuid, $2::text, 'CLEANUP', 'READY', $3::uuid, $4::varchar, $5::jsonb, $6::jsonb,
       $7::jsonb, $8::varchar, $9::varchar, clock_timestamp() + interval '15 minutes', false)`,
    [analysisId, cleanerId, reportId, inputHash, JSON.stringify([photoId]), JSON.stringify(context),
      JSON.stringify(result), MODEL_ID, PROMPT_VERSION],
  );
  await client.query(
    `INSERT INTO analysis_leases (owner_user_id, kind, input_hash, current_analysis_id, lease_until)
     VALUES ($1::text, 'CLEANUP', $2::varchar, $3::uuid, clock_timestamp() + interval '15 minutes')`,
    [cleanerId, inputHash, analysisId],
  );
  return { analysisId, photoId, cleanupId: await stableUuid('cleanup/green-resolved') };
}

async function assertNoPartialSeed(client: CheckedOutClient, reportIds: readonly string[]): Promise<void> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM users WHERE id = ANY($1::text[])
       UNION ALL SELECT 1 FROM reports WHERE id = ANY($2::uuid[])
       UNION ALL SELECT 1 FROM report_photos WHERE object_key LIKE $3::varchar
       UNION ALL SELECT 1 FROM reward_ledger WHERE source_ref LIKE 'demo-seed:v1:%'
     ) AS present`,
    [allUserIds, reportIds, `${DEMO_SEED_OBJECT_PREFIX}%`],
  );
  if (result.rows[0]?.present) {
    throw new Error('Reserved demo seed data exists without its completion marker; refusing to overwrite it.');
  }
}

async function verifyDemoSeed(
  database: TransactionDatabase,
  client: CheckedOutClient,
  reportIds: { greenResolved: string; yellowPending: string; redPending: string },
  photo: DemoPhotoFixture,
): Promise<DemoSeedResult['snapshots']> {
  const reports = await client.query<{
    id: string;
    route: string;
    status: string;
    existence_yes_count: number;
    resolution_yes_count: number;
    reporter_total_rp: number;
    initial_rp: number;
    cleaner_rp: number;
    is_demo: boolean;
    before_photos: number;
    after_photos: number;
    report_earned: number;
    cleanup_earned: number;
  }>(
    `SELECT r.id, r.route, r.status, r.existence_yes_count, r.resolution_yes_count,
       r.reporter_total_rp, r.initial_rp, r.cleaner_rp, r.is_demo,
       (SELECT count(*)::int FROM report_photos p WHERE p.report_id = r.id
          AND p.purpose = 'REPORT' AND p.state = 'ATTACHED') AS before_photos,
       (SELECT count(*)::int FROM report_photos p WHERE p.cleanup_id = cleanup.id
          AND p.purpose = 'CLEANUP' AND p.state = 'ATTACHED') AS after_photos,
       (SELECT COALESCE(sum(l.delta), 0)::int FROM reward_ledger l WHERE l.report_id = r.id
          AND l.user_id = r.author_user_id AND l.kind IN ('REPORT_INITIAL', 'REPORT_FINAL')) AS report_earned,
       (SELECT COALESCE(sum(l.delta), 0)::int FROM reward_ledger l WHERE l.report_id = r.id
          AND l.user_id = cleanup.cleaner_user_id AND l.kind = 'CLEANUP') AS cleanup_earned
     FROM reports r
     LEFT JOIN cleanup_submissions cleanup ON cleanup.report_id = r.id
     WHERE r.id = ANY($1::uuid[])
     ORDER BY r.id`,
    [[reportIds.greenResolved, reportIds.yellowPending, reportIds.redPending]],
  );
  const byId = new Map(reports.rows.map((row) => [row.id, row]));
  const green = byId.get(reportIds.greenResolved);
  const yellow = byId.get(reportIds.yellowPending);
  const red = byId.get(reportIds.redPending);
  if (reports.rows.length !== 3 || !green || !yellow || !red
    || green.route !== 'GREEN' || green.status !== 'RESOLVED' || !green.is_demo
    || green.existence_yes_count !== 5 || green.resolution_yes_count !== 3
    || green.reporter_total_rp !== POLICY.reporterTotalRp
    || green.initial_rp !== POLICY.reporterInitialRp || green.cleaner_rp !== POLICY.cleanerRp
    || green.before_photos !== 1 || green.after_photos !== 1
    || green.report_earned !== 20 || green.cleanup_earned !== 40
    || yellow.route !== 'YELLOW' || yellow.status !== 'AWAITING_EXISTENCE'
    || yellow.existence_yes_count !== 2 || !yellow.is_demo
    || red.route !== 'RED' || red.status !== 'AWAITING_EXISTENCE'
    || red.existence_yes_count !== 0 || !red.is_demo) {
    throw new Error('Demo seed lifecycle or 20/5/40 report award snapshots failed verification.');
  }

  const votes = await client.query<{ stage: string; voter_user_id: string; is_demo: boolean }>(
    `SELECT stage, voter_user_id, is_demo FROM votes WHERE report_id = $1::uuid ORDER BY stage, voter_user_id`,
    [reportIds.greenResolved],
  );
  const existenceRoster = votes.rows.filter((row) => row.stage === 'EXISTENCE').map((row) => row.voter_user_id);
  const resolutionRoster = votes.rows.filter((row) => row.stage === 'RESOLUTION').map((row) => row.voter_user_id);
  if (existenceRoster.length !== 5 || resolutionRoster.length !== 3
    || votes.rows.some((row) => !row.is_demo)
    || existenceRoster.some((id) => resolutionRoster.includes(id))) {
    throw new Error('Demo seed stage-specific vote roster is not distinct or not marked.');
  }

  const balances = await client.query<{ id: string; rp_balance: number; ledger_balance: number; is_demo: boolean }>(
    `SELECT u.id, u.rp_balance, COALESCE(sum(l.delta), 0)::int AS ledger_balance, u.is_demo
     FROM users u LEFT JOIN reward_ledger l ON l.user_id = u.id
     WHERE u.id = ANY($1::text[]) GROUP BY u.id ORDER BY u.id`,
    [allUserIds],
  );
  const balanceById = new Map(balances.rows.map((row) => [row.id, row]));
  if (balances.rows.length !== allUserIds.length
    || balances.rows.some((row) => !row.is_demo || row.rp_balance !== row.ledger_balance)) {
    throw new Error('Demo seed account balances do not reconcile to their append-only ledger.');
  }
  const reporter = balanceById.get(userIds.reporterGreen);
  const cleaner = balanceById.get(userIds.cleaner);
  const verifier = balanceById.get(userIds.existence[0]);
  if (reporter?.rp_balance !== 20 || cleaner?.rp_balance !== 40 || verifier?.rp_balance !== 5) {
    throw new Error('Demo seed reporter/verifier/cleaner balances do not match the 20/5/40 snapshot.');
  }

  const demoRows = await client.query<{ analyses: number; photos: number; object_keys: string[] | null; ledger: number }>(
    `SELECT
       (SELECT count(*)::int FROM ai_analyses WHERE owner_user_id = ANY($1::text[])
         AND is_demo = true AND model_id = $2::varchar AND prompt_version = $3::varchar) AS analyses,
       (SELECT count(*)::int FROM report_photos WHERE object_key LIKE $4::varchar
         AND byte_size = $5::integer AND sha256 = $6::char(64)) AS photos,
       (SELECT array_agg(object_key ORDER BY object_key) FROM report_photos WHERE object_key LIKE $4::varchar
         AND byte_size = $5::integer AND sha256 = $6::char(64)) AS object_keys,
       (SELECT count(*)::int FROM reward_ledger WHERE report_id = ANY($7::uuid[]) AND is_demo = true) AS ledger`,
    [allUserIds, MODEL_ID, PROMPT_VERSION, `${DEMO_SEED_OBJECT_PREFIX}%`, photo.byteSize, photo.sha256,
      [reportIds.greenResolved, reportIds.yellowPending, reportIds.redPending]],
  );
  if (demoRows.rows[0]?.analyses !== 4 || demoRows.rows[0]?.photos !== 4
    || demoRows.rows[0]?.ledger !== 15
    || JSON.stringify(demoRows.rows[0]?.object_keys ?? []) !== JSON.stringify(
      Object.values(demoSeedPhotoObjectKeys(photo.sha256)).sort(),
    )) {
    throw new Error('Demo AI labels, controlled photo fixture metadata, or demo ledger marks failed verification.');
  }

  const impact = await new PostgresImpactService(database).get(userIds.reporterGreen);
  if (impact.reporter.created !== 0 || impact.verification.acceptedVotes !== 0
    || impact.totals.earnedRp !== 0 || impact.items.length !== 0
    || impact.totals.balanceRp !== 20) {
    throw new Error('Demo seed data leaked into real Impact earnings or failed its account balance projection.');
  }

  return {
    reporterTotalRp: green.reporter_total_rp,
    reporterBalanceRp: reporter.rp_balance,
    initialRp: green.initial_rp,
    verifierBalanceRp: verifier.rp_balance,
    cleanerRp: green.cleaner_rp,
    cleanerBalanceRp: cleaner.rp_balance,
    existenceYesCount: green.existence_yes_count,
    resolutionYesCount: green.resolution_yes_count,
  };
}

/**
 * Creates one deterministic, visibly synthetic showcase set in a marked sandbox.
 * Every lifecycle mutation is performed by the same publication, vote and cleanup
 * services used by the Worker. The single outer transaction keeps temporary live
 * provenance invisible; all generated rows are marked demo before commit.
 */
export class PostgresDemoSeedService {
  constructor(
    private readonly database: TransactionDatabase,
    private readonly media: ReportMediaResolver,
    private readonly photo: DemoPhotoFixture,
  ) {}

  async seed(): Promise<DemoSeedResult> {
    if (!Number.isInteger(this.photo.byteSize) || this.photo.byteSize < 1 || this.photo.byteSize > POLICY.maxPhotoBytes
      || !/^[0-9a-f]{64}$/.test(this.photo.sha256)) {
      throw new Error('The controlled demo photo fixture metadata is invalid.');
    }
    const reportIds = {
      greenResolved: await stableUuid('report/green-resolved'),
      yellowPending: await stableUuid('report/yellow-pending'),
      redPending: await stableUuid('report/red-pending'),
    };
    const photoKeys = demoSeedPhotoObjectKeys(this.photo.sha256);
    const requestHash = 'demo-seed-v1:reporter-20:verifier-5:cleaner-40:green-5-existence-3-resolution';

    return this.database.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [DEMO_SEED_LOCK_KEY]);
      await assertMarkedDemoSchema(client);
      const marker = await client.query<{
        request_hash: string;
        resource_id: string | null;
        response_body: unknown;
      }>(
        `SELECT request_hash, resource_id, response_body FROM idempotency_keys
         WHERE user_id = $1::text AND operation = $2::varchar AND key = $3::varchar`,
        [userIds.reporterGreen, DEMO_MARKER_OPERATION, DEMO_MARKER_KEY],
      );
      if (marker.rows[0]) {
        if (marker.rows[0].response_body !== null) {
          throw new Error('Demo seed reset is pending; complete the guarded reset before replaying the seed.');
        }
        if (marker.rows[0].request_hash !== DEMO_SEED_REQUEST_HASH
          || marker.rows[0].resource_id !== reportIds.greenResolved) {
          throw new Error('Demo seed marker conflicts with the current deterministic seed definition.');
        }
        const snapshots = await verifyDemoSeed(this.database, client, reportIds, this.photo);
        return { alreadySeeded: true, reports: reportIds, snapshots };
      }
      await assertNoPartialSeed(client, Object.values(reportIds));

      const names = [
        [userIds.reporterGreen, 'Demo reporter — resolved'],
        [userIds.reporterYellow, 'Demo reporter — Yellow pending'],
        [userIds.reporterRed, 'Demo reporter — Red pending'],
        [userIds.cleaner, 'Demo cleaner — verified'],
        ...userIds.existence.map((id, index) => [id, `Demo existence verifier ${index + 1}`]),
        ...userIds.resolution.map((id, index) => [id, `Demo resolution verifier ${index + 1}`]),
        ...userIds.yellow.map((id, index) => [id, `Demo Yellow verifier ${index + 1}`]),
      ] as const;
      for (const [id, nickname] of names) {
        await client.query(
          `INSERT INTO users (id, nickname, avatar_key, is_demo)
           VALUES ($1::text, $2::varchar, 'avatar-demo', true)`,
          [id, nickname],
        );
      }

      const green = await createReportAnalysis(
        client, 'green-resolved', userIds.reporterGreen, 'GREEN', 0.91, this.photo, photoKeys.greenBefore,
      );
      const yellow = await createReportAnalysis(
        client, 'yellow-pending', userIds.reporterYellow, 'YELLOW', 0.78, this.photo, photoKeys.yellowBefore,
      );
      const red = await createReportAnalysis(
        client, 'red-pending', userIds.reporterRed, 'RED', 0.84, this.photo, photoKeys.redBefore,
      );
      const scopedDatabase: TransactionDatabase = { withTransaction: (work) => work(client) };
      const publication = new PostgresReportPublicationService(scopedDatabase, this.media);
      await publication.publish(userIds.reporterGreen, await stableUuid('idempotency/publish/green-resolved'), {
        analysisId: green.analysisId,
        description: 'DEMO FIXTURE ONLY — green report shown after cleanup and verification.',
      }, { deterministicReportId: green.reportId });
      await publication.publish(userIds.reporterYellow, await stableUuid('idempotency/publish/yellow-pending'), {
        analysisId: yellow.analysisId,
        description: 'DEMO FIXTURE ONLY — Yellow route awaiting existence verification.',
      }, { deterministicReportId: yellow.reportId });
      await publication.publish(userIds.reporterRed, await stableUuid('idempotency/publish/red-pending'), {
        analysisId: red.analysisId,
        description: 'DEMO FIXTURE ONLY — Red hazard route awaiting existence verification.',
      }, { deterministicReportId: red.reportId });

      const voting = new PostgresReportVotingService(scopedDatabase, this.media);
      for (let index = 0; index < userIds.existence.length; index++) {
        await addYesVote(voting, green.reportId, 'EXISTENCE', userIds.existence[index]!, `green-existence-${index + 1}`);
      }
      for (let index = 0; index < userIds.yellow.length; index++) {
        await addYesVote(voting, yellow.reportId, 'EXISTENCE', userIds.yellow[index]!, `yellow-existence-${index + 1}`);
      }

      const cleanupCandidate = await createCleanupCandidate(
        client, green.reportId, userIds.cleaner, green.photoId, this.photo, photoKeys.greenAfter,
      );
      const cleanup = new PostgresCleanupSubmissionService(scopedDatabase, this.media);
      await cleanup.submit(userIds.cleaner, await stableUuid('idempotency/cleanup/green-resolved'), green.reportId, {
        analysisId: cleanupCandidate.analysisId,
      }, { deterministicCleanupId: cleanupCandidate.cleanupId });
      for (let index = 0; index < userIds.resolution.length; index++) {
        await addYesVote(voting, green.reportId, 'RESOLUTION', userIds.resolution[index]!, `green-resolution-${index + 1}`);
      }

      await client.query('UPDATE reports SET is_demo = true WHERE id = ANY($1::uuid[])', [Object.values(reportIds)]);
      await client.query('UPDATE ai_analyses SET is_demo = true WHERE owner_user_id = ANY($1::text[])', [allUserIds]);
      await client.query('UPDATE votes SET is_demo = true WHERE report_id = ANY($1::uuid[])', [Object.values(reportIds)]);
      await client.query('UPDATE cleanup_submissions SET is_demo = true WHERE report_id = ANY($1::uuid[])', [Object.values(reportIds)]);
      await client.query('UPDATE reward_ledger SET is_demo = true WHERE report_id = ANY($1::uuid[])', [Object.values(reportIds)]);

      const snapshots = await verifyDemoSeed(scopedDatabase, client, reportIds, this.photo);
      await client.query(
        `INSERT INTO idempotency_keys (user_id, operation, key, request_hash, resource_id, response_status)
         VALUES ($1::text, $2::varchar, $3::varchar, $4::varchar, $5::uuid, 200)`,
        [userIds.reporterGreen, DEMO_MARKER_OPERATION, DEMO_MARKER_KEY,
          DEMO_SEED_REQUEST_HASH, reportIds.greenResolved],
      );
      return { alreadySeeded: false, reports: reportIds, snapshots };
    });
  }
}
