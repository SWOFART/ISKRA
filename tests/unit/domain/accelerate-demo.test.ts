import { describe, expect, it } from 'vitest';
import { DEMO_SEED_USER_IDS } from '../../../src/worker/services/demo-seeds';
import { parseAcceleratedVoteArguments } from '../../../scripts/accelerate-demo';

const validArguments = [
  '--confirm-sandbox',
  '--report-id', '11111111-1111-4111-8111-111111111111',
  '--voter-id', DEMO_SEED_USER_IDS[4]!,
  '--stage', 'EXISTENCE',
  '--choice', 'YES',
];

describe('accelerated demo vote operator arguments', () => {
  it('requires explicit sandbox confirmation and a reserved demo voter', () => {
    expect(parseAcceleratedVoteArguments(validArguments)).toMatchObject({
      reportId: '11111111-1111-4111-8111-111111111111',
      voterId: DEMO_SEED_USER_IDS[4],
      stage: 'EXISTENCE',
      choice: 'YES',
    });
    expect(() => parseAcceleratedVoteArguments(validArguments.filter((arg) => arg !== '--confirm-sandbox')))
      .toThrow('Explicit --confirm-sandbox confirmation is required.');
    expect(() => parseAcceleratedVoteArguments([
      ...validArguments.map((value) => value === DEMO_SEED_USER_IDS[4] ? 'ordinary-user' : value),
    ])).toThrow('--voter-id must be one of the reserved deterministic demo seed accounts.');
  });

  it('rejects unknown options, invalid stages and malformed idempotency keys', () => {
    expect(() => parseAcceleratedVoteArguments([...validArguments, '--remote']))
      .toThrow('Only --report-id, --voter-id, --stage, --choice, and --confirm-sandbox are accepted.');
    expect(() => parseAcceleratedVoteArguments(validArguments.map((value) => value === 'EXISTENCE' ? 'ADMIN' : value)))
      .toThrow('--stage must be EXISTENCE or RESOLUTION.');
    expect(() => parseAcceleratedVoteArguments(validArguments.map((value) =>
      value === '11111111-1111-4111-8111-111111111111' ? 'not-a-uuid' : value)))
      .toThrow('--report-id must be a UUID.');
  });
});
