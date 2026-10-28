import { DEVELOPMENT_FIXTURE_LABEL } from './api';
import type { SupportedLocale } from './designTokens';

export const LOCALE_STORAGE_KEY = 'iskra.locale';

const english = {
  'auth.heading': 'Welcome to ISKRA',
  'auth.intro': 'Sign in to report litter and take part in your city.',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.signIn': 'Sign in',
  'auth.signOut': 'Sign out',
  'auth.google': 'Continue with Google',
  'auth.createAccount': 'Create an account',
  'auth.haveAccount': 'I already have an account',
  'auth.resetPassword': 'Forgot password?',
  'auth.cancel': 'Back to browsing',
  'auth.retryAccount': 'Retry account setup',
  'auth.working': 'Connecting your account…',
  'auth.resetSent': 'If this email has an account, a password reset link has been sent.',
  'auth.accountUnavailable': 'You are signed in. Account setup is temporarily unavailable. Try again or sign out.',
  'auth.signInError': 'Sign-in could not be completed. Check your details or try another sign-in method.',
  'auth.networkError': 'Sign-in could not connect. Check your connection and try again.',
  'auth.popupBlocked': 'Your browser blocked the Google sign-in window. Allow popups for this site, then try again.',
  'auth.cancelled': 'Sign-in was cancelled. You can try again or return to browsing.',
  'auth.weakPassword': 'Use a stronger password and try again.',
  'auth.impactPending': 'Your account is connected. The Impact view is still being connected to your activity.',
  'auth.rewardsPending': 'Your account is connected. The Rewards view is still being connected.',
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
  'map.canvasLabel': 'Report map overview centered on Heilbronn',
  'map.markersLabel': 'Report locations',
  'map.tilesLoading': 'Loading Heilbronn map…',
  'map.tilesUnavailable': 'Map tiles could not be loaded. Reports remain available in the list below.',
  'map.tilesMissingKey': 'The map is not configured. Reports remain available in the list below.',
  'map.retryTiles': 'Retry map',
  'map.retryTilesLabel': 'Retry loading map tiles',
  'map.filtersLabel': 'Report map filters',
  'map.routesLabel': 'Filter by route',
  'map.route.green': 'Green',
  'map.route.yellow': 'Yellow',
  'map.route.red': 'Red',
  'map.filter.needsVerification': 'Needs verification',
  'map.filter.resolved': 'Show resolved',
  'map.fitReports': 'Fit reports',
  'map.list.heading': 'Reports in Heilbronn',
  'map.list.count': '{count} reports',
  'map.list.loading': 'Loading report locations…',
  'map.list.unavailable': 'Reports are unavailable. Use Retry above.',
  'map.list.empty': 'No reports match these filters.',
  'map.list.noRoutes': 'Choose a route to show reports.',
  'map.markerLabel': '{route} route. {status}. Select to highlight in the report list.',
  'map.clusterLabel': '{count} reports from {routes}. Select to show every report in this group.',
  'map.clusterDetails.region': 'Reports in selected map group',
  'map.clusterDetails.heading': 'Selected cluster · {count} reports',
  'map.clusterDetails.itemLabel': '{route} route. {status}. {description}. Select report.',
  'map.status.awaitingExistence': 'Awaiting existence confirmation',
  'map.status.confirmedOpen': 'Confirmed — more residents can still support',
  'map.status.awaitingResolution': 'Cleanup awaiting verification',
  'map.status.resolved': 'Resolved',
  'map.progress.existence': 'Existence: {threshold}/3 threshold · {total} confirmations',
  'map.progress.confirmedOpen': 'The report remains open for more support.',
  'map.progress.resolution': 'Cleanup verification: {count}/3',
  'map.progress.resolved': 'Cleanup verified: 3/3',
  'map.progress.latest': 'Latest confirmation: {date}',
  'map.countLoadedTruncated': 'First {count} reports loaded; refine filters to see fewer results.',
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
  'auth.heading': 'Willkommen bei ISKRA',
  'auth.intro': 'Melde dich an, um Müll zu melden und in deiner Stadt mitzumachen.',
  'auth.email': 'E-Mail',
  'auth.password': 'Passwort',
  'auth.signIn': 'Anmelden',
  'auth.signOut': 'Abmelden',
  'auth.google': 'Mit Google fortfahren',
  'auth.createAccount': 'Konto erstellen',
  'auth.haveAccount': 'Ich habe bereits ein Konto',
  'auth.resetPassword': 'Passwort vergessen?',
  'auth.cancel': 'Zurück zum Stöbern',
  'auth.retryAccount': 'Kontoeinrichtung erneut versuchen',
  'auth.working': 'Dein Konto wird verbunden…',
  'auth.resetSent': 'Falls ein Konto mit dieser E-Mail existiert, wurde ein Link zum Zurücksetzen gesendet.',
  'auth.accountUnavailable': 'Du bist angemeldet. Die Kontoeinrichtung ist vorübergehend nicht verfügbar. Versuche es erneut oder melde dich ab.',
  'auth.signInError': 'Die Anmeldung ist fehlgeschlagen. Prüfe deine Angaben oder versuche eine andere Anmeldemethode.',
  'auth.networkError': 'Keine Verbindung zur Anmeldung. Prüfe deine Verbindung und versuche es erneut.',
  'auth.popupBlocked': 'Dein Browser hat das Google-Anmeldefenster blockiert. Erlaube Pop-ups für diese Seite und versuche es erneut.',
  'auth.cancelled': 'Die Anmeldung wurde abgebrochen. Versuche es erneut oder kehre zum Stöbern zurück.',
  'auth.weakPassword': 'Verwende ein stärkeres Passwort und versuche es erneut.',
  'auth.impactPending': 'Dein Konto ist verbunden. Die Einflussansicht wird noch mit deiner Aktivität verknüpft.',
  'auth.rewardsPending': 'Dein Konto ist verbunden. Die Belohnungsansicht wird noch angebunden.',
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
  'map.canvasLabel': 'Meldungsübersicht mit Mittelpunkt Heilbronn',
  'map.markersLabel': 'Standorte der Meldungen',
  'map.tilesLoading': 'Karte von Heilbronn wird geladen…',
  'map.tilesUnavailable': 'Kartendaten konnten nicht geladen werden. Die Meldungen stehen in der Liste unten.',
  'map.tilesMissingKey': 'Die Karte ist nicht konfiguriert. Die Meldungen stehen in der Liste unten.',
  'map.retryTiles': 'Karte erneut laden',
  'map.retryTilesLabel': 'Kartendaten erneut laden',
  'map.filtersLabel': 'Filter für die Meldungskarte',
  'map.routesLabel': 'Nach Route filtern',
  'map.route.green': 'Grün',
  'map.route.yellow': 'Gelb',
  'map.route.red': 'Rot',
  'map.filter.needsVerification': 'Prüfung benötigt',
  'map.filter.resolved': 'Erledigte anzeigen',
  'map.fitReports': 'Meldungen einpassen',
  'map.list.heading': 'Meldungen in Heilbronn',
  'map.list.count': '{count} Meldungen',
  'map.list.loading': 'Meldungsstandorte werden geladen…',
  'map.list.unavailable': 'Meldungen sind nicht verfügbar. Nutze oben „Erneut versuchen“.',
  'map.list.empty': 'Keine Meldungen für diese Filter.',
  'map.list.noRoutes': 'Wähle eine Route aus, um Meldungen zu sehen.',
  'map.markerLabel': 'Route {route}. {status}. Auswählen, um die Meldung in der Liste hervorzuheben.',
  'map.clusterLabel': '{count} Meldungen aus {routes}. Auswählen, um alle Meldungen dieser Gruppe anzuzeigen.',
  'map.clusterDetails.region': 'Meldungen in der ausgewählten Kartengruppe',
  'map.clusterDetails.heading': 'Ausgewählte Gruppe · {count} Meldungen',
  'map.clusterDetails.itemLabel': 'Route {route}. {status}. {description}. Meldung auswählen.',
  'map.status.awaitingExistence': 'Existenzbestätigung ausstehend',
  'map.status.confirmedOpen': 'Bestätigt — weitere Bewohner können die Meldung unterstützen',
  'map.status.awaitingResolution': 'Reinigung wartet auf Bestätigung',
  'map.status.resolved': 'Erledigt',
  'map.progress.existence': 'Existenz: Schwelle {threshold}/3 · {total} Bestätigungen',
  'map.progress.confirmedOpen': 'Die Meldung bleibt für weitere Unterstützung offen.',
  'map.progress.resolution': 'Reinigungsprüfung: {count}/3',
  'map.progress.resolved': 'Reinigung bestätigt: 3/3',
  'map.progress.latest': 'Letzte Bestätigung: {date}',
  'map.countLoadedTruncated': 'Erste {count} Meldungen geladen; filtere weiter, um weniger Ergebnisse zu sehen.',
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
