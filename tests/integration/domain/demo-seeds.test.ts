import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresTransactionDatabase } from '../../../src/worker/db/client';
import { PostgresDemoSeedService } from '../../../src/worker/services/demo-seeds';
import type { ReportMediaResolver } from '../../../src/worker/services/report-context';
import { withTestDatabase } from '../auth/postgres';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');
const fixtureBytes = await readFile(new URL('../../../tests/fixtures/photos/restart.jpg', import.meta.url));
const photo = {
  byteSize: fixtureBytes.byteLength,
  sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
};

async function installDemoSchema(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(migration);
    await client.query(
      `CREATE TABLE demo_seed_metadata (
         singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
         environment text NOT NULL CHECK (environment = 'demo'),
         database_name text NOT NULL,
         database_user text NOT NULL,
         schema_name text NOT NULL,
         schema_version integer NOT NULL CHECK (schema_version = 1)
       )`,
    );
    await client.query(
      `INSERT INTO demo_seed_metadata (environment, database_name, database_user, schema_name, schema_version)
       SELECT 'demo', current_database(), current_user, current_schema(), 1`,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function createMediaResolver(): ReportMediaResolver {
  return {
    async resolveAttachedPhotos(photos) {
      return photos.map((photo) => ({
        id: photo.id,
        ordinal: photo.ordinal,
        mediaUrl: `https://media.invalid/${photo.id}`,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }));
    },
  };
}

describe('deterministic demo seed service', () => {
  it('builds a marked lifecycle through the domain services, reconciles balances, and safely replays', () =>
    withTestDatabase(async (pool) => {
      await installDemoSchema(pool);
      const service = new PostgresDemoSeedService(
        new PostgresTransactionDatabase(pool), createMediaResolver(), photo,
      );

      const seeded = await service.seed();
      const replayed = await service.seed();

      expect(seeded.alreadySeeded).toBe(false);
      expect(replayed.alreadySeeded).toBe(true);
      expect(replayed.reports).toEqual(seeded.reports);
      expect(seeded.snapshots).toMatchObject({
        reporterTotalRp: 20,
        reporterBalanceRp: 20,
        initialRp: 5,
        verifierBalanceRp: 5,
        cleanerRp: 40,
        cleanerBalanceRp: 40,
        existenceYesCount: 5,
        resolutionYesCount: 3,
      });

      const state = await pool.query<{
        demo_users: number;
        demo_reports: number;
        demo_votes: number;
        demo_ledger: number;
        labels: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM users WHERE id LIKE 'iskra-demo-seed:v1:%' AND is_demo) AS demo_users,
           (SELECT count(*)::int FROM reports WHERE id = ANY($1::uuid[]) AND is_demo) AS demo_reports,
           (SELECT count(*)::int FROM votes WHERE report_id = $2::uuid AND is_demo) AS demo_votes,
           (SELECT count(*)::int FROM reward_ledger WHERE report_id = ANY($1::uuid[]) AND is_demo) AS demo_ledger,
           (SELECT count(*)::int FROM ai_analyses WHERE owner_user_id LIKE 'iskra-demo-seed:v1:%'
             AND is_demo AND model_id = 'demo-recorded-fixture-v1' AND prompt_version = 'demo-seed-v1') AS labels`,
        [[seeded.reports.greenResolved, seeded.reports.yellowPending, seeded.reports.redPending],
          seeded.reports.greenResolved],
      );
      expect(state.rows[0]).toEqual({ demo_users: 14, demo_reports: 3, demo_votes: 8, demo_ledger: 15, labels: 4 });
    }));
});
