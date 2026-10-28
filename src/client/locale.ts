import { clientDesign, type SupportedLocale } from './designTokens';

export type TranslationKey = keyof typeof translations.en;

type Dictionary = Record<string, string>;

const translations = {
  en: {
    brandLabel: 'ISKRA — Map',
    tagline: 'A cleaner city, together',
    tabMap: 'Map',
    tabImpact: 'My Impact',
    tabRewards: 'Rewards',
    navigation: 'Main navigation',
    mapLabel: 'Map of Heilbronn',
    mapPreview: 'Map preview centered on Heilbronn',
    cityEyebrow: 'YOUR CITY',
    loadingReports: 'Loading reports…',
    retry: 'Retry',
    retryReports: 'Retry loading reports',
    retryWait: 'Please wait before retrying.',
    noReports: 'No {source}reports are available yet.',
    reportsLoaded: '{count} {source}{noun} loaded.',
    reportSingular: 'report',
    reportPlural: 'reports',
    reportsLoadFailed: 'Reports could not be loaded.',
    fixtureNote: 'Sample data',
    startReportLabel: 'Start a litter report',
    reportLitter: 'Report litter',
    cameraDeferred: 'Camera reporting is not connected yet. No location or photos have been requested.',
    impactHeading: 'Your impact',
    impactMessage: 'Sign in to see your reports and community contributions.',
    rewardsHeading: 'Rewards',
    rewardsMessage: 'Sign in to see your reward balance and available rewards.',
    signIn: 'Sign in',
    signInUnavailable: 'Sign-in will be available when account access is connected.',
    skipToContent: 'Skip to main content',
    skipContentLabel: 'Skip to main content',
    impactScore: 'Impact Score',
    rewardsDeferred: 'Rewards catalog is not connected yet.',
    language: 'Language',
  },
  de: {
    brandLabel: 'ISKRA — Karte',
    tagline: 'Gemeinsam eine sauberere Stadt',
    tabMap: 'Karte',
    tabImpact: 'Mein Beitrag',
    tabRewards: 'Prämien',
    navigation: 'Hauptnavigation',
    mapLabel: 'Karte von Heilbronn',
    mapPreview: 'Kartenvorschau mit Heilbronn im Zentrum',
    cityEyebrow: 'DEINE STADT',
    loadingReports: 'Meldungen werden geladen…',
    retry: 'Erneut versuchen',
    retryReports: 'Meldungen erneut laden',
    retryWait: 'Bitte warte, bevor du es erneut versuchst.',
    noReports: 'Noch keine {source}Meldungen verfügbar.',
    reportsLoaded: '{count} {source}{noun} geladen.',
    reportSingular: 'Meldung',
    reportPlural: 'Meldungen',
    reportsLoadFailed: 'Meldungen konnten nicht geladen werden.',
    fixtureNote: 'Beispieldaten',
    startReportLabel: 'Eine Müllmeldung starten',
    reportLitter: 'Müll melden',
    cameraDeferred: 'Die Kamerameldung ist noch nicht verbunden. Standort und Fotos wurden nicht angefordert.',
    impactHeading: 'Dein Beitrag',
    impactMessage: 'Melde dich an, um deine Meldungen und Beiträge zur Gemeinschaft zu sehen.',
    rewardsHeading: 'Prämien',
    rewardsMessage: 'Melde dich an, um dein Punkteguthaben und verfügbare Prämien zu sehen.',
    signIn: 'Anmelden',
    signInUnavailable: 'Die Anmeldung ist verfügbar, sobald der Kontozugriff verbunden ist.',
    skipToContent: 'Zum Hauptinhalt springen',
    skipContentLabel: 'Zum Hauptinhalt springen',
    impactScore: 'Wirkungswert',
    rewardsDeferred: 'Der Prämienkatalog ist noch nicht verbunden.',
    language: 'Sprache',
  },
} satisfies Record<SupportedLocale, Dictionary>;

function normalizeLocale(value: string | null | undefined): SupportedLocale | null {
  if (!value) return null;
  const normalized = value.toLowerCase().split('-')[0];
  return clientDesign.locale.supported.find((locale) => locale === normalized) ?? null;
}

export function resolveInitialLocale(
  saved: string | null,
  browserLanguage: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(saved)
    ?? normalizeLocale(browserLanguage)
    ?? clientDesign.locale.default;
}

export function getLocale(): SupportedLocale {
  let saved: string | null = null;
  try {
    saved = typeof window === 'undefined' ? null : window.localStorage.getItem('iskra.locale');
  } catch {
    saved = null;
  }
  const browserLanguage = typeof navigator === 'undefined' ? null : navigator.language;
  return resolveInitialLocale(saved, browserLanguage);
}

export function saveLocale(locale: SupportedLocale): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem('iskra.locale', locale);
  } catch {
    // Keep the in-memory language switch functional if storage is unavailable.
  }
}

export function translate(locale: SupportedLocale, key: TranslationKey, values: Record<string, string | number> = {}): string {
  const template = translations[locale][key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
}

export function formatLocaleNumber(locale: SupportedLocale, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatLocaleDate(locale: SupportedLocale, date: Date): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}
