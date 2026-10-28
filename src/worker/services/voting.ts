import {
  POLICY,
  UuidSchema,
  VoteReceiptSchema,
  type Location,
  type Stage,
} from '../../shared/contracts';
import { distanceM, locationAdmission } from '../../shared/location';
import type { CheckedOutClient, TransactionDatabase } from '../db/client';
import { AccountNotFoundError, executeIdempotently, IdempotencyConflictError, lockAccounts } from '../db/client';
import { ApiError } from '../middleware/errors';
import { PostgresReportReadService, type ReportMediaResolver, type ReportDetailSnapshot } from './report-context';

interface LockedReport extends Record<string, unknown> {
  id: string;
  author_user_id: string;
  route: string;
  status: string;
  lat: number;
  lng: number;
  existence_yes_count: number;
  resolution_yes_count: number;
}

interface CleanupRow extends Record<string, unknown> {
  id: string;
  cleaner_user_id: string;
  status: string;
}

interface VoteRow extends Record<string, unknown> {
  id: string;
  report_id: string;
  stage: Stage;
  choice: 'YES' | 'NO';
}

interface BalanceRow extends Record<string, unknown> {
  rp_balance: number;
  version: number;
}

interface VoteReceiptState {
  readonly voteId: string;
  readonly reportSnapshot: ReportDetailSnapshot;
  readonly balance: number;
  readonly balanceVersion: number;
  readonly replayed: boolean;
  readonly rpAwarded: 0 | 5;
}

interface VoteRequest {
  readonly stage: Stage;
  readonly choice: 'YES' | 'NO';
  readonly location: Location;
}

interface LedgerAward {
  readonly userId: string;
  readonly kind: 'VOTE' | 'REPORT_FINAL' | 'CLEANUP';
  readonly delta: number;
  readonly sourceRef: string;
  readonly voteId?: string;
}

function notFound(): never {
  throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
}

function alreadyVoted(): never {
  throw new ApiError(409, 'ALREADY_VOTED', 'A vote for this report and stage has already been recorded.');
}

async function hashRequest(reportId: string, input: VoteRequest, voteId: string | null): Promise<string> {
  const value = JSON.stringify({
    reportId: reportId.toLowerCase(),
    stage: input.stage,
    choice: input.choice,
    location: input.location,
    ...(voteId === null ? {} : { deterministicVoteId: voteId }),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function currentBalance(client: CheckedOutClient, userId: string): Promise<BalanceRow> {
  const result = await client.query<BalanceRow>(
    'SELECT rp_balance, version FROM users WHERE id = $1::text', [userId],
  );
  if (!result.rows[0]) notFound();
  return result.rows[0];
}

async function retryDeadlocks<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code : undefined;
      if (code !== '40P01' || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

/** Applies report-locked, stage-specific votes, rewards and threshold effects atomically. */
export class PostgresReportVotingService {
  private readonly reports: PostgresReportReadService;

  constructor(
    private readonly database: TransactionDatabase,
    private readonly media?: ReportMediaResolver,
    private readonly now: () => number = Date.now,
  ) {
    this.reports = new PostgresReportReadService(database, media);
  }

  async vote(
    actorId: string,
    idempotencyKey: string,
    rawReportId: string,
    input: VoteRequest,
    internal: { readonly deterministicVoteId?: string } = {},
  ) {
    if (!this.media) {
      throw new ApiError(503, 'UNAVAILABLE', 'Report photos are not available yet.', true);
    }
    const key = UuidSchema.parse(idempotencyKey).toLowerCase();
    const reportId = UuidSchema.parse(rawReportId).toLowerCase();
    const deterministicVoteId = internal.deterministicVoteId === undefined
      ? null : UuidSchema.parse(internal.deterministicVoteId).toLowerCase();
    const requestHash = await hashRequest(reportId, input, deterministicVoteId);
    let execution;
    try {
      execution = await retryDeadlocks(() => executeIdempotently<VoteReceiptState>(
        this.database,
        {
          actorId,
          operation: 'REPORT_VOTE',
          key,
          requestHash,
        },
        async (client) => {
          const reportResult = await client.query<LockedReport>(
            'SELECT id, author_user_id, route, status, lat, lng, existence_yes_count, resolution_yes_count '
              + 'FROM reports WHERE id = $1::uuid FOR UPDATE',
            [reportId],
          );
          const report = reportResult.rows[0];
          if (!report) notFound();

          // Semantic deduplication precedes freshness, stage and role checks, just like a
          // same-key replay. A resident can never change their immutable stage choice.
          const priorResult = await client.query<VoteRow>(
            'SELECT id, report_id, stage, choice FROM votes '
              + 'WHERE report_id = $1::uuid AND stage = $2::vote_stage AND voter_user_id = $3::text',
            [reportId, input.stage, actorId],
          );
          const priorVote = priorResult.rows[0];
          if (priorVote) {
            if (priorVote.choice !== input.choice) alreadyVoted();
            await lockAccounts(client, [actorId]);
            const balance = await currentBalance(client, actorId);
            const reportSnapshot = await this.reports.getDetailSnapshot(client, reportId, actorId);
            if (!reportSnapshot) notFound();
            return {
              value: {
                voteId: priorVote.id,
                reportSnapshot,
                balance: balance.rp_balance,
                balanceVersion: balance.version,
                replayed: true,
                rpAwarded: 0 as const,
              },
              receipt: { resourceId: priorVote.id, responseStatus: 200 },
            };
          }

          if (input.stage === 'EXISTENCE') {
            if (report.status === 'RESOLVED') {
              throw new ApiError(409, 'STAGE_CLOSED', 'This report no longer accepts votes.');
            }
            if (report.author_user_id === actorId) {
              throw new ApiError(403, 'SELF_VOTE', 'Report authors cannot vote on existence.');
            }
          } else if (report.status !== 'AWAITING_RESOLUTION') {
            throw new ApiError(409, 'STAGE_CLOSED', 'This report is not accepting resolution votes.');
          }

          let cleanup: CleanupRow | undefined;
          if (input.stage === 'RESOLUTION') {
            const cleanupResult = await client.query<CleanupRow>(
              'SELECT id, cleaner_user_id, status FROM cleanup_submissions '
                + 'WHERE report_id = $1::uuid FOR UPDATE',
              [reportId],
            );
            cleanup = cleanupResult.rows[0];
            if (!cleanup || cleanup.status !== 'AWAITING_VERIFICATION') {
              throw new Error('An AWAITING_RESOLUTION report must have a pending cleanup.');
            }
            if (cleanup.cleaner_user_id === actorId) {
              throw new ApiError(403, 'SELF_VOTE', 'Cleaners cannot vote on their own resolution.');
            }
          }

          const admission = locationAdmission(input.location, this.now(),
            { lat: Number(report.lat), lng: Number(report.lng) }, POLICY.voteRadiusM);
          if (admission === 'LOCATION_INACCURATE') {
            throw new ApiError(422, admission, 'The reported location accuracy is too low.');
          }
          if (admission === 'LOCATION_STALE') {
            throw new ApiError(422, admission, 'A fresh location is required to vote.');
          }
          if (admission === 'TOO_FAR') {
            throw new ApiError(403, admission, 'Move closer to the report to vote.');
          }

          const yes = input.choice === 'YES';
          const closesExistence = input.stage === 'EXISTENCE' && yes
            && report.status === 'AWAITING_EXISTENCE' && Number(report.existence_yes_count) === 2;
          const closesResolution = input.stage === 'RESOLUTION' && yes
            && Number(report.resolution_yes_count) === 2;
          const accountIds = [actorId];
          if (closesResolution && cleanup) accountIds.push(report.author_user_id, cleanup.cleaner_user_id);
          await lockAccounts(client, accountIds);

          const distance = distanceM(input.location, { lat: Number(report.lat), lng: Number(report.lng) });
          const inserted = await client.query<{ id: string }>(
            'INSERT INTO votes (id, report_id, stage, voter_user_id, choice, distance_m, accuracy_m) '
              + 'VALUES (COALESCE($1::uuid, gen_random_uuid()), $2::uuid, $3::vote_stage, $4::text, '
              + '$5::vote_choice, $6::double precision, $7::double precision) '
              + 'RETURNING id',
            [deterministicVoteId, reportId, input.stage, actorId, input.choice, distance, input.location.accuracyM],
          );
          const voteId = inserted.rows[0]?.id;
          if (!voteId) throw new Error('Vote insert did not return its ID.');

          const awards: LedgerAward[] = [{
            userId: actorId,
            kind: 'VOTE',
            delta: POLICY.voteRp,
            sourceRef: 'vote:' + voteId,
            voteId,
          }];

          if (input.stage === 'EXISTENCE') {
            await client.query(
              'UPDATE reports SET '
                + 'existence_yes_count = existence_yes_count + CASE WHEN $2::boolean THEN 1 ELSE 0 END, '
                + "status = CASE WHEN status = 'AWAITING_EXISTENCE' AND $2::boolean "
                + "AND existence_yes_count = 2 THEN 'VERIFIED'::report_lifecycle ELSE status END, "
                + 'existence_verified_at = CASE WHEN status = \'AWAITING_EXISTENCE\' AND $2::boolean '
                + 'AND existence_yes_count = 2 THEN clock_timestamp() ELSE existence_verified_at END, '
                + 'last_existence_confirmed_at = CASE WHEN $2::boolean '
                + 'THEN clock_timestamp() ELSE last_existence_confirmed_at END, '
                + 'version = version + 1, updated_at = clock_timestamp() WHERE id = $1::uuid',
              [reportId, yes],
            );
            if (closesExistence) {
              await client.query(
                "INSERT INTO notifications (user_id, report_id, kind, message) "
                  + "VALUES ($1::text, $2::uuid, 'EXISTENCE_VERIFIED', $3::varchar) "
                  + 'ON CONFLICT (user_id, report_id, kind) DO NOTHING',
                [report.author_user_id, reportId, 'Residents confirmed your report.'],
              );
            }
          } else {
            await client.query(
              'UPDATE reports SET '
                + 'resolution_yes_count = resolution_yes_count + CASE WHEN $2::boolean THEN 1 ELSE 0 END, '
                + "status = CASE WHEN $2::boolean AND resolution_yes_count = 2 "
                + "THEN 'RESOLVED'::report_lifecycle ELSE status END, "
                + 'resolved_at = CASE WHEN $2::boolean AND resolution_yes_count = 2 '
                + 'THEN clock_timestamp() ELSE resolved_at END, '
                + 'version = version + 1, updated_at = clock_timestamp() WHERE id = $1::uuid',
              [reportId, yes],
            );
            if (closesResolution && cleanup) {
              const verified = await client.query<{ id: string }>(
                "UPDATE cleanup_submissions SET status = 'VERIFIED', verified_at = clock_timestamp(), "
                  + 'version = version + 1, updated_at = clock_timestamp() '
                  + "WHERE id = $1::uuid AND status = 'AWAITING_VERIFICATION' RETURNING id",
                [cleanup.id],
              );
              if (verified.rows.length !== 1) throw new Error('The pending cleanup could not be verified.');
              awards.push(
                {
                  userId: report.author_user_id,
                  kind: 'REPORT_FINAL',
                  delta: POLICY.reporterFinalRp,
                  sourceRef: 'report-final:' + reportId,
                },
                {
                  userId: cleanup.cleaner_user_id,
                  kind: 'CLEANUP',
                  delta: POLICY.cleanerRp,
                  sourceRef: 'cleanup-final:' + reportId,
                },
              );
              await client.query(
                "INSERT INTO notifications (user_id, report_id, kind, message) "
                  + "VALUES ($1::text, $2::uuid, 'REPORT_RESOLVED', $3::varchar) "
                  + 'ON CONFLICT (user_id, report_id, kind) DO NOTHING',
                [report.author_user_id, reportId, 'Your city is cleaner thanks to you!'],
              );
            }
          }

          const balanceDeltas = new Map<string, number>();
          for (const award of awards) {
            await client.query(
              'INSERT INTO reward_ledger (user_id, kind, delta, source_ref, report_id, vote_id) '
                + 'VALUES ($1::text, $2::ledger_kind, $3::integer, $4::varchar, $5::uuid, $6::uuid)',
              [award.userId, award.kind, award.delta, award.sourceRef, reportId, award.voteId ?? null],
            );
            balanceDeltas.set(award.userId, (balanceDeltas.get(award.userId) ?? 0) + award.delta);
          }

          let voterBalance: BalanceRow | undefined;
          for (const [userId, delta] of [...balanceDeltas.entries()].sort(([left], [right]) => left.localeCompare(right))) {
            const updated = await client.query<BalanceRow>(
              'UPDATE users SET rp_balance = rp_balance + $2::integer, version = version + 1, '
                + 'updated_at = clock_timestamp() WHERE id = $1::text RETURNING rp_balance, version',
              [userId, delta],
            );
            const balance = updated.rows[0];
            if (!balance) notFound();
            if (userId === actorId) voterBalance = balance;
          }
          if (!voterBalance) throw new Error('The voter balance was not updated.');

          const reportSnapshot = await this.reports.getDetailSnapshot(client, reportId, actorId);
          if (!reportSnapshot) notFound();
          return {
            value: {
              voteId,
              reportSnapshot,
              balance: voterBalance.rp_balance,
              balanceVersion: voterBalance.version,
              replayed: false,
              rpAwarded: POLICY.voteRp as 5,
            },
            receipt: { resourceId: voteId, responseStatus: 200 },
          };
        },
        async (client, receipt) => {
          await lockAccounts(client, [actorId]);
          const vote = await client.query<VoteRow>(
            'SELECT id, report_id, stage, choice FROM votes WHERE id = $1::uuid AND voter_user_id = $2::text',
            [receipt.resourceId, actorId],
          );
          const accepted = vote.rows[0];
          if (!accepted) notFound();
          const balance = await currentBalance(client, actorId);
          const reportSnapshot = await this.reports.getDetailSnapshot(client, accepted.report_id, actorId);
          if (!reportSnapshot) notFound();
          return {
            voteId: accepted.id,
            reportSnapshot,
            balance: balance.rp_balance,
            balanceVersion: balance.version,
            replayed: true,
            rpAwarded: 0 as const,
          };
        },
      ));
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was already used with different vote data.');
      }
      if (error instanceof AccountNotFoundError) notFound();
      throw error;
    }

    if (execution.responseStatus !== 200) {
      throw new Error('Vote idempotency receipt has an unexpected response status.');
    }
    const report = await this.reports.projectDetailSnapshot(execution.value.reportSnapshot, actorId);
    return {
      responseStatus: 200 as const,
      receipt: VoteReceiptSchema.parse({
        voteId: execution.value.voteId,
        replayed: execution.value.replayed || execution.replayed,
        rpAwarded: execution.value.rpAwarded,
        balance: execution.value.balance,
        balanceVersion: execution.value.balanceVersion,
        report,
      }),
    };
  }
}
