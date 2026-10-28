import type { ReportSummary } from '../shared/contracts';

export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}
export interface MapPoint {
  x: number;
  y: number;
}

export interface ReportCluster extends MapPoint {
  id: string;
  reports: ReportSummary[];
}

export type LocationProjector = (location: ReportSummary['location']) => MapPoint | null;

const WORLD_WIDTH = 1000;
const WORLD_HEIGHT = 700;
export function cityViewport(center: { latitude: number; longitude: number }): GeoBounds {
  return {
    west: center.longitude - 0.08,
    east: center.longitude + 0.08,
    south: center.latitude - 0.045,
    north: center.latitude + 0.045,
  };
}

export function projectLocation(
  location: ReportSummary['location'],
  bounds: GeoBounds,
  width = WORLD_WIDTH,
  height = WORLD_HEIGHT,
): MapPoint | null {
  if (location.lng < bounds.west || location.lng > bounds.east
    || location.lat < bounds.south || location.lat > bounds.north) return null;
  return {
    x: ((location.lng - bounds.west) / (bounds.east - bounds.west)) * width,
    y: ((bounds.north - location.lat) / (bounds.north - bounds.south)) * height,
  };
}

export function clusterReports(
  reports: readonly ReportSummary[],
  bounds: GeoBounds,
  radius = 54,
  width = WORLD_WIDTH,
  height = WORLD_HEIGHT,
  projector?: LocationProjector,
): ReportCluster[] {
  const groups: ReportCluster[] = [];
  const bins = new Map<string, Set<ReportCluster>>();
  const cellSize = radius;
  const keyFor = (point: MapPoint) => `${Math.floor(point.x / cellSize)},${Math.floor(point.y / cellSize)}`;
  const addToBin = (cluster: ReportCluster) => {
    const key = keyFor(cluster);
    const bin = bins.get(key) ?? new Set<ReportCluster>();
    bin.add(cluster);
    bins.set(key, bin);
  };
  const removeFromBin = (cluster: ReportCluster) => {
    const key = keyFor(cluster);
    const bin = bins.get(key);
    bin?.delete(cluster);
    if (bin?.size === 0) bins.delete(key);
  };

  for (const report of [...reports].sort((a, b) => a.id.localeCompare(b.id))) {
    const point = projector
      ? projector(report.location)
      : projectLocation(report.location, bounds, width, height);
    if (!point) continue;

    const [column, row] = keyFor(point).split(',').map(Number);
    let nearest: ReportCluster | undefined;
    let nearestDistance = radius;
    for (let y = row - 1; y <= row + 1; y += 1) {
      for (let x = column - 1; x <= column + 1; x += 1) {
        for (const candidate of bins.get(`${x},${y}`) ?? []) {
          const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y);
          if (distance <= nearestDistance) {
            nearest = candidate;
            nearestDistance = distance;
          }
        }
      }
    }

    if (!nearest) {
      const cluster: ReportCluster = { id: report.id, x: point.x, y: point.y, reports: [report] };
      groups.push(cluster);
      addToBin(cluster);
      continue;
    }

    removeFromBin(nearest);
    const count = nearest.reports.length;
    nearest.x = ((nearest.x * count) + point.x) / (count + 1);
    nearest.y = ((nearest.y * count) + point.y) / (count + 1);
    nearest.reports.push(report);
    addToBin(nearest);
  }

  return groups.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function viewportForReports(
  reports: readonly ReportSummary[],
  fallback: GeoBounds,
): GeoBounds {
  if (reports.length === 0) return fallback;
  const locations = reports.map(({ location }) => location);
  const west = Math.min(...locations.map(({ lng }) => lng));
  const east = Math.max(...locations.map(({ lng }) => lng));
  const south = Math.min(...locations.map(({ lat }) => lat));
  const north = Math.max(...locations.map(({ lat }) => lat));
  const latitudeSpan = Math.max(north - south, 0.012);
  const longitudeSpan = Math.max(east - west, 0.018);
  const latitudePadding = latitudeSpan * 0.25;
  const longitudePadding = longitudeSpan * 0.25;

  return {
    west: west - longitudePadding,
    east: east + longitudePadding,
    south: south - latitudePadding,
    north: north + latitudePadding,
  };
}
