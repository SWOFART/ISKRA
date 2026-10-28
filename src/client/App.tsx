import { clientDesign, type SupportedLocale } from './designTokens';
import { createClientApi } from './api';
import {
  NotificationListSchema, NotificationReadReceiptSchema, NotificationReadRequestSchema,
  ReportDetailSchema, ReportSummarySchema, type ReportDetail, type ReportSummary,
} from '../shared/contracts';
import type { FirebaseSession } from './auth';
import { renderAuthPanel } from './auth-panel';
import {
  renderImpactPage, type ImpactNotification, type ImpactPageView, type NotificationLoadState,
} from './ImpactPage';
import {
  errorMessageKey,
  localeFromBrowserLanguages,
  readStoredLocale,
  storeLocale,
  translate,
  type MessageKey,
  type MessageValues,
} from './i18n';
import { renderMapPage, type MapPageState, type MapPageView } from './MapPage';

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

const notificationRefreshIntervalMs = 5_000;

function notificationEventKey(notification: ImpactNotification): string {
  return `${notification.kind}:${notification.reportId}`;
}

function summaryFromReportDetail(detail: ReportDetail): ReportSummary {
  return ReportSummarySchema.parse({
    id: detail.id,
    route: detail.route,
    status: detail.status,
    location: detail.location,
    coverPhotoId: detail.coverPhotoId,
    description: detail.description,
    existenceYesCount: detail.existenceYesCount,
    resolutionYesCount: detail.resolutionYesCount,
    existenceVerifiedAt: detail.existenceVerifiedAt,
    lastExistenceConfirmedAt: detail.lastExistenceConfirmedAt,
    version: detail.version,
    updatedAt: detail.updatedAt,
    isDemo: detail.isDemo,
  });
}

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

function renderDeferredPanel(
  heading: string,
  message: string,
  actionLabel: string | undefined,
  pendingMessage: string,
  onSignIn?: () => void,
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
      if (onSignIn) { onSignIn(); return; }
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
  initialLocale: SupportedLocale = readStoredLocale()
    ?? localeFromBrowserLanguages(typeof navigator === 'undefined'
      ? []
      : navigator.languages ?? [navigator.language]),
  session?: FirebaseSession,
): HTMLElement {
  let locale = initialLocale;
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  const t: Translate = (key, values) => translate(locale, key, values);
  let authOpen = false;
  let authIntent: 'report' | TabId | null = null;
  let accountUid: string | null = null;
  let authPanel: ReturnType<typeof renderAuthPanel> | undefined;

  const shell = makeElement('div', 'app-shell');
  const skipLink = makeElement('a', 'skip-link', t('nav.skipToContent'));
  skipLink.href = '#main-content';
  skipLink.addEventListener('click', () => { window.location.hash = 'main-content'; });
  const header = makeElement('header', 'app-header');
  const notificationToast = makeElement('aside', 'app-notification-toast');
  notificationToast.hidden = true;
  notificationToast.setAttribute('role', 'status');
  notificationToast.setAttribute('aria-live', 'polite');
  const notificationToastMessage = makeElement('p', 'app-notification-toast-message');
  const notificationToastActions = makeElement('div', 'app-notification-toast-actions');
  const notificationToastOpen = makeButton('', 'app-notification-toast-open');
  const notificationToastDismiss = makeButton('', 'app-notification-toast-dismiss');
  appendElements(notificationToastActions, notificationToastOpen, notificationToastDismiss);
  appendElements(notificationToast, notificationToastMessage, notificationToastActions);
  const main = makeElement('main', 'app-main');
  main.id = 'main-content';
  main.tabIndex = -1;
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
  let currentMapPage: MapPageView | undefined;
  let currentImpactPage: ImpactPageView | undefined;
  let impactScrollTop = 0;
  let mapPageState: MapPageState | undefined;
  let notificationItems: ImpactNotification[] = [];
  let notificationLoadState: NotificationLoadState = 'loading';
  let notificationOwner: string | null = null;
  let notificationInitialized = false;
  let notificationPollGeneration = 0;
  let notificationPollTimer: number | undefined;
  let notificationRequestController: AbortController | undefined;
  let notificationRequestInFlight = false;
  let notificationRefreshQueued = false;
  let toastNotification: ImpactNotification | null = null;
  const seenNotificationEvents = new Set<string>();
  const locallyReadNotifications = new Map<string, string>();

  notificationToastOpen.addEventListener('click', () => {
    if (!toastNotification) return;
    void openNotificationReport(toastNotification.reportId, toastNotification.id);
  });
  notificationToastDismiss.addEventListener('click', hideNotificationToast);

  function createTab(tabId: TabId): HTMLButtonElement {
    const label = t(tabLabelKeys[tabId]);
    const tab = makeButton('', 'nav-tab');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-label', label);
    tab.id = `tab-${tabId}`;
    tab.setAttribute('aria-controls', 'main-panel');
    tab.setAttribute('aria-selected', String(tabId === selectedTab));
    tab.tabIndex = tabId === selectedTab ? 0 : -1;
    appendElements(tab,
      makeElement('span', 'nav-icon', icons[tabId]),
      makeElement('span', 'nav-label', label),
    );
    tab.addEventListener('click', () => { leaveSignIn(); activateTab(tabId, true); });
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
      leaveSignIn();
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
      button.disabled = session?.busy ?? false;
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
    const controls = makeElement('div', 'header-controls');
    controls.appendChild(createLocaleSwitch());
    if (session) {
      const account = makeButton(t(session.uid ? 'auth.signOut' : 'auth.signIn'), 'header-auth');
      account.disabled = session.busy;
      account.addEventListener('click', () => {
        if (!session.uid) { openSignIn(selectedTab); return; }
        void session.signOut().then(() => {
          accountUid = null;
          authOpen = false;
          authIntent = null;
          renderChrome();
          activateTab(selectedTab, false);
        }, () => openSignIn(selectedTab));
      });
      controls.appendChild(account);
    }
    header.replaceChildren(
      brand,
      makeElement('span', 'header-caption', t('header.caption')),
      controls,
    );
    skipLink.textContent = t('nav.skipToContent');

    tabs = new Map(tabOrder.map((tabId) => [tabId, createTab(tabId)]));
    tablist.setAttribute('aria-label', t('nav.main'));
    tablist.replaceChildren(...tabs.values());
  }

  let selectedTab = tabFromPath(window.location.pathname);
  function openSignIn(intent: 'report' | TabId): void {
    authIntent = intent;
    authOpen = true;
    activateTab(selectedTab, false);
  }
  function leaveSignIn(): void {
    if (authOpen && session) void session.signOut().catch(() => undefined);
    authOpen = false;
    authIntent = null;
  }

  function authenticatedNotificationOwner(): string | null {
    return session?.uid && session.uid === accountUid ? session.uid : null;
  }

  function updateImpactNotifications(): void {
    currentImpactPage?.setNotifications(notificationItems, notificationLoadState);
  }

  function hideNotificationToast(): void {
    const restoreFocus = notificationToast.contains(document.activeElement);
    toastNotification = null;
    notificationToast.hidden = true;
    if (restoreFocus) tabs.get(selectedTab)?.focus();
  }

  function renderNotificationToast(): void {
    if (!toastNotification) {
      notificationToast.hidden = true;
      return;
    }
    const localized = notificationItems.find(({ id }) => id === toastNotification?.id);
    if (localized) toastNotification = localized;
    if (toastNotification.readAt !== null) {
      hideNotificationToast();
      return;
    }
    if (notificationToastMessage.textContent !== toastNotification.message) {
      notificationToastMessage.textContent = toastNotification.message;
    }
    notificationToastOpen.textContent = t('impact.openNotificationReport');
    notificationToastOpen.hidden = false;
    notificationToastDismiss.textContent = t('impact.notificationToastDismiss');
    notificationToast.hidden = false;
  }

  function clearNotificationPollTimer(): void {
    if (notificationPollTimer === undefined) return;
    window.clearTimeout(notificationPollTimer);
    notificationPollTimer = undefined;
  }

  function resetNotificationContext(owner: string | null): void {
    clearNotificationPollTimer();
    notificationRequestController?.abort();
    notificationPollGeneration += 1;
    notificationRequestController = undefined;
    notificationRequestInFlight = false;
    notificationRefreshQueued = false;
    notificationOwner = owner;
    notificationInitialized = false;
    notificationItems = [];
    notificationLoadState = 'loading';
    seenNotificationEvents.clear();
    locallyReadNotifications.clear();
    hideNotificationToast();
    updateImpactNotifications();
  }

  function scheduleNotificationRefresh(): void {
    if (!notificationOwner || document.visibilityState === 'hidden'
      || notificationRequestInFlight || notificationPollTimer !== undefined) return;
    notificationPollTimer = window.setTimeout(() => {
      notificationPollTimer = undefined;
      void refreshNotifications();
    }, notificationRefreshIntervalMs);
  }

  async function refreshNotifications(): Promise<void> {
    const owner = authenticatedNotificationOwner();
    if (owner !== notificationOwner) resetNotificationContext(owner);
    if (!owner || document.visibilityState === 'hidden') return;
    if (notificationRequestInFlight) {
      notificationRefreshQueued = true;
      return;
    }
    clearNotificationPollTimer();
    const generation = notificationPollGeneration;
    const controller = new AbortController();
    notificationRequestController = controller;
    notificationRequestInFlight = true;
    if (notificationLoadState !== 'ready') {
      notificationLoadState = 'loading';
      updateImpactNotifications();
    }

    try {
      const result = await api.request({
        path: `/me/notifications?locale=${locale}`,
        auth: 'required',
        responseSchema: NotificationListSchema,
        signal: controller.signal,
      });
      if (generation !== notificationPollGeneration || authenticatedNotificationOwner() !== owner) return;

      const items = result.data.items.map((notification) => {
        const localReadAt = locallyReadNotifications.get(notification.id);
        return notification.readAt === null && localReadAt
          ? { ...notification, readAt: localReadAt }
          : notification;
      });
      const newNotification = notificationInitialized
        ? items.find((notification) => notification.readAt === null
          && !seenNotificationEvents.has(notificationEventKey(notification)))
        : undefined;
      seenNotificationEvents.clear();
      for (const notification of items) seenNotificationEvents.add(notificationEventKey(notification));
      const currentIds = new Set(items.map(({ id }) => id));
      for (const id of locallyReadNotifications.keys()) {
        if (!currentIds.has(id)) locallyReadNotifications.delete(id);
      }
      notificationInitialized = true;
      notificationItems = items;
      notificationLoadState = 'ready';
      updateImpactNotifications();
      renderNotificationToast();
      if (newNotification) {
        toastNotification = newNotification;
        renderNotificationToast();
      }
    } catch {
      if (generation === notificationPollGeneration && !controller.signal.aborted) {
        notificationLoadState = 'error';
        updateImpactNotifications();
      }
    } finally {
      if (generation === notificationPollGeneration) {
        notificationRequestController = undefined;
        notificationRequestInFlight = false;
        if (notificationRefreshQueued) {
          notificationRefreshQueued = false;
          void refreshNotifications();
        } else {
          scheduleNotificationRefresh();
        }
      }
    }
  }

  function syncNotificationPolling(refreshNow = false): void {
    const owner = authenticatedNotificationOwner();
    const ownerChanged = owner !== notificationOwner;
    if (ownerChanged) resetNotificationContext(owner);
    if (!owner || document.visibilityState === 'hidden') {
      clearNotificationPollTimer();
      notificationRequestController?.abort();
      return;
    }
    if (refreshNow || ownerChanged) {
      clearNotificationPollTimer();
      void refreshNotifications();
      return;
    }
    scheduleNotificationRefresh();
  }

  async function markNotificationRead(notificationId: string): Promise<boolean> {
    const notification = notificationItems.find(({ id }) => id === notificationId);
    if (!notification) return false;
    if (notification.readAt !== null) return true;
    const owner = authenticatedNotificationOwner();
    if (!owner) return false;
    try {
      const result = await api.request({
        path: `/me/notifications/${notificationId}`,
        method: 'PATCH',
        auth: 'required',
        body: { read: true },
        bodySchema: NotificationReadRequestSchema,
        responseSchema: NotificationReadReceiptSchema,
      });
      if (authenticatedNotificationOwner() !== owner) return false;
      locallyReadNotifications.set(notificationId, result.data.readAt);
      notificationItems = notificationItems.map((item) => item.id === notificationId
        ? { ...item, readAt: result.data.readAt }
        : item);
      notificationLoadState = 'ready';
      updateImpactNotifications();
      renderNotificationToast();
      return true;
    } catch {
      return false;
    }
  }

  async function openNotificationReport(
    reportId: string,
    notificationId: string,
    cachedReport?: ReportSummary,
  ): Promise<void> {
    hideNotificationToast();
    const owner = authenticatedNotificationOwner();
    if (!owner) return;
    let report = cachedReport;
    try {
      if (!report) {
        const result = await api.request({
          path: `/reports/${reportId}`,
          auth: 'optional',
          responseSchema: ReportDetailSchema,
        });
        report = summaryFromReportDetail(result.data);
      }
      if (authenticatedNotificationOwner() !== owner) return;
      await markNotificationRead(notificationId);
      if (authenticatedNotificationOwner() !== owner) return;
      impactScrollTop = currentImpactPage?.scrollTop ?? impactScrollTop;
      activateTab('map', true);
      currentMapPage?.openReport(report);
    } catch {
      notificationToastMessage.textContent = t('impact.notificationReportUnavailable');
      notificationToastOpen.hidden = true;
      notificationToastDismiss.textContent = t('impact.notificationToastDismiss');
      notificationToast.hidden = false;
    }
  }

  function activateTab(tabId: TabId, updateHistory: boolean): void {
    if (currentImpactPage) {
      impactScrollTop = currentImpactPage.scrollTop;
      currentImpactPage.dispose();
      currentImpactPage = undefined;
    }
    currentMapPage?.dispose();
    currentMapPage = undefined;
    authPanel?.dispose();
    authPanel = undefined;
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

    if (authOpen && session) {
      authPanel = renderAuthPanel(session, t, () => {
        accountUid = session.uid;
        const intent = authIntent;
        authOpen = false;
        authIntent = null;
        activateTab(intent === 'report' ? 'map' : selectedTab, false);
        if (intent === 'report') {
          currentMapPage?.openCapture('report');
        }
      }, () => {
        accountUid = null;
        authOpen = false;
        authIntent = null;
        activateTab(selectedTab, false);
      });
      panel.appendChild(authPanel.element);
    } else if (selectedTab === 'map') {
      currentMapPage = renderMapPage(() => {
        if (session && (!session.uid || session.uid !== accountUid)) { openSignIn('report'); return; }
        if (session?.uid && session.uid === accountUid) {
          currentMapPage?.openCapture('report');
          return;
        }
        const notice = panel.querySelector<HTMLElement>('.map-notice');
        if (notice) {
          notice.textContent = t('map.cameraNotConnected');
          notice.hidden = false;
        }
      }, api, t, locale, mapPageState, (inert) => {
        header.inert = inert;
        tablist.inert = inert;
      }, setLocale);
      mapPageState = currentMapPage.state;
      appendElements(panel, currentMapPage.element);
    } else if (selectedTab === 'impact') {
      if (session?.uid && session.uid === accountUid) {
        currentImpactPage = renderImpactPage(api, t, locale, (report) => {
          impactScrollTop = currentImpactPage?.scrollTop ?? impactScrollTop;
          activateTab('map', true);
          currentMapPage?.openReport(report);
        }, impactScrollTop, {
          notifications: notificationItems,
          notificationState: notificationLoadState,
          onOpenNotificationReport: (reportId, notificationId, report) => {
            void openNotificationReport(reportId, notificationId, report);
          },
          onMarkNotificationRead: markNotificationRead,
          onRefreshNotifications: () => syncNotificationPolling(true),
        });
        panel.appendChild(currentImpactPage.element);
      } else {
        appendElements(panel,
          renderDeferredPanel(
            t('deferred.impact.heading'),
            t('deferred.impact.message'),
            t('deferred.signIn'),
            t('deferred.signInPending'),
            session ? () => openSignIn('impact') : undefined,
          ),
        );
      }
    } else {
      appendElements(panel,
        renderDeferredPanel(
          t('deferred.rewards.heading'),
          t(session?.uid && session.uid === accountUid ? 'auth.rewardsPending' : 'deferred.rewards.message'),
          session?.uid && session.uid === accountUid ? undefined : t('deferred.signIn'),
          t('deferred.signInPending'),
          session ? () => openSignIn('rewards') : undefined,
        ),
      );
    }

    main.replaceChildren(panel);
    currentMapPage?.mount();
    if (authPanel) panel.querySelector<HTMLElement>('#auth-heading')?.focus();
    syncNotificationPolling();
  }

  function setLocale(next: SupportedLocale): void {
    if (next === locale) return;
    locale = next;
    storeLocale(next);
    document.documentElement.lang = next;
    renderChrome();
    activateTab(selectedTab, false);
    localeButtons.get(next)?.focus();
    syncNotificationPolling(true);
  }

  window.addEventListener('popstate', () => {
    leaveSignIn();
    activateTab(tabFromPath(window.location.pathname), false);
  });
  window.addEventListener('focus', () => syncNotificationPolling(true));
  document.addEventListener('visibilitychange', () => syncNotificationPolling(true));

  appendElements(shell, skipLink, header, notificationToast, main, tablist);
  renderChrome();
  activateTab(selectedTab, false);
  session?.subscribe(() => {
    renderChrome();
    syncNotificationPolling();
  });
  return shell;
}
