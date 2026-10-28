import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  errorMessageKey,
  LOCALE_STORAGE_KEY,
  localeFromBrowserLanguages,
  readStoredLocale,
  storeLocale,
  translate,
} from '../../../src/client/i18n';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('client localization', () => {
  it('falls back to English for unsupported browser languages', () => {
    expect(localeFromBrowserLanguages(['fr-FR', 'it'])).toBe('en');
    expect(localeFromBrowserLanguages([])).toBe('en');
  });

  it('selects German from a German browser language regardless of region', () => {
    expect(localeFromBrowserLanguages(['de-DE', 'en'])).toBe('de');
    expect(localeFromBrowserLanguages(['fr', 'de-AT'])).toBe('de');
  });

  it('prefers the first supported browser language in order', () => {
    expect(localeFromBrowserLanguages(['en-US', 'de-DE'])).toBe('en');
  });

  it('interpolates values and keeps translated copy distinct per locale', () => {
    expect(translate('en', 'map.countLoaded', { count: 1, source: '', noun: 'report' }))
      .toBe('1 report loaded.');
    expect(translate('de', 'map.countLoaded', { count: 2, source: '', noun: 'Meldungen' }))
      .toBe('2 Meldungen geladen.');
    expect(translate('de', 'nav.impact')).toBe('Mein Einfluss');
    expect(translate('en', 'nav.impact')).toBe('My Impact');
  });

  it('maps known API error codes to localized copy and unknown codes to a generic message', () => {
    expect(errorMessageKey('RATE_LIMITED')).toBe('error.RATE_LIMITED');
    expect(translate('de', errorMessageKey('RATE_LIMITED')))
      .toBe('Zu viele Anfragen. Warte, bevor du es erneut versuchst.');
    expect(errorMessageKey('SOMETHING_NEW')).toBe('error.generic');
  });

  it('persists only supported locale choices', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });

    expect(readStoredLocale()).toBeNull();
    storeLocale('de');
    expect(storage.get(LOCALE_STORAGE_KEY)).toBe('de');
    expect(readStoredLocale()).toBe('de');

    storage.set(LOCALE_STORAGE_KEY, 'xx');
    expect(readStoredLocale()).toBeNull();
  });

  it('tolerates storage that is unavailable', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('storage blocked');
        },
        setItem: () => {
          throw new Error('storage blocked');
        },
      },
    });

    expect(readStoredLocale()).toBeNull();
    expect(() => storeLocale('en')).not.toThrow();
  });
});
