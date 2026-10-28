import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep this as an operator CLI only. The loader is installed before importing Worker code,
// whose internal TypeScript modules use extensionless relative imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/i.test(specifier)) {
        try {
          return nextResolve(`${specifier}.ts`, context);
        } catch {
          throw error;
        }
      }
      throw error;
    }
  },
});

const [pgModule, dbModule, seedModule, voteModule, errorModule] = await Promise.all([
  import('pg'),
  import('../src/worker/db/client'),
  import('../src/worker/services/demo-seeds'),
  import('../src/worker/services/voting'),
  import('../src/worker/middleware/errors'),
]);

const { Pool } = pgModule;
const { PostgresTransactionDatabase } = dbModule;
const {
  assertDemoSeedTarget,
  assertMarkedDemoSchema,
  DEMO_MARKER_KEY,
  DEMO_MARKER_OPERATION,
  DEMO_SEED_LOCK_KEY,
  DEMO_SEED_REQUEST_HASH,
  DEMO_SEED_USER_IDS,
  acceleratedDemoVoteIdentityLabel,
  stableUuid,
} = seedModule;
const { PostgresReportVotingService } = voteModule;
const { ApiError } = errorModule;

type VoteStage = 'EXISTENCE' | 'RESOLUTION';
type VoteChoice = 'YES' | 'NO';

export interface AcceleratedVoteArguments {
  readonly reportId: string;
  readonly voterId: string;
  readonly stage: VoteStage;
  readonly choice: VoteChoice;
}

class DemoAcceleratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoAcceleratorError';
  }
}

function fail(message: string): never {
  throw new DemoAcceleratorError(message);
}

function uuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail(`${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

export function parseAcceleratedVoteArguments(args: readonly string[]): AcceleratedVoteArguments {
  const values = new Map<string, string>();
  let confirmed = false;
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--confirm-sandbox') {
      if (confirmed) fail('Duplicate --confirm-sandbox argument.');
      confirmed = true;
      continue;
    }
    if (!['--report-id', '--voter-id', '--stage', '--choice'].includes(name ?? '')) {
      fail('Only --report-id, --voter-id, --stage, --choice, and --confirm-sandbox are accepted.');
    }
    if (values.has(name!)) fail(`Duplicate ${name} argument.`);
    const value = args[++index];
    if (!value || value.startsWith('--')) fail(`${name} requires a value.`);
    values.set(name!, value);
  }

  if (!confirmed) fail('Explicit --confirm-sandbox confirmation is required.');
  const reportId = uuid(values.get('--report-id') ?? '', '--report-id');
  const voterId = values.get('--voter-id') ?? '';
  if (!DEMO_SEED_USER_IDS.includes(voterId)) {
    fail('--voter-id must be one of the reserved deterministic demo seed accounts.');
  }
  const stage = values.get('--stage');
  if (stage !== 'EXISTENCE' && stage !== 'RESOLUTION') fail('--stage must be EXISTENCE or RESOLUTION.');
  const choice = values.get('--choice');
  if (choice !== 'YES' && choice !== 'NO') fail('--choice must be YES or NO.');
  return { reportId, voterId, stage, choice };
}

function readTarget(rawUrl: string | undefined) {
  let url: URL;
  try {
    url = new URL(rawUrl ?? '');
  } catch {
    fail('TEST_DATABASE_URL must identify the disposable local PostgreSQL database.');
  }
  let user: string;
  let password: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    fail('TEST_DATABASE_URL is malformed; the connection value will not be printed.');
  }
  const target = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: Number(url.port),
    database: url.pathname.slice(1),
    user,
    hasSearch: Boolean(url.search),
    hasHash: Boolean(url.hash),
    appEnvironment: process.env.APP_ENV,
    demoData: process.env.DEMO_DATA,
  };
  try {
    assertDemoSeedTarget(target);
  } catch {
    fail('Demo acceleration requires APP_ENV=demo, DEMO_DATA=true, and the explicit loopback iskra_test database.');
  }
  return { ...target, password };
}

interface DemoVoteTarget {
  readonly reportLat: number;
  readonly reportLng: number;
}

async function assertSeedAndTarget(database: InstanceType<typeof PostgresTransactionDatabase>, input: AcceleratedVoteArguments): Promise<DemoVoteTarget> {
  const supportedReportIds = await Promise.all([
    stableUuid('report/yellow-pending'),
    stableUuid('report/red-pending'),
  ]);
  if (input.stage !== 'EXISTENCE' || !supportedReportIds.includes(input.reportId)) {
    fail('The current deterministic seed supports accelerated EXISTENCE votes only on its pending Yellow or Red report.');
  }
  return database.withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [DEMO_SEED_LOCK_KEY]);
    try {
      await assertMarkedDemoSchema(client);
    } catch {
      fail('The marked local demo schema is missing or does not match this database.');
    }
    const marker = await client.query<{
      request_hash: string; resource_id: string | null; response_status: number | null; response_body: unknown;
    }>(
      `SELECT request_hash, resource_id, response_status, response_body FROM idempotency_keys
       WHERE user_id = $1::text AND operation = $2::varchar AND key = $3::varchar`,
      [DEMO_SEED_USER_IDS[0], DEMO_MARKER_OPERATION, DEMO_MARKER_KEY],
    );
    const seed = marker.rows[0];
    if (!seed || seed.request_hash !== DEMO_SEED_REQUEST_HASH || !seed.resource_id
      || seed.response_status !== 200 || seed.response_body !== null) {
      fail('The complete deterministic demo seed is not present; refusing accelerated votes.');
    }
    const target = await client.query<{
      report_lat: number;
      report_lng: number;
      report_is_demo: boolean;
      voter_is_demo: boolean;
    }>(
      `SELECT r.lat AS report_lat, r.lng AS report_lng, r.is_demo AS report_is_demo, u.is_demo AS voter_is_demo
       FROM reports r CROSS JOIN users u WHERE r.id = $1::uuid AND u.id = $2::text`,
      [input.reportId, input.voterId],
    );
    const row = target.rows[0];
    if (!row || !row.report_is_demo || !row.voter_is_demo) {
      fail('Accelerated votes require an existing demo report and reserved demo voter.');
    }
    return { reportLat: Number(row.report_lat), reportLng: Number(row.report_lng) };
  });
}

function demoMediaResolver() {
  return {
    async resolveAttachedPhotos(photos: readonly { id: string; ordinal: number }[]) {
      return photos.map((photo) => ({
        id: photo.id,
        ordinal: photo.ordinal,
        mediaUrl: `https://demo.invalid/${photo.id}`,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }));
    },
  };
}

async function main(): Promise<void> {
  const input = parseAcceleratedVoteArguments(process.argv.slice(2));
  const target = readTarget(process.env.TEST_DATABASE_URL);
  const pool = new Pool({
    host: target.hostname,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password || 'iskra-test-only',
    ssl: false,
    options: '-c search_path=iskra_demo_seed,pg_catalog',
    application_name: 'iskra-accelerated-demo-vote',
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 8_000,
    max: 1,
  });
  try {
    const database = new PostgresTransactionDatabase(pool);
    const point = await assertSeedAndTarget(database, input);
    const voting = new PostgresReportVotingService(database, demoMediaResolver());
    const identity = acceleratedDemoVoteIdentityLabel(input.reportId, input.voterId, input.stage);
    const voteId = await stableUuid(`vote/accelerated/${identity}`);
    const idempotencyKey = await stableUuid(`idempotency/accelerated/${identity}`);
    const result = await voting.vote(input.voterId, idempotencyKey, input.reportId, {
      stage: input.stage,
      choice: input.choice,
      location: {
        lat: point.reportLat,
        lng: point.reportLng,
        accuracyM: 10,
        observedAt: new Date().toISOString(),
      },
    }, { deterministicVoteId: voteId, demoProvenance: 'accelerated-sandbox' });
    console.log(JSON.stringify({
      outcome: result.receipt.replayed ? 'replayed' : 'accelerated-vote-recorded',
      isDemo: true,
      locationSource: 'synthetic-report-pin',
      reportId: input.reportId,
      voterId: input.voterId,
      stage: input.stage,
      choice: input.choice,
      voteId: result.receipt.voteId,
      rpAwarded: result.receipt.rpAwarded,
    }));
  } finally {
    await pool.end();
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (import.meta.url === entryPath) {
  main().catch((error: unknown) => {
    if (error instanceof DemoAcceleratorError || error instanceof ApiError) {
      console.error(`Demo accelerated vote stopped: ${error.message}`);
    } else {
      console.error('Demo accelerated vote stopped; no database connection values were printed.');
    }
    process.exitCode = 1;
  });
}
