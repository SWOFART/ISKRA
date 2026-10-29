import { Hono } from 'hono';
import {
  CreateMissionRequestSchema,
  EmptyBodySchema,
  MissionAnnouncementRequestSchema,
  MissionEnvelopeSchema,
  UuidSchema,
} from '../../shared/contracts';
import type { TransactionDatabase } from '../db/client';
import { requireAuth, verifyFirebaseToken } from '../middleware/auth';
import type { WorkerEnv } from '../middleware/context';
import { ApiError } from '../middleware/errors';
import { parseJsonBody } from '../middleware/validation';
import { PostgresMissionService } from '../services/missions';

export interface MissionRouteDependencies {
  readonly database: TransactionDatabase;
  readonly verify?: typeof verifyFirebaseToken;
  readonly now?: () => number;
}

function invalidPath(): never {
  throw new ApiError(400, 'INVALID_INPUT', 'The mission request is invalid.');
}

function invalidCreateKey(): never {
  throw new ApiError(400, 'INVALID_INPUT', 'A valid Idempotency-Key is required.');
}

export function createMissionRoutes({ database, verify = verifyFirebaseToken, now }: MissionRouteDependencies) {
  const missions = new PostgresMissionService(database, now);
  return new Hono<WorkerEnv>()
    .get('/reports/:id/mission', async (c) => {
      const reportId = UuidSchema.safeParse(c.req.param('id'));
      if (!reportId.success) throw invalidPath();
      const mission = await missions.getByReportId(reportId.data);
      if (!mission) throw new ApiError(404, 'NOT_FOUND', 'The requested mission was not found.');
      c.header('Cache-Control', 'no-store');
      return c.json(MissionEnvelopeSchema.parse({ mission }), 200);
    })
    .get('/missions/:id', async (c) => {
      const missionId = UuidSchema.safeParse(c.req.param('id'));
      if (!missionId.success) throw invalidPath();
      const mission = await missions.getById(missionId.data);
      if (!mission) throw new ApiError(404, 'NOT_FOUND', 'The requested mission was not found.');
      c.header('Cache-Control', 'no-store');
      return c.json(MissionEnvelopeSchema.parse({ mission }), 200);
    })
    .post('/reports/:id/missions', requireAuth(verify), async (c) => {
      const actorId = c.get('identity')?.uid;
      if (!actorId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      const reportId = UuidSchema.safeParse(c.req.param('id'));
      const key = UuidSchema.safeParse(c.req.header('Idempotency-Key'));
      if (!reportId.success) throw invalidPath();
      if (!key.success) throw invalidCreateKey();
      const input = await parseJsonBody(c, CreateMissionRequestSchema);
      const result = await missions.create(actorId, key.data, reportId.data, input);
      c.header('Cache-Control', 'no-store');
      return c.json(MissionEnvelopeSchema.parse({ mission: result.mission }), result.responseStatus as 200 | 201);
    })
    .post('/missions/:id/participants', requireAuth(verify), async (c) => {
      const actorId = c.get('identity')?.uid;
      if (!actorId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      const missionId = UuidSchema.safeParse(c.req.param('id'));
      if (!missionId.success) throw invalidPath();
      await parseJsonBody(c, EmptyBodySchema);
      const result = await missions.join(actorId, missionId.data);
      c.header('Cache-Control', 'no-store');
      return c.json(MissionEnvelopeSchema.parse(result), 200);
    })
    .patch('/missions/:id/announcement', requireAuth(verify), async (c) => {
      const actorId = c.get('identity')?.uid;
      if (!actorId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      const missionId = UuidSchema.safeParse(c.req.param('id'));
      if (!missionId.success) throw invalidPath();
      const input = await parseJsonBody(c, MissionAnnouncementRequestSchema);
      const result = await missions.updateAnnouncement(actorId, missionId.data, input.announcement);
      c.header('Cache-Control', 'no-store');
      return c.json(MissionEnvelopeSchema.parse(result), 200);
    });
}
