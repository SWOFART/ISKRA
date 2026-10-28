import { describe, expect, it } from 'vitest';
import { ReportSummarySchema } from '../../../src/shared/contracts';
import { clusterReports, cityViewport, projectLocation, viewportForReports } from '../../../src/client/mapModel';

function report(id: string, lat: number, lng: number, route: 'GREEN' | 'YELLOW' | 'RED' = 'GREEN') {
  return ReportSummarySchema.parse({
    id,
    route,
    status: 'AWAITING_EXISTENCE',
    location: { lat, lng },
    coverPhotoId: '22222222-2222-4222-8222-222222222222',
    description: 'Litter beside the path.',
    existenceYesCount: 1,
    resolutionYesCount: 0,
    existenceVerifiedAt: null,
    lastExistenceConfirmedAt: '2026-10-27T12:00:00.000Z',
    version: 1,
    updatedAt: '2026-10-27T12:00:00.000Z',
    isDemo: false,
  });
}

describe('report map projection and clustering', () => {
  const bounds = { west: 9.1, south: 49.1, east: 9.3, north: 49.2 };

  it('projects Heilbronn coordinates into the city overview and excludes offscreen points', () => {
    const center = projectLocation({ lat: 49.15, lng: 9.2 }, bounds);
    expect(center?.x).toBeCloseTo(500);
    expect(center?.y).toBeCloseTo(350);
    expect(projectLocation({ lat: 49.21, lng: 9.2 }, bounds)).toBeNull();
    expect(cityViewport({ latitude: 49.14, longitude: 9.22 })).toMatchObject({
      west: 9.14,
      east: 9.3,
      south: 49.095,
      north: 49.185,
    });
  });

  it('groups nearby reports and keeps distant reports as separate markers', () => {
    const groups = clusterReports([
      report('33333333-3333-4333-8333-333333333333', 49.15, 9.2),
      report('44444444-4444-4444-8444-444444444444', 49.1505, 9.2005, 'RED'),
      report('55555555-5555-4555-8555-555555555555', 49.19, 9.29, 'YELLOW'),
    ], bounds);

    expect(groups.map(({ reports: members }) => members.map(({ id }) => id))).toEqual([
      ['55555555-5555-4555-8555-555555555555'],
      ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'],
    ]);
  });

  it('fits the selected report extent with padding and uses the city bounds for an empty set', () => {
    const fallback = cityViewport({ latitude: 49.14, longitude: 9.22 });
    const fitted = viewportForReports([
      report('66666666-6666-4666-8666-666666666666', 49.13, 9.2),
      report('77777777-7777-4777-8777-777777777777', 49.15, 9.24),
    ], fallback);

    expect(fitted).toEqual({ west: 9.19, east: 9.25, south: 49.125, north: 49.155 });
    expect(viewportForReports([], fallback)).toBe(fallback);
  });
});
