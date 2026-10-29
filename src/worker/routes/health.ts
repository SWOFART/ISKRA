import { Hono } from 'hono';
import type { WorkerEnv } from '../middleware/context';

export function createHealthRoutes() {
  return new Hono<WorkerEnv>().get('/health', (c) => c.json({
    ok: true,
    release: c.env.RELEASE_SHA ?? 'local',
    applicationReady: false,
  }));
}
