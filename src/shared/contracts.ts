import { array, boolean, enumeration, literal, nullable, number, object, string, union, type Infer } from './schema';

export const CONTRACT_REVISION = 'v1-candidate.2' as const;
export const POLICY = Object.freeze({
  voteRadiusM: 150, cleanupRadiusM: 150, maxAccuracyM: 50, maxLocationAgeSeconds: 60,
  maxPinDisplacementM: 3, reporterTotalRp: 20, reporterInitialRp: 5,
  reporterFinalRp: 15, cleanerRp: 40, voteRp: 5, maxPhotoBytes: 1_048_576,
});
export const RouteSchema = enumeration(['GREEN', 'YELLOW', 'RED']);
export const ReportStatusSchema = enumeration(['AWAITING_EXISTENCE', 'VERIFIED', 'AWAITING_RESOLUTION', 'RESOLVED']);
export const StageSchema = enumeration(['EXISTENCE', 'RESOLUTION']);
export const ChoiceSchema = enumeration(['YES', 'NO']);
export const PhotoPurposeSchema = enumeration(['REPORT', 'CLEANUP']);
export const PhotoStateSchema = enumeration(['RESERVED', 'UPLOADED', 'ATTACHED']);
export const AnalysisStatusSchema = enumeration(['RUNNING', 'READY', 'FAILED']);
export const LocaleSchema = enumeration(['en', 'de']);
export const UuidSchema = string(36, 36, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export const UidSchema = string(1, 128).refine((v) => v.trim().length > 0, 'Empty UID');
export const TimestampSchema = string(20, 24, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine((v) => Number.isFinite(Date.parse(v))
    && new Date(v).toISOString() === v.replace(/Z$/, v.includes('.') ? 'Z' : '.000Z'), 'Invalid UTC timestamp');
const count = number(0, Number.MAX_SAFE_INTEGER, true);
export const VersionSchema = number(0, Number.MAX_SAFE_INTEGER, true);
export const BalanceSchema = number(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true);
export const PointSchema = object({ lat: number(-90, 90), lng: number(-180, 180) });
export const LocationSchema = object({
  lat: number(-90, 90), lng: number(-180, 180), accuracyM: number(0, POLICY.maxAccuracyM),
  observedAt: TimestampSchema,
});
export type Point = Infer<typeof PointSchema>;
export type Location = Infer<typeof LocationSchema>;
export type Stage = Infer<typeof StageSchema>;
export type Route = Infer<typeof RouteSchema>;

export const ErrorCodeSchema = enumeration([
  'INVALID_INPUT', 'UNAUTHENTICATED', 'SELF_VOTE', 'NOT_ELIGIBLE', 'TOO_FAR', 'FORBIDDEN',
  'NOT_FOUND', 'ALREADY_VOTED', 'STAGE_CLOSED', 'IDEMPOTENCY_CONFLICT', 'ANALYSIS_CONSUMED',
  'CLEANUP_ALREADY_SUBMITTED', 'INSUFFICIENT_RP', 'PRICE_CHANGED', 'EXPIRED', 'PHOTO_TOO_LARGE',
  'UNSUPPORTED_MEDIA', 'LOCATION_INACCURATE', 'LOCATION_STALE', 'PIN_TOO_FAR', 'AI_UNCERTAIN',
  'AI_REJECTED', 'RATE_LIMITED', 'AI_INVALID_OUTPUT', 'AI_UNAVAILABLE', 'DATABASE_UNAVAILABLE',
  'AI_TIMEOUT', 'UNAVAILABLE', 'INTERNAL_ERROR',
]);
export type ErrorCode = Infer<typeof ErrorCodeSchema>;
export type ApiErrorHttpStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 502 | 503 | 504;
const apiErrorPolicy = {
  INVALID_INPUT: { httpStatus: 400, retryable: false },
  UNAUTHENTICATED: { httpStatus: 401, retryable: false },
  SELF_VOTE: { httpStatus: 403, retryable: false },
  NOT_ELIGIBLE: { httpStatus: 403, retryable: false },
  TOO_FAR: { httpStatus: 403, retryable: true },
  FORBIDDEN: { httpStatus: 403, retryable: false },
  NOT_FOUND: { httpStatus: 404, retryable: false },
  ALREADY_VOTED: { httpStatus: 409, retryable: false },
  STAGE_CLOSED: { httpStatus: 409, retryable: false },
  IDEMPOTENCY_CONFLICT: { httpStatus: 409, retryable: false },
  ANALYSIS_CONSUMED: { httpStatus: 409, retryable: false },
  CLEANUP_ALREADY_SUBMITTED: { httpStatus: 409, retryable: false },
  INSUFFICIENT_RP: { httpStatus: 409, retryable: false },
  PRICE_CHANGED: { httpStatus: 409, retryable: false },
  EXPIRED: { httpStatus: 410, retryable: true },
  PHOTO_TOO_LARGE: { httpStatus: 413, retryable: false },
  UNSUPPORTED_MEDIA: { httpStatus: 415, retryable: false },
  LOCATION_INACCURATE: { httpStatus: 422, retryable: true },
  LOCATION_STALE: { httpStatus: 422, retryable: true },
  PIN_TOO_FAR: { httpStatus: 422, retryable: true },
  AI_UNCERTAIN: { httpStatus: 422, retryable: true },
  AI_REJECTED: { httpStatus: 422, retryable: true },
  RATE_LIMITED: { httpStatus: 429, retryable: true },
  AI_INVALID_OUTPUT: { httpStatus: 502, retryable: true },
  AI_UNAVAILABLE: { httpStatus: 503, retryable: true },
  DATABASE_UNAVAILABLE: { httpStatus: 503, retryable: true },
  AI_TIMEOUT: { httpStatus: 504, retryable: true },
  UNAVAILABLE: { httpStatus: 503, retryable: true },
  INTERNAL_ERROR: { httpStatus: 500, retryable: false },
} as const satisfies Record<ErrorCode, { httpStatus: ApiErrorHttpStatus; retryable: boolean }>;
export const API_ERROR_POLICY = Object.freeze(apiErrorPolicy);
export const ErrorSchema = object({
  code: ErrorCodeSchema, message: string(1, 500), requestId: UuidSchema, retryable: boolean,
}).refine((value) => API_ERROR_POLICY[value.code].retryable === value.retryable,
  'Error retryability does not match the v1 policy');
export const ErrorEnvelopeSchema = object({ error: ErrorSchema });
export const PhotoIdsSchema = array(UuidSchema, 1, 5)
  .refine((v) => new Set(v).size === v.length, 'Photo IDs must be unique');
export const PublicIdentitySchema = object({ id: UidSchema, nickname: string(1, 80), avatar: string(1, 80) });
const mediaUrl = string(1, 2048).refine((v) => {
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}, 'Expected an HTTPS media capability');
export const PhotoSchema = object({
  id: UuidSchema, ordinal: number(1, 5, true), mediaUrl, expiresAt: TimestampSchema,
});
const gallery = (min: number) => array(PhotoSchema, min, 5).refine(
  (v) => new Set(v.map((p) => p.id)).size === v.length
    && v.every((p, i) => p.ordinal === i + 1), 'Photos must be unique and ordered from ordinal 1');

const summaryFields = {
  id: UuidSchema, route: RouteSchema, status: ReportStatusSchema, location: PointSchema,
  coverPhotoId: UuidSchema, description: string(1, 1000), existenceYesCount: count,
  resolutionYesCount: number(0, 3, true), existenceVerifiedAt: nullable(TimestampSchema),
  lastExistenceConfirmedAt: nullable(TimestampSchema), version: VersionSchema,
  updatedAt: TimestampSchema, isDemo: boolean,
};
const reportSummaryShape = object(summaryFields);
export type ReportSummary = Infer<typeof reportSummaryShape>;
function consistentSummary(v: ReportSummary): boolean {
  return (v.status === 'AWAITING_EXISTENCE' ? v.existenceYesCount < 3 && v.existenceVerifiedAt === null
    : v.existenceYesCount >= 3 && v.existenceVerifiedAt !== null)
    && (v.existenceYesCount === 0 ? v.lastExistenceConfirmedAt === null : v.lastExistenceConfirmedAt !== null)
    && (v.status === 'RESOLVED' ? v.resolutionYesCount === 3
      : v.status === 'AWAITING_RESOLUTION' ? v.resolutionYesCount < 3 : v.resolutionYesCount === 0)
    && (!['AWAITING_RESOLUTION', 'RESOLVED'].includes(v.status) || v.route === 'GREEN');
}
export const ReportSummarySchema = reportSummaryShape.refine(consistentSummary, 'Inconsistent report lifecycle');
const detailFields = {
  ...summaryFields, beforePhotos: gallery(1), afterPhotos: gallery(0), author: PublicIdentitySchema,
  cleaner: nullable(PublicIdentitySchema), currentStage: nullable(StageSchema),
  openVoteStages: array(StageSchema, 0, 2).refine((v) => new Set(v).size === v.length, 'Duplicate stages'),
};
type Detail = Infer<ReturnType<typeof object<typeof detailFields>>>;
function consistentDetail(v: Detail): boolean {
  const expected: Stage[] = v.status === 'RESOLVED' ? []
    : v.status === 'AWAITING_RESOLUTION' ? ['EXISTENCE', 'RESOLUTION'] : ['EXISTENCE'];
  const current = v.status === 'RESOLVED' ? null
    : v.status === 'AWAITING_RESOLUTION' ? 'RESOLUTION' : 'EXISTENCE';
  return consistentSummary(v)
    && v.openVoteStages.length === expected.length && expected.every((s) => v.openVoteStages.includes(s))
    && v.currentStage === current && v.coverPhotoId === v.beforePhotos[0].id
    && (['AWAITING_RESOLUTION', 'RESOLVED'].includes(v.status)
      ? v.route === 'GREEN' && v.afterPhotos.length > 0 && v.cleaner !== null
      : v.afterPhotos.length === 0 && v.cleaner === null && v.resolutionYesCount === 0);
}
export const PublicReportDetailSchema = object(detailFields).refine(consistentDetail, 'Inconsistent report lifecycle');
export const VotePermissionReasonSchema = enumeration([
  'UNAUTHENTICATED', 'SELF_VOTE', 'ALREADY_VOTED', 'STAGE_CLOSED', 'NOT_ELIGIBLE',
]);
const permission = object({ canVote: boolean, reason: nullable(VotePermissionReasonSchema), hasVoted: boolean })
  .refine((v) => (v.canVote ? v.reason === null && !v.hasVoted : v.reason !== null)
    && (v.reason !== 'ALREADY_VOTED' || v.hasVoted), 'Inconsistent permission');
export const ViewerSchema = object({
  stages: object({ EXISTENCE: permission, RESOLUTION: permission }), canSubmitCleanup: boolean,
});
export const ViewerReportDetailSchema = object({ ...detailFields, viewer: ViewerSchema })
  .refine(consistentDetail, 'Inconsistent report lifecycle')
  .refine((v) => (['EXISTENCE', 'RESOLUTION'] as const).every((s) =>
    !v.viewer.stages[s].canVote || v.openVoteStages.includes(s))
    && (!v.viewer.canSubmitCleanup || (v.route === 'GREEN' && v.status === 'VERIFIED')),
  'Permission requires an open operation');
export const ReportDetailSchema = union(PublicReportDetailSchema, ViewerReportDetailSchema);
export const ReportListSchema = object({ items: array(ReportSummarySchema, 0, 100), nextCursor: nullable(string(1, 512)) });

export const RetakeReasonSchema = enumeration([
  'INSUFFICIENT_EVIDENCE', 'DIFFERENT_SCENE', 'LITTER_REMAINING', 'HAZARD_REMAINING',
]);
const retake = object({
  decision: literal('RETAKE'), reasonCode: RetakeReasonSchema, reason: string(1, 500), instruction: string(1, 500),
});
const reportAccept = object({
  decision: literal('ACCEPT'), route: RouteSchema, description: string(1, 1000),
  hazardLevel: enumeration(['NONE', 'POSSIBLE', 'URGENT']), safetyMessage: string(0, 500),
  reason: string(1, 500), confidence: number(0, 1),
}).refine((v) => v.hazardLevel === 'NONE' || (v.route === 'RED' && v.safetyMessage.trim().length > 0),
  'Hazard requires RED guidance');
const cleanupAccept = object({
  decision: literal('ACCEPT'), sameScene: literal('LIKELY'), appearsClean: literal(true),
  hazardRemaining: literal(false), reason: string(1, 500), confidence: number(0, 1),
});
export const ReportAssessmentSchema = union(reportAccept, retake);
export const CleanupAssessmentSchema = union(cleanupAccept, retake);
const analysisEnvelope = <T>(result: import('./schema').Schema<T>) => union(
  object({ analysisId: UuidSchema, status: literal('RUNNING') }),
  object({ analysisId: UuidSchema, status: literal('READY'), result, expiresAt: TimestampSchema }),
  object({ analysisId: UuidSchema, status: literal('FAILED'), error: ErrorSchema }),
);
export const ReportAnalysisSchema = analysisEnvelope(ReportAssessmentSchema);
export const CleanupAnalysisSchema = analysisEnvelope(CleanupAssessmentSchema);

export const EmptyBodySchema = object({});
export const ReportAnalysisRequestSchema = object({
  photoIds: PhotoIdsSchema, comment: string(0, 1000), measuredLocation: LocationSchema,
  pin: PointSchema, cityId: literal('heilbronn'), outputLocale: LocaleSchema,
});
export const CleanupAnalysisRequestSchema = object({
  reportId: UuidSchema, photoIds: PhotoIdsSchema, location: LocationSchema, outputLocale: LocaleSchema,
});
export const PublishRequestSchema = object({ analysisId: UuidSchema, description: string(1, 1000) });
export const VoteRequestSchema = object({ stage: StageSchema, choice: ChoiceSchema, location: LocationSchema });
export const CleanupRequestSchema = object({ analysisId: UuidSchema });
const uploadFields = { mimeType: literal('image/jpeg'), byteSize: number(1, POLICY.maxPhotoBytes, true), ordinal: number(1, 5, true) };
export const UploadRequestSchema = union(
  object({ purpose: literal('REPORT'), ...uploadFields }),
  object({ purpose: literal('CLEANUP'), reportId: UuidSchema, ...uploadFields }),
);
export const UploadTicketSchema = object({ photoId: UuidSchema, uploadUrl: mediaUrl, expiresAt: TimestampSchema, maxBytes: literal(POLICY.maxPhotoBytes) });
export const UploadResultSchema = object({ photoId: UuidSchema, state: literal('UPLOADED') });
export const BootstrapRequestSchema = object({});
export const BootstrapReceiptSchema = object({ user: PublicIdentitySchema, balance: BalanceSchema, balanceVersion: VersionSchema });
const privateBalance = { balance: BalanceSchema, balanceVersion: VersionSchema };
export const PublicationReceiptSchema = object({ report: ViewerReportDetailSchema, rpAwarded: union(literal(0), literal(5)), ...privateBalance })
  .refine((v) => v.rpAwarded === 0 || (v.report.status === 'AWAITING_EXISTENCE'
    && v.report.existenceYesCount === 0), 'New publication must return its initial committed state');
export const VoteReceiptSchema = object({
  voteId: UuidSchema, replayed: boolean, rpAwarded: union(literal(0), literal(5)),
  ...privateBalance, report: ViewerReportDetailSchema,
}).refine((v) => v.replayed ? v.rpAwarded === 0 : v.rpAwarded === 5, 'Replay cannot repay');
export const CleanupReceiptSchema = object({
  cleanupId: UuidSchema, status: literal('AWAITING_VERIFICATION'), provisionalRp: literal(40), report: ViewerReportDetailSchema,
}).refine((v) => ['AWAITING_RESOLUTION', 'RESOLVED'].includes(v.report.status), 'Receipt requires an accepted cleanup');
export const ImpactRoleSchema = enumeration(['REPORTER', 'CLEANER', 'VERIFIER']);
export const ImpactSchema = object({
  reporter: object({ created: count, inProgress: count, resolved: count, earnedRp: count, pendingRp: count }),
  cleaner: object({ submitted: count, pending: count, verified: count, earnedRp: count, pendingRp: count }),
  verification: object({ acceptedVotes: count, confirmedReports: count, earnedRp: count }),
  totals: object({ earnedRp: count, balanceRp: BalanceSchema }), impactScore: literal(null),
  impactScoreState: literal('NOT_CONFIGURED'), balanceVersion: VersionSchema,
  items: array(object({ report: ReportSummarySchema, roles: array(ImpactRoleSchema, 1, 3)
    .refine((v) => new Set(v).size === v.length, 'Duplicate role'), lastUpdatedAt: TimestampSchema }), 0, 100),
  nextCursor: nullable(string(1, 512)),
}).refine((v) => v.reporter.created === v.reporter.inProgress + v.reporter.resolved
  && v.cleaner.submitted === v.cleaner.pending + v.cleaner.verified
  && v.totals.earnedRp === v.reporter.earnedRp + v.cleaner.earnedRp + v.verification.earnedRp
  && v.verification.confirmedReports <= v.verification.acceptedVotes, 'Inconsistent role totals');
export const NotificationSchema = object({
  id: UuidSchema, kind: enumeration(['EXISTENCE_VERIFIED', 'REPORT_RESOLVED']),
  message: string(1, 500), reportId: UuidSchema, readAt: nullable(TimestampSchema),
});
export const NotificationListSchema = object({ items: array(NotificationSchema, 0, 100), nextCursor: nullable(string(1, 512)) });
export const NotificationReadRequestSchema = object({ read: literal(true) });
export const NotificationReadReceiptSchema = object({ id: UuidSchema, readAt: TimestampSchema });

export type ReportDetail = Infer<typeof ReportDetailSchema>;
export type ViewerReportDetail = Infer<typeof ViewerReportDetailSchema>;
export type ReportAnalysis = Infer<typeof ReportAnalysisSchema>;
export type CleanupAnalysis = Infer<typeof CleanupAnalysisSchema>;
export type Impact = Infer<typeof ImpactSchema>;
