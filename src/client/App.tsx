import { clientDesign, type SupportedLocale } from './designTokens';
import { ApiClientError, createClientApi } from './api';
import { ReportListSchema } from '../shared/contracts';
import { errorMessageKey, storeLocale, translate, type MessageKey, type MessageValues } from './i18n';

type ClientApi = ReturnType<typeof createClientApi>;
type Translate = (key: MessageKey, values?: MessageValues) => string;

type TabId = 'map' | 'impact' | 'rewards';

const tabPaths: Record<TabId, string> = {
  map: '/map',
  impact: '/impact',
  rewards: '/rewards',
};

const localeNames: Record<SupportedLocale, string> = {
  en: 'English',
  de: 'Deutsch',
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

function renderMapPanel(onReport: () => void, api: ClientApi, t: Translate): HTMLElement {
  const page = makeElement('section', 'map-page');
  page.setAttribute('aria-label', t('map.region'));

  const mapCanvas = makeElement('div', 'map-canvas');
  mapCanvas.setAttribute('role', 'img');
  mapCanvas.setAttribute('aria-label', t('map.canvasLabel'));
  mapCanvas.setAttribute('data-latitude', String(clientDesign.map.center.latitude));
  mapCanvas.setAttribute('data-longitude', String(clientDesign.map.center.longitude));
  mapCanvas.setAttribute('data-zoom', String(clientDesign.map.zoom));

  const mapLabel = makeElement('div', 'map-location');
  appendElements(mapLabel,
    makeElement('span', 'eyebrow', t('map.eyebrow')),
    makeElement('strong', undefined, t('map.city')),
  );

  const mapStatus = makeElement('div', 'map-status');
  mapStatus.setAttribute('role', 'status');
  mapStatus.setAttribute('aria-live', 'polite');
  mapStatus.setAttribute('aria-busy', 'true');
  const mapStatusText = makeElement('span', 'map-status-message', t('map.loading'));
  const retryButton = makeButton(t('map.retry'), 'retry-button');
  retryButton.setAttribute('aria-label', t('map.retryLabel'));
  retryButton.hidden = true;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  appendElements(mapStatus,
    makeElement('span', 'status-dot'),
    mapStatusText,
    retryButton,
  );

  const fixtureBanner = makeElement('aside', 'fixture-banner');
  fixtureBanner.setAttribute('role', 'note');
  fixtureBanner.textContent = t('fixture.banner');
  fixtureBanner.hidden = true;

  const reportButton = makeButton(t('map.reportButton'), 'report-button');
  reportButton.setAttribute('aria-label', t('map.reportLabel'));
  reportButton.addEventListener('click', onReport);

  const mapNotice = makeElement('p', 'map-notice');
  mapNotice.hidden = true;
  mapNotice.setAttribute('role', 'status');

  function clearRetryTimer(): void {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function errorText(error: ApiClientError): string {
    return t(errorMessageKey(error.code));
  }

  function deferRetry(error: ApiClientError): void {
    let remainingMs = error.retryAfterMs ?? 0;
    if (remainingMs <= 0) return;

    retryButton.disabled = true;
    mapStatusText.textContent = `${errorText(error)} ${t('map.waitBeforeRetry')}`;

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
        mapStatusText.textContent = errorText(error);
      }, delayMs);
    };

    scheduleEnable();
  }

  async function loadReports(): Promise<void> {
    clearRetryTimer();
    retryButton.disabled = false;
    retryButton.hidden = true;
    mapStatus.setAttribute('aria-busy', 'true');
    mapStatusText.textContent = t('map.loading');
    try {
      const result = await api.request({
        path: '/reports?cityId=heilbronn',
        responseSchema: ReportListSchema,
      });
      const isFixture = result.provenance.mode === 'fixture';
      fixtureBanner.hidden = !isFixture;
      const count = result.data.items.length;
      const source = isFixture ? t('map.countSource.sample') : '';
      mapStatusText.textContent = count === 0
        ? t('map.countNone', { source })
        : t('map.countLoaded', {
          count,
          source,
          noun: t(count === 1 ? 'map.noun.one' : 'map.noun.other'),
        });
    } catch (error) {
      fixtureBanner.hidden = true;
      mapStatusText.textContent = error instanceof ApiClientError
        ? errorText(error)
        : t('map.reportsUnavailable');
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
  pendingMessage: string,
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
      notice.textContent = pendingMessage;
      notice.hidden = false;
    });
    appendElements(card, action, notice);
  }

  const headingElement = card.querySelector('h1');
  headingElement?.setAttribute('id', 'deferred-heading');
  appendElements(page, card);
  return page;
}

export function App(
  api: ClientApi = createClientApi({ mode: import.meta.env.DEV ? 'fixture' : 'live' }),
  initialLocale: SupportedLocale = 'en',
): HTMLElement {
  let locale = initialLocale;
  const t: Translate = (key, values) => translate(locale, key, values);

  const shell = makeElement('div', 'app-shell');
  const header = makeElement('header', 'app-header');
  const main = makeElement('main', 'app-main');
  const tablist = makeElement('nav', 'bottom-nav');
  tablist.setAttribute('role', 'tablist');

  const tabOrder = ['map', 'impact', 'rewards'] as const;
  const icons: Record<TabId, string> = {
    map: '⌖',
    impact: '◉',
    rewards: '◇',
  };
  const tabLabelKeys: Record<TabId, MessageKey> = {
    map: 'nav.map',
    impact: 'nav.impact',
    rewards: 'nav.rewards',
  };
  let tabs = new Map<TabId, HTMLButtonElement>();

  function createTab(tabId: TabId): HTMLButtonElement {
    const label = t(tabLabelKeys[tabId]);
    const tab = makeButton('', 'nav-tab');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-label', label);
    tab.id = `tab-${tabId}`;
    tab.setAttribute('aria-controls', 'main-panel');
    appendElements(tab,
      makeElement('span', 'nav-icon', icons[tabId]),
      makeElement('span', 'nav-label', label),
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
    return tab;
  }

  const localeButtons = new Map<SupportedLocale, HTMLButtonElement>();

  function createLocaleSwitch(): HTMLElement {
    const group = makeElement('div', 'locale-switch');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', t('header.localeLabel'));
    localeButtons.clear();
    for (const option of clientDesign.locale.supported) {
      const button = makeButton(localeNames[option], 'locale-button');
      button.setAttribute('lang', option);
      button.setAttribute('aria-pressed', String(option === locale));
      button.addEventListener('click', () => setLocale(option));
      localeButtons.set(option, button);
      group.appendChild(button);
    }
    return group;
  }

  function renderChrome(): void {
    const brand = makeElement('a', 'brand', 'ISKRA');
    brand.href = tabPaths.map;
    brand.setAttribute('aria-label', t('brand.label'));
    header.replaceChildren(
      brand,
      makeElement('span', 'header-caption', t('header.caption')),
      createLocaleSwitch(),
    );

    tabs = new Map(tabOrder.map((tabId) => [tabId, createTab(tabId)]));
    tablist.setAttribute('aria-label', t('nav.main'));
    tablist.replaceChildren(...tabs.values());
  }

  let selectedTab = tabFromPath(window.location.pathname);
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
          notice.textContent = t('map.cameraNotConnected');
          notice.hidden = false;
        }
      }, api, t);
      appendElements(panel, map);
    } else if (selectedTab === 'impact') {
      appendElements(panel,
        renderDeferredPanel(
          t('deferred.impact.heading'),
          t('deferred.impact.message'),
          t('deferred.signIn'),
          t('deferred.signInPending'),
        ),
      );
    } else {
      appendElements(panel,
        renderDeferredPanel(
          t('deferred.rewards.heading'),
          t('deferred.rewards.message'),
          t('deferred.signIn'),
          t('deferred.signInPending'),
        ),
      );
    }

    main.replaceChildren(panel);
  }

  function setLocale(next: SupportedLocale): void {
    if (next === locale) return;
    locale = next;
    storeLocale(next);
    document.documentElement.lang = next;
    renderChrome();
    activateTab(selectedTab, false);
    localeButtons.get(next)?.focus();
  }

  window.addEventListener('popstate', () => {
    activateTab(tabFromPath(window.location.pathname), false);
  });

  appendElements(shell, header, main, tablist);
  renderChrome();
  activateTab(selectedTab, false);
  return shell;
}
