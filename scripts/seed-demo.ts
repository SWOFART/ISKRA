import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { PostgresTransactionDatabase } from '../src/worker/db/client.ts';
import { assertDemoSeedTarget, PostgresDemoSeedService } from '../src/worker/services/demo-seeds.ts';
import type { ReportMediaResolver } from '../src/worker/services/report-context.ts';

const schemaName = 'iskra_demo_seed';

function usageFailure(message: string): never {
  throw new Error(message);
}

function readTarget(rawUrl: string | undefined) {
  let url: URL;
  try {
    url = new URL(rawUrl ?? '');
  } catch {
    usageFailure('TEST_DATABASE_URL must be configured for the disposable local PostgreSQL database.');
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

async function ensureMarkedSchema(pool: Pool, config: PoolConfig) {
  const client = await pool.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS iskra_demo_seed');
  } finally {
    client.release();
  }

  const schemaPool = new Pool({
    host: '127.0.0.1',
    port: config.port,
    database: 'iskra_test',
    user: 'iskra_test',
    password: config.password,
    ssl: false,
    options: `-c search_path=${schemaName},pg_catalog`,
    application_name: 'iskra-demo-seed-cli',
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 8_000,
    max: 1,
  });
  let schemaClient: PoolClient | undefined;
  try {
    const client = await schemaPool.connect();
    schemaClient = client;
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT to_regclass('users') IS NOT NULL AS has_users,
         to_regclass('reports') IS NOT NULL AS has_reports`,
    );
    if (!existing.rows[0]?.has_users && !existing.rows[0]?.has_reports) {
      const migrationPath = fileURLToPath(new URL('../migrations/0001_p0_core.sql', import.meta.url));
      await client.query(await readFile(migrationPath, 'utf8'));
    } else if (!existing.rows[0]?.has_users || !existing.rows[0]?.has_reports) {
      usageFailure('The local demo schema is partial; refusing to repair or overwrite it.');
    }

    await client.query(
      `CREATE TABLE IF NOT EXISTS demo_seed_metadata (
         singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
         environment text NOT NULL CHECK (environment = 'demo'),
         database_name text NOT NULL,
         database_user text NOT NULL,
         schema_name text NOT NULL,
         schema_version integer NOT NULL CHECK (schema_version = 1)
       )`,
    );
    const identity = await client.query(
      `SELECT current_database() AS database_name, current_user AS database_user,
         current_schema() AS schema_name`,
    );
    const actual = identity.rows[0];
    if (!actual || actual.database_name !== 'iskra_test' || actual.database_user !== 'iskra_test'
      || actual.schema_name !== schemaName) {
      usageFailure('The local PostgreSQL database identity does not match the marked demo schema.');
    }
    await client.query(
      `INSERT INTO demo_seed_metadata (
         singleton, environment, database_name, database_user, schema_name, schema_version
       ) VALUES (true, 'demo', $1::text, $2::text, $3::text, 1)
       ON CONFLICT (singleton) DO NOTHING`,
      [actual.database_name, actual.database_user, actual.schema_name],
    );
    const checked = await client.query(
      `SELECT environment, database_name, database_user, schema_name, schema_version
       FROM demo_seed_metadata WHERE singleton = true`,
    );
    const saved = checked.rows[0];
    if (!saved || saved.environment !== 'demo' || saved.database_name !== actual.database_name
      || saved.database_user !== actual.database_user || saved.schema_name !== actual.schema_name
      || saved.schema_version !== 1) {
      usageFailure('The existing demo schema marker does not match this sandbox.');
    }
    await client.query('COMMIT');
  } catch (error) {
    await schemaClient?.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    schemaClient?.release();
    await schemaPool.end();
  }
}

async function main() {
  if (process.argv.slice(2).join(' ') !== '--confirm-sandbox') {
    usageFailure('Usage: node --experimental-strip-types --experimental-transform-types scripts/seed-demo.mjs --confirm-sandbox');
  }
  const target = readTarget(process.env.TEST_DATABASE_URL);
  assertDemoSeedTarget({
    ...target,
    appEnvironment: process.env.APP_ENV,
    demoData: process.env.DEMO_DATA,
  });

  const config = {
    host: '127.0.0.1',
    port: target.port,
    database: 'iskra_test',
    user: 'iskra_test',
    password: target.password || 'iskra-test-only',
    ssl: false,
    options: '-c search_path=pg_catalog',
    application_name: 'iskra-demo-seed-admin',
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 8_000,
    max: 1,
  };
  const adminPool = new Pool(config);
  try {
    await ensureMarkedSchema(adminPool, config);
  } finally {
    await adminPool.end();
  }

  const demoPool = new Pool({ ...config, options: `-c search_path=${schemaName},pg_catalog`, application_name: 'iskra-demo-seed' });
  try {
    const photoPath = fileURLToPath(new URL('../tests/fixtures/photos/restart.jpg', import.meta.url));
    const photoBytes = await readFile(photoPath);
    const photo = {
      byteSize: photoBytes.byteLength,
      sha256: createHash('sha256').update(photoBytes).digest('hex'),
    };
    const media: ReportMediaResolver = {
      async resolveAttachedPhotos(photos) {
        return photos.map((item) => ({
          id: item.id,
          ordinal: item.ordinal,
          mediaUrl: `https://demo.invalid/${item.id}`,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        }));
      },
    };
    const result = await new PostgresDemoSeedService(
      new PostgresTransactionDatabase(demoPool), media, photo,
    ).seed();
    console.log(JSON.stringify({ environment: 'demo', schema: schemaName, ...result }, null, 2));
  } finally {
    await demoPool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown seed failure.';
  console.error(`Demo seed stopped: ${message}`);
  process.exitCode = 1;
});
