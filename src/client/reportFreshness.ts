import type { ReportSummary } from '../shared/contracts';

/**
 * The subset of a report snapshot that decides committed progress.
 * Reports may be read from independent endpoints (list, detail, Impact,
 * receipts), so a late response can carry an older snapshot than the one the
 * resident already sees.
 */
export type ReportProgress = Pick<
  ReportSummary,
  'version' | 'status' | 'existenceYesCount' | 'resolutionYesCount'
>;

const lifecycleRank: Record<ReportSummary['status'], number> = {
  AWAITING_EXISTENCE: 0,
  VERIFIED: 1,
  AWAITING_RESOLUTION: 2,
  RESOLVED: 3,
};

/**
 * Orders two snapshots of the same report.
 *
 * A positive result means `next` is more advanced than `current`, so it may
 * replace it; zero means they show the same progress. A negative result means `next` would display an older lifecycle,
 * fewer confirmations or an older version and must not overwrite committed data.
 * Equal versions are compared by lifecycle progress, which keeps a delayed `2/3`
 * payload from replacing a committed `3/3` one.
 */
export function compareReportProgress(current: ReportProgress, next: ReportProgress): number {
  if (next.version !== current.version) return next.version - current.version;
  const lifecycle = lifecycleRank[next.status] - lifecycleRank[current.status];
  if (lifecycle !== 0) return lifecycle;
  const existence = next.existenceYesCount - current.existenceYesCount;
  if (existence !== 0) return existence;
  return next.resolutionYesCount - current.resolutionYesCount;
}

/** Returns whichever snapshot keeps the committed report progress. */
export function selectNewerReport<T extends ReportProgress>(current: T | undefined, next: T): T {
  return current && compareReportProgress(current, next) < 0 ? current : next;
}

/** True when `next` would regress progress that the resident already sees. */
export function isStaleReportSnapshot(current: ReportProgress, next: ReportProgress): boolean {
  return compareReportProgress(current, next) < 0;
}

/** True when `next` may replace `current` without losing committed progress. */
export function isNewerReportSnapshot(current: ReportProgress, next: ReportProgress): boolean {
  return compareReportProgress(current, next) > 0;
}
