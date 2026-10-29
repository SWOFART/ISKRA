import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { MissionEnvelopeSchema } from '../../../src/shared/contracts';
import { PostgresTransactionDatabase } from '../../../src/worker/db/client';
import type { WorkerEnv } from '../../../src/worker/middleware/context';
import { handleError } from '../../../src/worker/middleware/errors';
import { apiSecurity } from '../../../src/worker/middleware/security';
import { createDomainRoutes } from '../../../src/worker/routes/domain';
import { withTestDatabase } from '../auth/postgres';

const coreMigration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');
const missionMigration = await readFile(new URL('../../../migrations/0002_yellow_missions.sql', import.meta.url), 'utf8');
const instant = Date.parse('2026-10-29T10:00:00.000Z');
const createBody = {
  startsAt: new Date(instant + 60 * 60_000).toISOString(),
  meetingPoint: { lat: 49.142, lng: 9.225, label: 'North entrance' },
};

async function installSchema(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(coreMigration);
    await client.query(missionMigration);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createUser(pool: Pool, id: string, nickname = `Resident ${id}`) {
  await pool.query('INSERT INTO users (id, nickname, avatar_key) VALUES ($1, $2, $3)', [id, nickname, 'avatar-default']);
}

async function createReport(
  pool: Pool,
  author: string,
  options: { route?: 'GREEN' | 'YELLOW' | 'RED'; verified?: boolean; demo?: boolean } = {},
) {
  const verified = options.verified ?? true;
  const analysis = await pool.query<{ id: string }>(
    `INSERT INTO ai_analyses (owner_user_id, kind, status, input_hash, result, expires_at, is_demo)
     VALUES ($1, 'REPORT', 'READY', $2, '{"decision":"ACCEPT"}'::jsonb, now() + interval '15 minutes', $3)
     RETURNING id`,
    [author, `mission-report-${crypto.randomUUID()}`, options.demo ?? false],
  );
  const report = await pool.query<{ id: string }>(
    `INSERT INTO reports (
       author_user_id, route, status, description, lat, lng, measured_lat, measured_lng,
       accuracy_m, captured_location_at, analysis_id, existence_yes_count,
       existence_verified_at, last_existence_confirmed_at, is_demo
     ) VALUES (
       $1, $2::report_route, $3::report_lifecycle, 'Public report description',
       49.14, 9.22, 49.14, 9.22, 10, now(), $4::uuid,
       CASE WHEN $5 THEN 3 ELSE 0 END,
       CASE WHEN $5 THEN now() ELSE NULL END,
       CASE WHEN $5 THEN now() ELSE NULL END, $6
     ) RETURNING id`,
    [author, options.route ?? 'YELLOW', verified ? 'VERIFIED' : 'AWAITING_EXISTENCE',
      analysis.rows[0].id, verified, options.demo ?? false],
  );
  return report.rows[0].id;
}

function createApp(pool: Pool) {
  const app = new Hono<WorkerEnv>();
  app.use('*', apiSecurity);
  app.route('/api', createDomainRoutes({
    database: new PostgresTransactionDatabase(pool),
    verify: async (token) => ({ uid: token }),
    now: () => instant,
  }));
  app.onError(handleError);
  return app;
}

function send(
  app: Hono<WorkerEnv>,
  path: string,
  method: string,
  actor: string | null,
  body?: unknown,
  idempotencyKey?: string,
) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (actor) headers.set('Authorization', `Bearer ${actor}`);
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
  return app.request(path, {
    method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { FIREBASE_PROJECT_ID: 'test-project' });
}

const key = () => crypto.randomUUID();

describe('Yellow mission endpoints on PostgreSQL', () => {
  it('locks and validates a report, creates one mission and organizer participant atomically', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await Promise.all(['organizer', 'other'].map((id) => createUser(pool, id)));
      const eligible = await createReport(pool, 'organizer');
      const unverified = await createReport(pool, 'organizer', { verified: false });
      const green = await createReport(pool, 'organizer', { route: 'GREEN' });
      const red = await createReport(pool, 'organizer', { route: 'RED' });
      const demo = await createReport(pool, 'organizer', { demo: true });
      const app = createApp(pool);

      expect((await send(app, `/api/reports/${eligible}/missions`, 'POST', null, createBody, key())).status).toBe(401);
      for (const reportId of [unverified, green, red]) {
        const response = await send(app, `/api/reports/${reportId}/missions`, 'POST', 'organizer', createBody, key());
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'NOT_ELIGIBLE' } });
      }
      const demoResponse = await send(app, `/api/reports/${demo}/missions`, 'POST', 'organizer', createBody, key());
      expect(demoResponse.status).toBe(403);
      expect(await demoResponse.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

      const idempotencyKey = key();
      const created = await send(app, `/api/reports/${eligible}/missions`, 'POST', 'organizer', createBody, idempotencyKey);
      expect(created.status).toBe(201);
      const envelope = MissionEnvelopeSchema.parse(await created.json());
      expect(envelope.mission).toMatchObject({
        reportId: eligible, status: 'OPEN', participantCount: 1,
        organizer: { id: 'organizer', nickname: 'Resident organizer', avatar: 'avatar-default' },
        meetingPoint: createBody.meetingPoint,
      });
      expect(envelope.mission.meetingPoint).not.toEqual({ lat: 49.14, lng: 9.22, label: 'Report pin' });

      const replay = await send(app, `/api/reports/${eligible}/missions`, 'POST', 'organizer', createBody, idempotencyKey);
      expect(replay.status).toBe(201);
      expect(MissionEnvelopeSchema.parse(await replay.json()).mission.id).toBe(envelope.mission.id);
      const duplicate = await send(app, `/api/reports/${eligible}/missions`, 'POST', 'organizer', createBody, key());
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ error: { code: 'MISSION_ALREADY_EXISTS' } });

      const records = await pool.query<{ missions: string; participants: string }>(
        `SELECT (SELECT count(*) FROM missions WHERE report_id = $1::uuid)::text AS missions,
           (SELECT count(*) FROM mission_participants WHERE mission_id = $2::uuid)::text AS participants`,
        [eligible, envelope.mission.id],
      );
      expect(records.rows[0]).toEqual({ missions: '1', participants: '1' });
      const stored = await pool.query<{
        meeting_lat: number; meeting_lng: number; report_lat: number; report_lng: number;
      }>(
        `SELECT m.meeting_lat, m.meeting_lng, r.lat AS report_lat, r.lng AS report_lng
         FROM missions m JOIN reports r ON r.id = m.report_id WHERE m.id = $1::uuid`, [envelope.mission.id],
      );
      expect(stored.rows[0]).toEqual({ meeting_lat: createBody.meetingPoint.lat, meeting_lng: createBody.meetingPoint.lng,
        report_lat: 49.14, report_lng: 9.22 });
      expect(stored.rows[0].meeting_lat).not.toBe(stored.rows[0].report_lat);

      const contested = await createReport(pool, 'organizer');
      const simultaneous = await Promise.all([
        send(app, `/api/reports/${contested}/missions`, 'POST', 'organizer', createBody, key()),
        send(app, `/api/reports/${contested}/missions`, 'POST', 'other', createBody, key()),
      ]);
      expect(simultaneous.map(({ status }) => status).sort()).toEqual([201, 409]);
      const raceCount = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM missions WHERE report_id = $1::uuid', [contested],
      );
      expect(raceCount.rows[0].count).toBe('1');
    }));

  it('keeps joins idempotent, exposes only public mission data and restricts announcements to the organizer', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await Promise.all(['organizer', 'participant', 'outsider'].map((id) => createUser(pool, id)));
      const reportId = await createReport(pool, 'organizer');
      const app = createApp(pool);
      const created = await send(app, `/api/reports/${reportId}/missions`, 'POST', 'organizer', createBody, key());
      const mission = MissionEnvelopeSchema.parse(await created.json()).mission;

      const firstJoin = await send(app, `/api/missions/${mission.id}/participants`, 'POST', 'participant', {});
      const repeatJoin = await send(app, `/api/missions/${mission.id}/participants`, 'POST', 'participant', {});
      expect(firstJoin.status).toBe(200);
      expect(repeatJoin.status).toBe(200);
      expect(MissionEnvelopeSchema.parse(await repeatJoin.json()).mission.participantCount).toBe(2);

      const simultaneousJoins = await Promise.all(Array.from({ length: 4 }, () =>
        send(app, `/api/missions/${mission.id}/participants`, 'POST', 'outsider', {})));
      expect(simultaneousJoins.every((response) => response.status === 200)).toBe(true);
      const publicResponse = await send(app, `/api/missions/${mission.id}`, 'GET', null);
      expect(publicResponse.status).toBe(200);
      const publicText = await publicResponse.text();
      const publicMission = MissionEnvelopeSchema.parse(JSON.parse(publicText)).mission;
      expect(publicMission.participantCount).toBe(3);
      expect(publicText).not.toMatch(/participants|email|@example|attendeeRewardRp/i);
      expect(await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM mission_participants WHERE mission_id = $1::uuid', [mission.id],
      )).toMatchObject({ rows: [{ count: '3' }] });

      const updated = await send(app, `/api/missions/${mission.id}/announcement`, 'PATCH', 'organizer', {
        announcement: 'Meet beside the north entrance; bring gloves.',
      });
      expect(updated.status).toBe(200);
      expect(MissionEnvelopeSchema.parse(await updated.json()).mission.announcement)
        .toBe('Meet beside the north entrance; bring gloves.');
      const denied = await send(app, `/api/missions/${mission.id}/announcement`, 'PATCH', 'participant', {
        announcement: 'Unauthorized change',
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      const afterDeniedUpdate = await send(app, `/api/missions/${mission.id}`, 'GET', null);
      expect(MissionEnvelopeSchema.parse(await afterDeniedUpdate.json()).mission.announcement)
        .toBe('Meet beside the north entrance; bring gloves.');
      const invalid = await send(app, `/api/missions/${mission.id}/announcement`, 'PATCH', 'organizer', {
        announcement: 'x'.repeat(501),
      });
      expect(invalid.status).toBe(400);

      for (const action of ['attendance', 'complete', 'payout']) {
        const missingStage = await send(app, `/api/missions/${mission.id}/${action}`, 'POST', 'participant', {});
        expect(missingStage.status).toBe(404);
      }
      const missionColumns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name IN ('missions', 'mission_participants')`,
      );
      const names = missionColumns.rows.map(({ column_name }) => column_name);
      for (const forbidden of ['attendance_confirmed', 'attendee_reward_rp', 'completed_at']) {
        expect(names).not.toContain(forbidden);
      }
    }));
});
