import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  errorMessageKey,
  isSupportedLocale,
  localeFromBrowserLanguages,
  LOCALE_STORAGE_KEY,
  readStoredLocale,
  storeLocale,
  translate,
} from '../../../src/client/i18n';

afterEach(() => vi.unstubAllGlobals());

describe('client locale', () => {
  it.each([
    [['de-DE'], 'de'],
    [['en-GB'], 'en'],
    [['fr-FR', 'de-AT'], 'de'],
    [[], 'en'],
  ] as const)('resolves browser languages %j with English fallback', (languages, expected) => {
    expect(localeFromBrowserLanguages(languages)).toBe(expected);
  });

  it('uses a valid saved preference before the browser language', () => {
    expect(isSupportedLocale('de')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(false);
  });

  it('loads the saved language from browser storage', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => 'de' } });
    expect(readStoredLocale()).toBe('de');
    vi.stubGlobal('window', { localStorage: { getItem: () => 'fr' } });
    expect(readStoredLocale()).toBeNull();
  });

  it('maps known API error codes to localized keys and uses a generic fallback', () => {
    expect(errorMessageKey('RATE_LIMITED')).toBe('error.RATE_LIMITED');
    expect(errorMessageKey('UNRECOGNIZED')).toBe('error.generic');
    expect(translate('de', errorMessageKey('RATE_LIMITED')))
      .toBe('Zu viele Anfragen. Warte, bevor du es erneut versuchst.');
  });

  it('persists only supported choices and tolerates unavailable storage', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    expect(LOCALE_STORAGE_KEY).toBe('iskra.locale');
    storeLocale('de');
    expect(values.get('iskra.locale')).toBe('de');

    vi.stubGlobal('window', { localStorage: { setItem: () => { throw new Error('blocked'); } } });
    expect(() => storeLocale('en')).not.toThrow();
  });

  it('translates UI copy with interpolation without translating resident content', () => {
    expect(translate('en', 'reportsLoaded', { count: 2, noun: 'reports', source: '' })).toBe('2 reports loaded.');
    expect(translate('de', 'reportsLoaded', { count: 2, noun: 'Meldungen', source: '' })).toBe('2 Meldungen geladen.');
    const authoredDescription = 'Glass near the school';
    expect(authoredDescription).toBe('Glass near the school');
  });
});
