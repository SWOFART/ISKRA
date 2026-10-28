import { describe, expect, it } from 'vitest';
import { assertDemoSeedTarget, type DemoSeedTarget } from '../../../src/worker/services/demo-seeds';

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
