import { describe, expect, it } from 'vitest';
import {
  assertDemoObjectKeys,
  assertDemoResetArguments,
  assertDemoResetBucket,
} from '../../../scripts/reset-demo';

describe('guarded demo reset CLI inputs', () => {
  it('requires the exact sandbox dataset and local demo bucket confirmation', () => {
    const args = [
      '--environment', 'demo', '--dataset', 'iskra-demo',
      '--r2-bucket', 'iskra-demo', '--confirm-sandbox',
    ];
    expect(assertDemoResetArguments(args)).toBe('iskra-demo');
    expect(() => assertDemoResetArguments([
      '--environment', 'production', '--dataset', 'iskra-demo',
      '--r2-bucket', 'iskra-demo', '--confirm-sandbox',
    ])).toThrow();
    expect(() => assertDemoResetArguments([
      '--environment', 'demo', '--dataset', 'iskra-demo',
      '--r2-bucket', 'iskra-production', '--confirm-sandbox',
    ])).toThrow();
  });

  it('accepts only the reserved local bucket and exact seeded object-key shape', () => {
    expect(() => assertDemoResetBucket('iskra-demo')).not.toThrow();
    expect(() => assertDemoResetBucket('iskra-production')).toThrow();
    expect(() => assertDemoObjectKeys([
      'demo-fixtures/seed-v1/green-resolved/before-' + 'a'.repeat(64) + '.jpg',
      'demo-fixtures/seed-v1/green-resolved/after-' + 'b'.repeat(64) + '.jpg',
    ])).not.toThrow();
    expect(() => assertDemoObjectKeys([
      'demo-fixtures/seed-v1/green-resolved/../../production.jpg',
    ])).toThrow();
    expect(() => assertDemoObjectKeys(['uploads/another-user/photo.jpg'])).toThrow();
  });
});
