import { DEVELOPMENT_FIXTURE_LABEL } from './api';
import type { SupportedLocale } from './designTokens';

export const LOCALE_STORAGE_KEY = 'iskra.locale';

const english = {
  'brand.label': 'ISKRA — Map',
  'header.caption': 'A cleaner city, together',
  'header.localeLabel': 'Language',
  'nav.main': 'Main navigation',
  'nav.map': 'Map',
  'nav.impact': 'My Impact',
  'nav.rewards': 'Rewards',
  'map.region': 'Map of Heilbronn',
  'map.eyebrow': 'YOUR CITY',
  'map.city': 'Heilbronn',
  'map.canvasLabel': 'Map preview centered on Heilbronn',
  'map.loading': 'Loading reports…',
  'map.retry': 'Retry',
  'map.retryLabel': 'Retry loading reports',
  'map.waitBeforeRetry': 'Please wait before retrying.',
  'map.reportButton': 'Report litter',
  'map.reportLabel': 'Start a litter report',
  'map.cameraNotConnected': 'Camera reporting is not connected yet. No location or photos have been requested.',
  'map.reportsUnavailable': 'Reports could not be loaded.',
  'map.countNone': 'No {source}reports are available yet.',
  'map.countLoaded': '{count} {source}{noun} loaded.',
  'map.countSource.sample': 'sample ',
  'map.noun.one': 'report',
  'map.noun.other': 'reports',
  'fixture.banner': DEVELOPMENT_FIXTURE_LABEL,
  'deferred.signIn': 'Sign in',
  'deferred.signInPending': 'Sign-in will be available when account access is connected.',
  'deferred.impact.heading': 'Your impact',
  'deferred.impact.message': 'Sign in to see your reports and community contributions.',
  'deferred.rewards.heading': 'Rewards',
  'deferred.rewards.message': 'Sign in to see your reward balance and available rewards.',
  'error.INVALID_INPUT': 'Correct the request before continuing.',
  'error.UNAUTHENTICATED': 'Sign in to continue.',
  'error.RATE_LIMITED': 'Too many requests. Wait before trying again.',
  'error.UNAVAILABLE': 'The service could not be reached. Try again using the same action.',
  'error.INVALID_RESPONSE': 'The service returned a response that could not be verified.',
  'error.INTERNAL_ERROR': 'Something went wrong. Try again.',
  'error.DATABASE_UNAVAILABLE': 'The service is temporarily unavailable. Try again later.',
  'error.generic': 'The request could not be completed. Try again.',
} as const;

export type MessageKey = keyof typeof english;
export type MessageValues = Record<string, string | number>;

const german: Record<MessageKey, string> = {
  'brand.label': 'ISKRA — Karte',
  'header.caption': 'Eine sauberere Stadt, gemeinsam',
  'header.localeLabel': 'Sprache',
  'nav.main': 'Hauptnavigation',
  'nav.map': 'Karte',
  'nav.impact': 'Mein Einfluss',
  'nav.rewards': 'Belohnungen',
  'map.region': 'Karte von Heilbronn',
  'map.eyebrow': 'DEINE STADT',
  'map.city': 'Heilbronn',
  'map.canvasLabel': 'Kartenvorschau mit Mittelpunkt Heilbronn',
  'map.loading': 'Meldungen werden geladen…',
  'map.retry': 'Erneut versuchen',
  'map.retryLabel': 'Laden der Meldungen erneut versuchen',
  'map.waitBeforeRetry': 'Bitte warte, bevor du es erneut versuchst.',
  'map.reportButton': 'Müll melden',
  'map.reportLabel': 'Müllmeldung starten',
  'map.cameraNotConnected': 'Die Kamerameldung ist noch nicht verbunden. Es wurden weder Standort noch Fotos angefragt.',
  'map.reportsUnavailable': 'Meldungen konnten nicht geladen werden.',
  'map.countNone': 'Es sind noch keine {source}Meldungen verfügbar.',
  'map.countLoaded': '{count} {source}{noun} geladen.',
  'map.countSource.sample': 'Beispiel-',
  'map.noun.one': 'Meldung',
  'map.noun.other': 'Meldungen',
  'fixture.banner': 'ENTWICKLUNGSFIXTUR — KEINE LIVE-DATEN',
  'deferred.signIn': 'Anmelden',
  'deferred.signInPending': 'Die Anmeldung wird verfügbar, sobald der Kontozugang angebunden ist.',
  'deferred.impact.heading': 'Dein Einfluss',
  'deferred.impact.message': 'Melde dich an, um deine Meldungen und Beiträge zur Gemeinschaft zu sehen.',
  'deferred.rewards.heading': 'Belohnungen',
  'deferred.rewards.message': 'Melde dich an, um deinen Belohnungsstand und verfügbare Belohnungen zu sehen.',
  'error.INVALID_INPUT': 'Korrigiere die Eingabe, bevor du fortfährst.',
  'error.UNAUTHENTICATED': 'Melde dich an, um fortzufahren.',
  'error.RATE_LIMITED': 'Zu viele Anfragen. Warte, bevor du es erneut versuchst.',
  'error.UNAVAILABLE': 'Der Dienst ist nicht erreichbar. Versuche es mit derselben Aktion erneut.',
  'error.INVALID_RESPONSE': 'Die Antwort des Dienstes konnte nicht geprüft werden.',
  'error.INTERNAL_ERROR': 'Etwas ist schiefgelaufen. Versuche es erneut.',
  'error.DATABASE_UNAVAILABLE': 'Der Dienst ist vorübergehend nicht verfügbar. Versuche es später erneut.',
  'error.generic': 'Die Anfrage konnte nicht abgeschlossen werden. Versuche es erneut.',
};

const catalogs: Record<SupportedLocale, Record<MessageKey, string>> = { en: english, de: german };

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return value === 'en' || value === 'de';
}

export function localeFromBrowserLanguages(languages: readonly string[]): SupportedLocale {
  for (const language of languages) {
    const primary = language.toLowerCase().split('-', 1)[0];
    if (isSupportedLocale(primary)) return primary;
  }
  return 'en';
}

export function readStoredLocale(): SupportedLocale | null {
  try {
    const value = window.localStorage?.getItem(LOCALE_STORAGE_KEY);
    return isSupportedLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeLocale(locale: SupportedLocale): void {
  try {
    window.localStorage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    return;
  }
}

export function translate(locale: SupportedLocale, key: MessageKey, values: MessageValues = {}): string {
  return catalogs[locale][key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? ''));
}

export function errorMessageKey(code: string): MessageKey {
  const key = `error.${code}`;
  return key in english ? (key as MessageKey) : 'error.generic';
}
