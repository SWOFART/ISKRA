import { describe, expect, it } from 'vitest';
import {
  assertDemoSeedTarget,
  demoSeedPhotoObjectKeys,
  type DemoSeedTarget,
} from '../../../src/worker/services/demo-seeds';

const sandbox: DemoSeedTarget = {
  protocol: 'postgres:',
  hostname: '127.0.0.1',
  port: 55432,
  database: 'iskra_test',
  user: 'iskra_test',
  hasSearch: false,
  hasHash: false,
  appEnvironment: 'demo',
  demoData: 'true',
};

describe('demo seed target guard', () => {
  it('accepts only the marked loopback test database and explicit demo environment', () => {
    expect(() => assertDemoSeedTarget(sandbox)).not.toThrow();
    expect(() => assertDemoSeedTarget({ ...sandbox, hostname: 'db.example.com' })).toThrow();
    expect(() => assertDemoSeedTarget({ ...sandbox, database: 'iskra_production' })).toThrow();
    expect(() => assertDemoSeedTarget({ ...sandbox, user: 'iskra_runtime' })).toThrow();
    expect(() => assertDemoSeedTarget({ ...sandbox, appEnvironment: 'production' })).toThrow();
    expect(() => assertDemoSeedTarget({ ...sandbox, demoData: 'false' })).toThrow();
    expect(() => assertDemoSeedTarget({ ...sandbox, hasSearch: true })).toThrow();
    expect(() => assertDemoSeedTarget({ ...sandbox, hasHash: true })).toThrow();
  });
});

describe('demo seed controlled photo keys', () => {
  it('uses the four deterministic report and cleanup object slots under the seed prefix', () => {
    const keys = demoSeedPhotoObjectKeys('a'.repeat(64));
    expect(keys).toEqual({
      greenBefore: `demo-fixtures/seed-v1/green-resolved/before-${'a'.repeat(64)}.jpg`,
      yellowBefore: `demo-fixtures/seed-v1/yellow-pending/before-${'a'.repeat(64)}.jpg`,
      redBefore: `demo-fixtures/seed-v1/red-pending/before-${'a'.repeat(64)}.jpg`,
      greenAfter: `demo-fixtures/seed-v1/green-resolved/after-${'a'.repeat(64)}.jpg`,
    });
  });

  it('rejects any photo hash that cannot form a safe deterministic object key', () => {
    expect(() => demoSeedPhotoObjectKeys('../remote')).toThrow();
    expect(() => demoSeedPhotoObjectKeys('A'.repeat(64))).toThrow();
  });
});
