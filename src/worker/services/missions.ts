import {
  CreateMissionRequestSchema,
  MissionAnnouncementRequestSchema,
  MissionSchema,
  UuidSchema,
  type CreateMissionRequest,
  type Mission,
} from '../../shared/contracts';
import {
  AccountNotFoundError,
  executeIdempotently,
  IdempotencyConflictError,
  lockAccounts,
  type CheckedOutClient,
  type TransactionDatabase,
} from '../db/client';
import { ApiError } from '../middleware/errors';

interface MissionRow extends Record<string, unknown> {
  id: string;
  report_id: string;
  organizer_id: string;
  organizer_nickname: string;
  organizer_avatar: string;
  status: string;
  starts_at: Date | string;
  meeting_lat: number;
  meeting_lng: number;
  meeting_label: string;
  participant_count: number;
  announcement: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function notFound(): never {
  throw new ApiError(404, 'NOT_FOUND', 'The requested mission was not found.');
}

function missionAlreadyExists(): never {
  throw new ApiError(409, 'MISSION_ALREADY_EXISTS', 'A mission already exists for this report.');
}

function missionNotOpen(): never {
  throw new ApiError(409, 'MISSION_NOT_OPEN', 'This mission is not accepting participants.');
}

function invalidMissionInput(): never {
  throw new ApiError(400, 'INVALID_INPUT', 'The mission request is invalid.');
}

function publicMission(row: MissionRow): Mission {
  return MissionSchema.parse({
    id: row.id.toLowerCase(),
    reportId: row.report_id.toLowerCase(),
    organizer: {
      id: row.organizer_id,
      nickname: row.organizer_nickname,
      avatar: row.organizer_avatar,
    },
    status: row.status,
    startsAt: new Date(row.starts_at).toISOString(),
    meetingPoint: { lat: row.meeting_lat, lng: row.meeting_lng, label: row.meeting_label },
    participantCount: row.participant_count,
    announcement: row.announcement,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

async function readMission(client: CheckedOutClient, where: 'id' | 'report_id', id: string) {
  const column = where === 'id' ? 'm.id' : 'm.report_id';
  const result = await client.query<MissionRow>(
    `SELECT m.id, m.report_id, m.status, m.starts_at, m.meeting_lat, m.meeting_lng,
       m.meeting_label, m.announcement, m.created_at, m.updated_at,
       organizer.id AS organizer_id, organizer.nickname AS organizer_nickname,
       organizer.avatar_key AS organizer_avatar,
       (SELECT count(*)::int FROM mission_participants p WHERE p.mission_id = m.id) AS participant_count
     FROM missions m
     JOIN users organizer ON organizer.id = m.organizer_user_id
     WHERE ${column} = $1::uuid`,
    [id],
  );
  return result.rows[0] ? publicMission(result.rows[0]) : null;
}

async function requestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function pgConstraint(error: unknown, code: string, constraint: string): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === code
    && 'constraint' in error && error.constraint === constraint;
}

export class PostgresMissionService {
  constructor(
    private readonly database: TransactionDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async getById(missionId: string) {
    const parsed = UuidSchema.safeParse(missionId);
    if (!parsed.success) return null;
    return this.database.withTransaction((client) => readMission(client, 'id', parsed.data.toLowerCase()));
  }

  async getByReportId(reportId: string) {
    const parsed = UuidSchema.safeParse(reportId);
    if (!parsed.success) return null;
    return this.database.withTransaction((client) => readMission(client, 'report_id', parsed.data.toLowerCase()));
  }

  async create(actorId: string, idempotencyKey: string, reportId: string, input: CreateMissionRequest) {
    const parsedReportId = UuidSchema.safeParse(reportId);
    const parsedKey = UuidSchema.safeParse(idempotencyKey);
    const parsedInput = CreateMissionRequestSchema.safeParse(input);
    if (!parsedReportId.success || !parsedKey.success || !parsedInput.success) invalidMissionInput();

    const targetId = parsedReportId.data.toLowerCase();
    const key = parsedKey.data.toLowerCase();
    const value = parsedInput.data;
    try {
      const result = await executeIdempotently<Mission>(
        this.database,
        {
          actorId,
          operation: 'YELLOW_MISSION_CREATE',
          key,
          requestHash: await requestHash({ reportId: targetId, ...value }),
        },
        async (client) => {
          try {
            await lockAccounts(client, [actorId]);
          } catch (error) {
            if (error instanceof AccountNotFoundError) notFound();
            throw error;
          }
          if (Date.parse(value.startsAt) <= this.now()) invalidMissionInput();

          const reportResult = await client.query<{
            route: string; status: string; is_demo: boolean;
          }>(
            'SELECT route, status, is_demo FROM reports WHERE id = $1::uuid FOR UPDATE',
            [targetId],
          );
          const report = reportResult.rows[0];
          if (!report) notFound();
          if (report.is_demo) {
            throw new ApiError(403, 'FORBIDDEN', 'Demo reports cannot receive live missions.');
          }
          if (report.route !== 'YELLOW' || report.status !== 'VERIFIED') {
            throw new ApiError(403, 'NOT_ELIGIBLE', 'Only verified YELLOW reports can receive a mission.');
          }

          const existing = await client.query<{ id: string }>(
            'SELECT id FROM missions WHERE report_id = $1::uuid', [targetId],
          );
          if (existing.rows[0]) missionAlreadyExists();

          const inserted = await client.query<{ id: string }>(
            `INSERT INTO missions (
               report_id, report_route, organizer_user_id, starts_at,
               meeting_lat, meeting_lng, meeting_label, is_demo
             ) VALUES ($1::uuid, 'YELLOW', $2::text, $3::timestamptz, $4, $5, $6, false)
             RETURNING id`,
            [targetId, actorId, value.startsAt, value.meetingPoint.lat,
              value.meetingPoint.lng, value.meetingPoint.label.trim()],
          );
          const missionId = inserted.rows[0]?.id;
          if (!missionId) throw new Error('Mission insert did not return an ID.');
          await client.query(
            'INSERT INTO mission_participants (mission_id, user_id) VALUES ($1::uuid, $2::text)',
            [missionId, actorId],
          );
          const mission = await readMission(client, 'id', missionId.toLowerCase());
          if (!mission) throw new Error('Created mission could not be read.');
          return { value: mission, receipt: { resourceId: missionId, responseStatus: 201 } };
        },
        async (client, receipt) => {
          const mission = await readMission(client, 'id', receipt.resourceId.toLowerCase());
          if (!mission) notFound();
          return mission;
        },
      );
      return { mission: result.value, responseStatus: result.responseStatus };
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was used for another request.');
      }
      if (pgConstraint(error, '23505', 'missions_report_id_key')) missionAlreadyExists();
      throw error;
    }
  }

  async join(actorId: string, missionId: string) {
    const parsed = UuidSchema.safeParse(missionId);
    if (!parsed.success) invalidMissionInput();
    return this.database.withTransaction(async (client) => {
      try {
        await lockAccounts(client, [actorId]);
      } catch (error) {
        if (error instanceof AccountNotFoundError) notFound();
        throw error;
      }
      const locked = await client.query<{ status: string }>(
        'SELECT status FROM missions WHERE id = $1::uuid FOR UPDATE', [parsed.data.toLowerCase()],
      );
      const mission = locked.rows[0];
      if (!mission) notFound();
      if (mission.status !== 'OPEN') missionNotOpen();
      await client.query(
        `INSERT INTO mission_participants (mission_id, user_id)
         VALUES ($1::uuid, $2::text) ON CONFLICT (mission_id, user_id) DO NOTHING`,
        [parsed.data.toLowerCase(), actorId],
      );
      const updated = await readMission(client, 'id', parsed.data.toLowerCase());
      if (!updated) notFound();
      return { mission: updated };
    });
  }

  async updateAnnouncement(actorId: string, missionId: string, announcement: string) {
    const parsed = UuidSchema.safeParse(missionId);
    const parsedBody = MissionAnnouncementRequestSchema.safeParse({ announcement });
    if (!parsed.success || !parsedBody.success) invalidMissionInput();
    return this.database.withTransaction(async (client) => {
      try {
        await lockAccounts(client, [actorId]);
      } catch (error) {
        if (error instanceof AccountNotFoundError) notFound();
        throw error;
      }
      const locked = await client.query<{ status: string; organizer_user_id: string }>(
        'SELECT status, organizer_user_id FROM missions WHERE id = $1::uuid FOR UPDATE',
        [parsed.data.toLowerCase()],
      );
      const mission = locked.rows[0];
      if (!mission) notFound();
      if (mission.organizer_user_id !== actorId) {
        throw new ApiError(403, 'FORBIDDEN', 'Only the mission organizer can change its announcement.');
      }
      if (mission.status !== 'OPEN') missionNotOpen();
      await client.query(
        `UPDATE missions SET announcement = $2::varchar, updated_at = clock_timestamp()
         WHERE id = $1::uuid`,
        [parsed.data.toLowerCase(), parsedBody.data.announcement],
      );
      const updated = await readMission(client, 'id', parsed.data.toLowerCase());
      if (!updated) notFound();
      return { mission: updated };
    });
  }
}
