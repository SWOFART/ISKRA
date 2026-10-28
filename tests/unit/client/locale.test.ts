import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatLocaleDate,
  formatLocaleNumber,
  getLocale,
  resolveInitialLocale,
  translate,
} from '../../../src/client/locale';

afterEach(() => vi.unstubAllGlobals());

describe('client locale', () => {
  it.each([
    ['de-DE', 'de'],
    ['en-GB', 'en'],
    ['fr-FR', 'en'],
    [null, 'en'],
  ] as const)('resolves browser language %s with English fallback', (browserLanguage, expected) => {
    expect(resolveInitialLocale(null, browserLanguage)).toBe(expected);
  });

  it('uses a valid saved preference before the browser language', () => {
    expect(resolveInitialLocale('de', 'en-US')).toBe('de');
    expect(resolveInitialLocale('fr', 'de-DE')).toBe('de');
  });

  it('loads the saved language from browser storage', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => 'de' } });
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(getLocale()).toBe('de');
  });

  it('formats numbers and dates using the selected locale', () => {
    expect(formatLocaleNumber('en', 1234.5)).toBe('1,234.5');
    expect(formatLocaleNumber('de', 1234.5)).toBe('1.234,5');
    expect(formatLocaleDate('en', new Date('2026-10-27T12:00:00Z'))).not.toBe(
      formatLocaleDate('de', new Date('2026-10-27T12:00:00Z')),
    );
  });

  it('translates UI copy with interpolation without translating resident content', () => {
    expect(translate('en', 'reportsLoaded', { count: 2, noun: 'reports', source: '' })).toBe('2 reports loaded.');
    expect(translate('de', 'reportsLoaded', { count: 2, noun: 'Meldungen', source: '' })).toBe('2 Meldungen geladen.');
    const authoredDescription = 'Glass near the school';
    expect(authoredDescription).toBe('Glass near the school');
  });
});
