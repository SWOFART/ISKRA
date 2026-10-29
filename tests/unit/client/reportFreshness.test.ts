import { describe, expect, it } from 'vitest';
import {
  compareReportProgress, isNewerReportSnapshot, isStaleReportSnapshot, selectNewerReport,
} from '../../../src/client/reportFreshness';

function snapshot(overrides: Partial<{
  version: number;
  status: 'AWAITING_EXISTENCE' | 'VERIFIED' | 'AWAITING_RESOLUTION' | 'RESOLVED';
  existenceYesCount: number;
  resolutionYesCount: number;
}> = {}) {
  return {
    version: 1,
    status: 'AWAITING_RESOLUTION' as const,
    existenceYesCount: 3,
    resolutionYesCount: 2,
    ...overrides,
  };
}

describe('report snapshot ordering', () => {
  it('accepts a newer version even when its lifecycle looks smaller', () => {
    const committed = snapshot({ version: 6, status: 'RESOLVED', resolutionYesCount: 3 });
    const next = snapshot({ version: 7, status: 'RESOLVED', resolutionYesCount: 3, existenceYesCount: 4 });
    expect(compareReportProgress(committed, next)).toBeGreaterThan(0);
    expect(isStaleReportSnapshot(committed, next)).toBe(false);
  });

  it('rejects an older version that would replace committed 3/3 with 2/3', () => {
    const committed = snapshot({ version: 6, status: 'AWAITING_RESOLUTION', resolutionYesCount: 3 });
    const stale = snapshot({ version: 5, status: 'AWAITING_RESOLUTION', resolutionYesCount: 2 });
    expect(compareReportProgress(committed, stale)).toBeLessThan(0);
    expect(isStaleReportSnapshot(committed, stale)).toBe(true);
    expect(selectNewerReport(committed, stale)).toBe(committed);
  });

  it('keeps lifecycle and confirmation progress for an equal version', () => {
    const committed = snapshot({ version: 6, status: 'RESOLVED', resolutionYesCount: 3 });
    const stale = snapshot({ version: 6, status: 'VERIFIED', resolutionYesCount: 0 });
    expect(isStaleReportSnapshot(committed, stale)).toBe(true);

    const moreSupport = snapshot({ version: 6, status: 'RESOLVED', resolutionYesCount: 3, existenceYesCount: 5 });
    expect(compareReportProgress(committed, moreSupport)).toBeGreaterThan(0);
  });

  it('never regresses continued AWAITING_RESOLUTION support to VERIFIED', () => {
    const committed = snapshot({ version: 6, status: 'AWAITING_RESOLUTION', existenceYesCount: 9, resolutionYesCount: 1 });
    const stale = snapshot({ version: 6, status: 'VERIFIED', existenceYesCount: 8, resolutionYesCount: 0 });
    expect(isStaleReportSnapshot(committed, stale)).toBe(true);
    expect(selectNewerReport(committed, stale)).toBe(committed);
  });

  it('does not regress AWAITING_RESOLUTION support to an earlier confirmation count', () => {
    const committed = snapshot({ version: 6, resolutionYesCount: 2, existenceYesCount: 4 });
    const stale = snapshot({ version: 6, resolutionYesCount: 2, existenceYesCount: 3 });
    expect(selectNewerReport(committed, stale)).toBe(committed);
  });

  it('returns the incoming snapshot when nothing is committed yet', () => {
    const next = snapshot();
    expect(selectNewerReport(undefined, next)).toBe(next);
    expect(compareReportProgress(next, next)).toBe(0);
  });

  it('separates the newer- and stale-snapshot predicates in opposite directions', () => {
    const committed = snapshot({ version: 6, status: 'AWAITING_RESOLUTION', resolutionYesCount: 2 });
    const stale = snapshot({ version: 6, status: 'AWAITING_EXISTENCE', existenceYesCount: 2, resolutionYesCount: 0 });
    expect(isNewerReportSnapshot(committed, stale)).toBe(false);
    expect(isStaleReportSnapshot(committed, stale)).toBe(true);
    expect(isNewerReportSnapshot(stale, committed)).toBe(true);
    expect(isStaleReportSnapshot(stale, committed)).toBe(false);
  });
});