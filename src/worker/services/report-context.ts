import type { Point, ReportSummary } from '../../shared/contracts';

/** Minimal private context C needs to bind cleanup analysis to the before evidence. */
export interface ReportContext {
  readonly reportId: ReportSummary['id'];
  readonly route: ReportSummary['route'];
  readonly status: ReportSummary['status'];
  readonly beforePhotoIds: readonly string[];
  /** Stable SHA-256 identity of the immutable before-photo set, not report.version. */
  readonly beforeEvidenceHash: string;
  readonly reportLocation: Point;
  readonly description: ReportSummary['description'];
}

/** C reads this narrow view before provider work; implementations keep SQL details in B. */
export interface ReportContextReader {
  getForCleanupAnalysis(reportId: ReportContext['reportId']): Promise<ReportContext | null>;
}
