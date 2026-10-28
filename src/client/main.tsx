import './styles.css';
import { App } from './App';
import { applyClientDesignTokens } from './applyDesignTokens';
import { localeFromBrowserLanguages, readStoredLocale } from './i18n';
import { createFirebaseSession } from './auth';
import { createClientApi } from './api';

applyClientDesignTokens(document.documentElement.style);

const root = document.querySelector<HTMLElement>('#root');

if (!root) {
  throw new Error('The application root element is missing.');
}

const locale = readStoredLocale() ?? localeFromBrowserLanguages(navigator.languages ?? [navigator.language]);
document.documentElement.lang = locale;
const session = createFirebaseSession();
const api = createClientApi({
  mode: import.meta.env.DEV && !session ? 'fixture' : 'live',
  tokenProvider: session,
});
root.replaceChildren(App(api, locale, session));
