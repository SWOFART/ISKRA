import { clientDesign } from './designTokens';
import { ApiClientError, createClientApi, DEVELOPMENT_FIXTURE_LABEL } from './api';
import { ReportListSchema } from '../shared/contracts';
import { getLocale, saveLocale, translate } from './locale';
import type { SupportedLocale } from './designTokens';

type ClientApi = ReturnType<typeof createClientApi>;

type TabId = 'map' | 'impact' | 'rewards';

const tabPaths: Record<TabId, string> = {
  map: '/map',
  impact: '/impact',
  rewards: '/rewards',
};

function tabFromPath(pathname: string): TabId {
  if (pathname === tabPaths.impact) return 'impact';
  if (pathname === tabPaths.rewards) return 'rewards';
  return 'map';
}

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function makeButton(label: string, className: string): HTMLButtonElement {
  const button = makeElement('button', className, label);
  button.type = 'button';
  return button;
}

function appendElements(parent: HTMLElement, ...elements: HTMLElement[]): void {
  for (const element of elements) parent.appendChild(element);
}

function renderMapPanel(onReport: () => void, api: ClientApi, locale: SupportedLocale): HTMLElement {
  const page = makeElement('section', 'map-page');
  page.setAttribute('aria-label', translate(locale, 'mapLabel'));

  const mapCanvas = makeElement('div', 'map-canvas');
  mapCanvas.setAttribute('role', 'img');
  mapCanvas.setAttribute('aria-label', translate(locale, 'mapPreview'));
  mapCanvas.setAttribute('data-latitude', String(clientDesign.map.center.latitude));
  mapCanvas.setAttribute('data-longitude', String(clientDesign.map.center.longitude));
  mapCanvas.setAttribute('data-zoom', String(clientDesign.map.zoom));

  const mapLabel = makeElement('div', 'map-location');
  appendElements(mapLabel,
    makeElement('span', 'eyebrow', translate(locale, 'cityEyebrow')),
    makeElement('strong', undefined, 'Heilbronn'),
  );

  const mapStatus = makeElement('div', 'map-status');
  mapStatus.setAttribute('role', 'status');
  mapStatus.setAttribute('aria-live', 'polite');
  mapStatus.setAttribute('aria-busy', 'true');
  const mapStatusText = makeElement('span', 'map-status-message', translate(locale, 'loadingReports'));
  const retryButton = makeButton(translate(locale, 'retry'), 'retry-button');
  retryButton.setAttribute('aria-label', translate(locale, 'retryReports'));
  retryButton.hidden = true;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  appendElements(mapStatus,
    makeElement('span', 'status-dot'),
    mapStatusText,
    retryButton,
  );

  const fixtureBanner = makeElement('aside', 'fixture-banner');
  fixtureBanner.setAttribute('role', 'note');
  fixtureBanner.textContent = `${translate(locale, 'fixtureNote')}: ${DEVELOPMENT_FIXTURE_LABEL}`;
  fixtureBanner.hidden = true;

  const reportButton = makeButton(translate(locale, 'reportLitter'), 'report-button');
  reportButton.setAttribute('aria-label', translate(locale, 'startReportLabel'));
  reportButton.addEventListener('click', onReport);

  const mapNotice = makeElement('p', 'map-notice');
  mapNotice.hidden = true;
  mapNotice.setAttribute('role', 'status');

  function clearRetryTimer(): void {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function deferRetry(error: ApiClientError): void {
    let remainingMs = error.retryAfterMs ?? 0;
    if (remainingMs <= 0) return;

    retryButton.disabled = true;
    mapStatusText.textContent = `${error.message} ${translate(locale, 'retryWait')}`;

    const scheduleEnable = (): void => {
      const delayMs = Math.min(remainingMs, 2_147_483_647);
      retryTimer = setTimeout(() => {
        remainingMs -= delayMs;
        if (remainingMs > 0) {
          scheduleEnable();
          return;
        }
        retryTimer = undefined;
        retryButton.disabled = false;
        mapStatusText.textContent = error.message;
      }, delayMs);
    };

    scheduleEnable();
  }

  async function loadReports(): Promise<void> {
    clearRetryTimer();
    retryButton.disabled = false;
    retryButton.hidden = true;
    mapStatus.setAttribute('aria-busy', 'true');
    mapStatusText.textContent = translate(locale, 'loadingReports');
    try {
      const result = await api.request({
        path: '/reports?cityId=heilbronn',
        responseSchema: ReportListSchema,
      });
      const isFixture = result.provenance.mode === 'fixture';
      fixtureBanner.hidden = !isFixture;
      fixtureBanner.textContent = `${translate(locale, 'fixtureNote')}: ${result.provenance.label}`;
      const count = result.data.items.length;
      const source = isFixture ? 'sample ' : '';
      mapStatusText.textContent = count === 0
        ? translate(locale, 'noReports', { source })
        : translate(locale, 'reportsLoaded', {
          count: new Intl.NumberFormat(locale).format(count),
          source,
          noun: translate(locale, count === 1 ? 'reportSingular' : 'reportPlural'),
        });
    } catch (error) {
      fixtureBanner.hidden = true;
      mapStatusText.textContent = error instanceof ApiClientError
        ? error.message
        : translate(locale, 'reportsLoadFailed');
      const canRetry = error instanceof ApiClientError && error.retryable;
      retryButton.hidden = !canRetry;
      if (canRetry) deferRetry(error);
    } finally {
      mapStatus.setAttribute('aria-busy', 'false');
    }
  }

  retryButton.addEventListener('click', () => {
    if (!retryButton.hidden && !retryButton.disabled) void loadReports();
  });
  void loadReports();

  appendElements(page, mapCanvas, mapLabel, mapStatus, fixtureBanner, reportButton, mapNotice);
  return page;
}

function renderDeferredPanel(
  heading: string,
  message: string,
  actionLabel: string | undefined,
  locale: SupportedLocale,
): HTMLElement {
  const page = makeElement('section', 'deferred-page');
  page.setAttribute('aria-labelledby', 'deferred-heading');

  const card = makeElement('div', 'deferred-card');
  appendElements(card,
    makeElement('span', 'deferred-icon', '✳'),
    makeElement('h1', undefined, heading),
    makeElement('p', undefined, message),
  );

  if (actionLabel) {
    const action = makeButton(actionLabel, 'secondary-button');
    const notice = makeElement('p', 'action-notice');
    notice.hidden = true;
    notice.setAttribute('role', 'status');
    action.addEventListener('click', () => {
      notice.textContent = translate(locale, 'signInUnavailable');
      notice.hidden = false;
    });
    appendElements(card, action, notice);
  }

  const headingElement = card.querySelector('h1');
  headingElement?.setAttribute('id', 'deferred-heading');
  appendElements(page, card);
  return page;
}

export function App(api: ClientApi = createClientApi({ mode: import.meta.env.DEV ? 'fixture' : 'live' })): HTMLElement {
  let locale = getLocale();
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  const shell = makeElement('div', 'app-shell');
  const skipLink = makeElement('a', 'skip-link', translate(locale, 'skipToContent'));
  skipLink.href = '#main-content';
  const header = makeElement('header', 'app-header');
  const brand = makeElement('a', 'brand', 'ISKRA');
  brand.href = tabPaths.map;
  brand.setAttribute('aria-label', translate(locale, 'brandLabel'));
  appendElements(header, brand, makeElement('span', 'header-caption', translate(locale, 'tagline')));

  const languageSelect = makeElement('select', 'language-select');
  languageSelect.setAttribute('aria-label', translate(locale, 'language'));
  languageSelect.setAttribute('autocomplete', 'language');
  for (const optionLocale of ['en', 'de'] as const) {
    const option = makeElement('option');
    option.value = optionLocale;
    option.textContent = optionLocale === 'en' ? 'English' : 'Deutsch';
    option.selected = optionLocale === locale;
    languageSelect.appendChild(option);
  }
  languageSelect.addEventListener('change', () => {
    const nextLocale = languageSelect.value;
    if (nextLocale === 'en' || nextLocale === 'de') {
      saveLocale(nextLocale);
      locale = nextLocale;
      document.documentElement.lang = nextLocale;
      renderShell();
    }
  });
  header.appendChild(languageSelect);

  const main = makeElement('main', 'app-main');
  main.id = 'main-content';
  const tablist = makeElement('nav', 'bottom-nav');
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', translate(locale, 'navigation'));

  const labels: Record<TabId, string> = {
    map: translate(locale, 'tabMap'),
    impact: translate(locale, 'tabImpact'),
    rewards: translate(locale, 'tabRewards'),
  };
  const tabOrder = ['map', 'impact', 'rewards'] as const;
  const icons: Record<TabId, string> = {
    map: '⌖',
    impact: '◉',
    rewards: '◇',
  };
  const tabs = new Map<TabId, HTMLButtonElement>();

  for (const tabId of ['map', 'impact', 'rewards'] as const) {
    const tab = makeButton('', 'nav-tab');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-label', labels[tabId]);
    tab.id = `tab-${tabId}`;
    tab.setAttribute('aria-controls', 'main-panel');
    appendElements(tab,
      makeElement('span', 'nav-icon', icons[tabId]),
      makeElement('span', 'nav-label', labels[tabId]),
    );
    tab.addEventListener('click', () => activateTab(tabId, true));
    tab.addEventListener('keydown', (event) => {
      const currentIndex = tabOrder.indexOf(tabId);
      let nextIndex: number;

      if (event.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % tabOrder.length;
      } else if (event.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + tabOrder.length) % tabOrder.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = tabOrder.length - 1;
      } else {
        return;
      }

      event.preventDefault();
      const nextTab = tabs.get(tabOrder[nextIndex]);
      nextTab?.focus();
      activateTab(tabOrder[nextIndex], true);
    });
    tabs.set(tabId, tab);
    appendElements(tablist, tab);
  }

  let selectedTab = tabFromPath(window.location.pathname);
  function renderShell(): void {
    brand.setAttribute('aria-label', translate(locale, 'brandLabel'));
    skipLink.textContent = translate(locale, 'skipToContent');
    header.querySelector<HTMLElement>('.header-caption')!.textContent = translate(locale, 'tagline');
    languageSelect.setAttribute('aria-label', translate(locale, 'language'));
    languageSelect.value = locale;
    tablist.setAttribute('aria-label', translate(locale, 'navigation'));
    for (const tabId of tabOrder) {
      const tab = tabs.get(tabId)!;
      const label = translate(locale, tabId === 'map' ? 'tabMap' : tabId === 'impact' ? 'tabImpact' : 'tabRewards');
      tab.setAttribute('aria-label', label);
      tab.querySelector<HTMLElement>('.nav-label')!.textContent = label;
      labels[tabId] = label;
    }
    activateTab(selectedTab, false);
  }

  function activateTab(tabId: TabId, updateHistory: boolean): void {
    selectedTab = tabId;
    if (updateHistory && window.location.pathname !== tabPaths[tabId]) {
      window.history.pushState({}, '', tabPaths[tabId]);
    }

    for (const [id, tab] of tabs) {
      const isSelected = id === selectedTab;
      tab.setAttribute('aria-selected', String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
    }

    const panel = makeElement('div', 'tab-panel');
    panel.id = 'main-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `tab-${selectedTab}`);
    panel.tabIndex = 0;

    if (selectedTab === 'map') {
      const map = renderMapPanel(() => {
        const notice = panel.querySelector<HTMLElement>('.map-notice');
        if (notice) {
          notice.textContent = translate(locale, 'cameraDeferred');
          notice.hidden = false;
        }
      }, api, locale);
      appendElements(panel, map);
    } else if (selectedTab === 'impact') {
      appendElements(panel,
        renderDeferredPanel(
          translate(locale, 'impactHeading'),
          translate(locale, 'impactMessage'),
          translate(locale, 'signIn'),
          locale,
        ),
      );
    } else {
      appendElements(panel,
        renderDeferredPanel(
          translate(locale, 'rewardsHeading'),
          translate(locale, 'rewardsMessage'),
          translate(locale, 'signIn'),
          locale,
        ),
      );
    }

    main.replaceChildren(panel);
    main.setAttribute('aria-label', translate(locale, selectedTab === 'map' ? 'tabMap' : selectedTab === 'impact' ? 'tabImpact' : 'tabRewards'));
  }

  window.addEventListener('popstate', () => {
    activateTab(tabFromPath(window.location.pathname), false);
  });

  appendElements(shell, skipLink, header, main, tablist);
  activateTab(selectedTab, false);
  return shell;
}
