import { describe, expect, it } from 'vitest';
import fixtures from '../../fixtures/contracts/p0.json';
import * as c from '../../../src/shared/contracts';
import { array, number, object } from '../../../src/shared/schema';
import { distanceM, locationAdmission, reportPinAdmission } from '../../../src/shared/location';

const now = Date.parse('2026-10-27T12:00:00.000Z');
const location = { lat: 49.14, lng: 9.22, accuracyM: 50, observedAt: '2026-10-27T11:59:00.000Z' };
const id = '11111111-1111-4111-8111-111111111111';

describe('P0 validating fixtures shared by A/B/C', () => {
  const cases = [
    ['publicReport', c.PublicReportDetailSchema], ['viewerReport', c.ViewerReportDetailSchema],
    ['reportAccepted', c.ReportAnalysisSchema], ['reportRetake', c.ReportAnalysisSchema],
    ['analysisRunning', c.ReportAnalysisSchema], ['analysisFailed', c.ReportAnalysisSchema],
    ['cleanupAccepted', c.CleanupAnalysisSchema], ['publication', c.PublicationReceiptSchema],
    ['newVote', c.VoteReceiptSchema], ['replayedVote', c.VoteReceiptSchema],
    ['cleanupPending', c.CleanupReceiptSchema], ['impact', c.ImpactSchema],
    ['reportAnalysisRequest', c.ReportAnalysisRequestSchema], ['cleanupAnalysisRequest', c.CleanupAnalysisRequestSchema],
    ['uploadRequest', c.UploadRequestSchema], ['uploadTicket', c.UploadTicketSchema],
    ['uploadResult', c.UploadResultSchema], ['bootstrap', c.BootstrapReceiptSchema],
    ['notifications', c.NotificationListSchema], ['error', c.ErrorEnvelopeSchema],
  ] as const;
  it.each(cases)('%s validates through the production schema', (name, schema) => {
    expect(schema.safeParse(fixtures[name]).success).toBe(true);
  });
  it('represents two independent vote purposes with uncapped support and private permissions', () => {
    const detail = c.ViewerReportDetailSchema.parse(fixtures.viewerReport);
    expect(detail.openVoteStages).toEqual(['EXISTENCE', 'RESOLUTION']);
    expect(detail.currentStage).toBe('RESOLUTION');
    expect(detail.existenceYesCount).toBe(8);
    expect(detail.viewer.stages.EXISTENCE.canVote).toBe(true);
    expect(detail.viewer.stages.RESOLUTION.canVote).toBe(true);
    expect(fixtures.twoStageVoteRequests).toHaveLength(2);
    expect(fixtures.twoStageVoteRequests.map((entry) => entry.reportId)).toEqual([detail.id, detail.id]);
    expect(fixtures.twoStageVoteRequests.map((entry) => entry.body.stage)).toEqual(detail.openVoteStages);
    expect(new Set(fixtures.twoStageVoteRequests.map((entry) => entry.idempotencyKey)).size).toBe(2);
    for (const entry of fixtures.twoStageVoteRequests) {
      expect(c.UuidSchema.safeParse(entry.idempotencyKey).success).toBe(true);
      expect(c.VoteRequestSchema.safeParse(entry.body).success).toBe(true);
    }
  });
  it('keeps current balance independent from lifetime category earnings and pending RP', () => {
    const impact = c.ImpactSchema.parse(fixtures.impact);
    expect(impact.totals.balanceRp).toBe(-5);
    expect(impact.totals.earnedRp).toBe(60);
    expect(impact.reporter.pendingRp).toBe(15);
    expect(impact.cleaner.pendingRp).toBe(40);
  });
});

describe('strict JSON boundaries', () => {
  it('maps each stable error to a valid HTTP status and enforces its retry policy', () => {
    const validHttpStatuses = new Set([400, 401, 403, 404, 409, 410, 413, 415, 422, 429, 500, 502, 503, 504]);
    for (const [code, policy] of Object.entries(c.API_ERROR_POLICY)) {
      expect(c.ErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(validHttpStatuses.has(policy.httpStatus)).toBe(true);
      const error = { code, message: 'Safe error', requestId: id, retryable: policy.retryable };
      expect(c.ErrorSchema.safeParse(error).success).toBe(true);
      expect(c.ErrorSchema.safeParse({ ...error, retryable: !policy.retryable }).success).toBe(false);
    }
    expect(c.API_ERROR_POLICY.LOCATION_INACCURATE).toEqual({ httpStatus: 422, retryable: true });
    expect(c.API_ERROR_POLICY.AI_TIMEOUT).toEqual({ httpStatus: 504, retryable: true });
    expect(c.API_ERROR_POLICY.INTERNAL_ERROR).toEqual({ httpStatus: 500, retryable: false });
  });
  it.each(['PURPLE', '', null, 3])('rejects bad route %j', (route) => {
    expect(c.RouteSchema.safeParse(route).success).toBe(false);
  });
  it.each(['latitude', 'balance', 'route', 'actor', 'userId', '__proto__'])('rejects authority/unknown field %s', (key) => {
    const body = JSON.parse(JSON.stringify({ ...fixtures.reportAnalysisRequest, [key]: 'injected' }));
    expect(c.ReportAnalysisRequestSchema.safeParse(body).success).toBe(false);
  });
  it.each([NaN, Infinity, -Infinity, '49', 91])('rejects invalid coordinate %j', (lat) => {
    expect(c.PointSchema.safeParse({ lat, lng: 9 }).success).toBe(false);
  });
  it('rejects unknown nested fields and public/private projection leakage', () => {
    expect(c.PublicReportDetailSchema.safeParse({ ...fixtures.publicReport, viewer: fixtures.viewerReport.viewer }).success).toBe(false);
    expect(c.PublicReportDetailSchema.safeParse({ ...fixtures.publicReport, balance: 100 }).success).toBe(false);
    expect(c.PublicIdentitySchema.safeParse({ ...fixtures.publicReport.author, email: 'private@example.test' }).success).toBe(false);
    expect(c.PointSchema.safeParse({ ...fixtures.publicReport.location, accuracyM: 20 }).success).toBe(false);
    expect(c.PublicReportDetailSchema.safeParse({ ...fixtures.publicReport, author: { ...fixtures.publicReport.author, email: 'private' } }).success).toBe(false);
  });
  it('rejects missing, sparse and inherited data', () => {
    expect(object({ value: number(0, 1) }).safeParse(Object.create({ value: 1 })).success).toBe(false);
    expect(array(number(0, 1), 1, 5).safeParse(new Array(2)).success).toBe(false);
    expect(c.EmptyBodySchema.safeParse([]).success).toBe(false);
    expect(c.PointSchema.safeParse({ lat: 0 }).success).toBe(false);
  });
  it.each(['2026-02-30T12:00:00Z', '2026-10-27', '2026-10-27T12:00:00+01:00'])('rejects noncanonical timestamps %s', (timestamp) => {
    expect(c.TimestampSchema.safeParse(timestamp).success).toBe(false);
  });
  it('rejects invalid lengths and versions', () => {
    expect(c.PublishRequestSchema.safeParse({ analysisId: id, description: '' }).success).toBe(false);
    expect(c.PublishRequestSchema.safeParse({ analysisId: id, description: 'x'.repeat(1001) }).success).toBe(false);
    for (const version of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(c.VersionSchema.safeParse(version).success).toBe(false);
    }
  });
  it.each([0, 1, 5, 6])('enforces unique 1–5 photos (%i)', (length) => {
    const photoIds = Array.from({ length }, (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`);
    expect(c.PhotoIdsSchema.safeParse(photoIds).success).toBe(length === 1 || length === 5);
  });
  it('rejects duplicate photo IDs, unsafe URLs and invalid upload scopes', () => {
    expect(c.PhotoIdsSchema.safeParse([id, id]).success).toBe(false);
    expect(c.PhotoSchema.safeParse({ ...fixtures.publicReport.beforePhotos[0], mediaUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(c.UploadRequestSchema.safeParse({ purpose: 'CLEANUP', mimeType: 'image/jpeg', byteSize: 1, ordinal: 1 }).success).toBe(false);
    expect(c.UploadRequestSchema.safeParse({ ...fixtures.uploadRequest, byteSize: c.POLICY.maxPhotoBytes + 1 }).success).toBe(false);
  });
});

describe('execution, assessment and ledger distinctions', () => {
  it('keeps execution state, assessment outcome and RP accounting separate', () => {
    expect(fixtures.analysisRunning.status).toBe('RUNNING');
    expect(fixtures.analysisRunning).not.toHaveProperty('result');
    expect(fixtures.reportAccepted.status).toBe('READY');
    expect(fixtures.reportAccepted.result.decision).toBe('ACCEPT');
    expect(fixtures.reportRetake.status).toBe('READY');
    expect(fixtures.reportRetake.result.decision).toBe('RETAKE');
    expect(fixtures.analysisFailed.status).toBe('FAILED');
    expect(fixtures.impact.totals.balanceRp).toBe(-5);
    expect(fixtures.impact.totals.earnedRp).toBe(60);
    expect(fixtures.impact.reporter.pendingRp).toBe(15);
    expect(fixtures.impact.cleaner.pendingRp).toBe(40);
  });
  it('rejects route-bearing RETAKE and inconsistent ACCEPT safety', () => {
    const retake = fixtures.reportRetake.result;
    expect(c.ReportAssessmentSchema.safeParse({ ...retake, route: 'GREEN' }).success).toBe(false);
    expect(c.ReportAssessmentSchema.safeParse({ ...fixtures.reportAccepted.result, hazardLevel: 'POSSIBLE' }).success).toBe(false);
    expect(c.CleanupAssessmentSchema.safeParse({ ...fixtures.cleanupAccepted.result, appearsClean: false }).success).toBe(false);
  });
  it('requires READY result/expiry, FAILED safe error, and no premature RUNNING result', () => {
    const { result, ...withoutResult } = fixtures.reportAccepted;
    expect(c.ReportAnalysisSchema.safeParse(withoutResult).success).toBe(false);
    expect(c.ReportAnalysisSchema.safeParse({ ...fixtures.analysisRunning, result }).success).toBe(false);
    expect(c.ReportAnalysisSchema.safeParse({ analysisId: id, status: 'FAILED' }).success).toBe(false);
    expect(c.ErrorEnvelopeSchema.safeParse({ error: { ...fixtures.error.error, sql: 'secret' } }).success).toBe(false);
    expect(c.ErrorEnvelopeSchema.safeParse({ error: { ...fixtures.error.error, code: 'CUSTOM' } }).success).toBe(false);
  });
  it('does not repay accepted replay or change confirmed reward policy', () => {
    expect(c.POLICY.reporterInitialRp + c.POLICY.reporterFinalRp).toBe(c.POLICY.reporterTotalRp);
    expect(c.POLICY.reporterTotalRp).toBe(20);
    expect(c.POLICY.cleanerRp).toBe(40);
    expect(c.VoteReceiptSchema.safeParse({ ...fixtures.replayedVote, rpAwarded: 5 }).success).toBe(false);
    expect(c.CleanupReceiptSchema.safeParse({ ...fixtures.cleanupPending, provisionalRp: 50 }).success).toBe(false);
    expect(c.CleanupReceiptSchema.safeParse({ ...fixtures.cleanupPending, balance: 40 }).success).toBe(false);
  });
  it('distinguishes a new publication from a replay carrying a current report snapshot', () => {
    expect(fixtures.publication.report.status).toBe('AWAITING_EXISTENCE');
    expect(fixtures.publication.report.existenceYesCount).toBe(0);
    expect(c.PublicationReceiptSchema.safeParse({ ...fixtures.publication, report: fixtures.viewerReport }).success).toBe(false);
    expect(c.PublicationReceiptSchema.safeParse({ ...fixtures.publication, rpAwarded: 0, report: fixtures.viewerReport }).success).toBe(true);
    expect(fixtures.cleanupPending.report.resolutionYesCount).toBe(0);
    expect(c.CleanupReceiptSchema.safeParse({ ...fixtures.cleanupPending, report: fixtures.publication.report }).success).toBe(false);
    expect(c.CleanupReceiptSchema.safeParse({ ...fixtures.cleanupPending,
      report: { ...fixtures.viewerReport, status: 'RESOLVED', resolutionYesCount: 3, currentStage: null,
        openVoteStages: [], viewer: { stages: {
          EXISTENCE: { canVote: false, reason: 'STAGE_CLOSED', hasVoted: false },
          RESOLUTION: { canVote: false, reason: 'STAGE_CLOSED', hasVoted: false },
        }, canSubmitCleanup: false } } }).success).toBe(true);
  });
  it('rejects contradictory lifecycle and permissions', () => {
    expect(c.PublicReportDetailSchema.safeParse({ ...fixtures.publicReport, currentStage: 'EXISTENCE' }).success).toBe(false);
    expect(c.PublicReportDetailSchema.safeParse({ ...fixtures.publicReport, resolutionYesCount: 4 }).success).toBe(false);
    expect(c.PublicReportDetailSchema.safeParse({ ...fixtures.publicReport, openVoteStages: ['RESOLUTION'] }).success).toBe(false);
    expect(c.ViewerReportDetailSchema.safeParse({ ...fixtures.viewerReport,
      viewer: { ...fixtures.viewerReport.viewer, canSubmitCleanup: true } }).success).toBe(false);
    expect(c.ViewerSchema.safeParse({ ...fixtures.viewerReport.viewer,
      stages: { ...fixtures.viewerReport.viewer.stages,
        EXISTENCE: { canVote: false, reason: 'ALREADY_VOTED', hasVoted: false } } }).success).toBe(false);
  });
  it.each([
    { status: 'RESOLVED', resolutionYesCount: 0 },
    { status: 'AWAITING_EXISTENCE', existenceYesCount: 8 },
    { status: 'VERIFIED', resolutionYesCount: 1 },
    { route: 'YELLOW', status: 'AWAITING_RESOLUTION' },
    { existenceYesCount: 0, lastExistenceConfirmedAt: null },
  ])('rejects contradictory list/Impact summaries %j', (change) => {
    const summary = { ...fixtures.impact.items[0].report, ...change };
    expect(c.ReportSummarySchema.safeParse(summary).success).toBe(false);
    expect(c.ReportListSchema.safeParse({ items: [summary], nextCursor: null }).success).toBe(false);
    expect(c.ImpactSchema.safeParse({ ...fixtures.impact,
      items: [{ ...fixtures.impact.items[0], report: summary }] }).success).toBe(false);
  });
});

describe('new-action location admission (not replay freshness)', () => {
  it('accepts 50m accuracy and 60s age, rejects older/future/worse fixes', () => {
    expect(locationAdmission(location, now)).toBeNull();
    expect(locationAdmission({ ...location, accuracyM: 50.001 }, now)).toBe('LOCATION_INACCURATE');
    expect(locationAdmission(location, now + 1)).toBe('LOCATION_STALE');
    expect(locationAdmission({ ...location, observedAt: '2026-10-27T12:00:00.001Z' }, now)).toBe('LOCATION_STALE');
  });
  it('uses measured distance without adding accuracy, testing either side of 150m', () => {
    const at = (m: number) => ({ lat: m / 6_371_000 * 180 / Math.PI, lng: 0 });
    const zero = { ...location, lat: 0, lng: 0 };
    expect(distanceM(zero, at(149.999))).toBeCloseTo(149.999, 6);
    expect(locationAdmission(zero, now, at(149.999))).toBeNull();
    expect(locationAdmission(zero, now, at(150.001))).toBe('TOO_FAR');
    // Exact radius comparator is inclusive, independent from the spherical calculation.
    const edge = distanceM(zero, at(150));
    expect(locationAdmission(zero, now, at(150), edge)).toBeNull();
  });
  it('enforces the separate 3m report pin adjustment', () => {
    expect(reportPinAdmission(location, location, now)).toBeNull();
    expect(reportPinAdmission(location, { lat: 49.141, lng: 9.22 }, now)).toBe('PIN_TOO_FAR');
    const zero = { ...location, lat: 0, lng: 0 };
    const at = (m: number) => ({ lat: m / 6_371_000 * 180 / Math.PI, lng: 0 });
    expect(reportPinAdmission(zero, at(2.999), now)).toBeNull();
    expect(reportPinAdmission(zero, at(3), now)).toBeNull();
    expect(reportPinAdmission(zero, at(3.001), now)).toBe('PIN_TOO_FAR');
  });
});
