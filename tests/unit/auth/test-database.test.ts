import { describe, expect, it } from 'vitest';
import { testDatabaseConfig } from '../../integration/auth/postgres';

describe('test database safety guard before connection', () => {
  it.each([
    undefined, '', 'not-a-url',
    'postgres://iskra_test@database.example:5432/iskra_test',
    'postgres://iskra_test@127.0.0.1:5432/production',
    'postgres://postgres@127.0.0.1:5432/iskra_test',
    'postgres://iskra_test@127.0.0.1/iskra_test',
    'postgres://iskra_test@127.0.0.1:5432/iskra_test?host=production',
    'postgres://iskra_test@127.0.0.1:5432/iskra_test#production',
    'https://iskra_test@127.0.0.1:5432/iskra_test',
  ])('rejects unsafe/missing test connection %s', (url) => {
    expect(() => testDatabaseConfig(url ?? '')).toThrow();
  });

  it('uses explicit disposable connection settings without inheriting production defaults', () => {
    expect(testDatabaseConfig('postgres://iskra_test@127.0.0.1:55432/iskra_test'))
      .toMatchObject({ host: '127.0.0.1', port: 55432, database: 'iskra_test', user: 'iskra_test', ssl: false, options: '-c search_path=pg_catalog', password: 'iskra-test-only' });
  });
});
