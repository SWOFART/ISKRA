import { Client, Pool, type ClientConfig } from 'pg';

export function testDatabaseConfig(raw = process.env.TEST_DATABASE_URL): ClientConfig {
  let url: URL;
  try {
    url = new URL(raw ?? '');
  } catch {
    throw new Error('Set TEST_DATABASE_URL to a disposable loopback iskra_test database.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.pathname !== '/iskra_test' || url.username !== 'iskra_test'
    || !url.port || Number(url.port) < 1 || url.search || url.hash) {
    throw new Error('Integration tests require loopback host, explicit port, iskra_test user/database, and no URL options.');
  }
  return {
    host: '127.0.0.1', port: Number(url.port), database: 'iskra_test', user: 'iskra_test',
    password: decodeURIComponent(url.password) || 'iskra-test-only', ssl: false, options: '-c search_path=pg_catalog',
    application_name: 'iskra-integration-tests', connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000, query_timeout: 8_000,
  };
}

export async function withTestDatabase<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  const config = testDatabaseConfig();
  const admin = new Client(config);
  const schema = `iskra_test_${crypto.randomUUID().replaceAll('-', '')}`;
  let pool: Pool | undefined;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, options: `-c search_path=${schema}`, max: 4 });
    return await run(pool);
  } finally {
    try {
      await pool?.end();
      // Only this invocation's generated schema is ever removed.
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  }
}
