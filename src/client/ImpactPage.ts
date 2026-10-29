import {
  ImpactSchema, NotificationSchema, type Impact, type ReportSummary,
} from '../shared/contracts';
import { ApiClientError, createClientApi } from './api';
import { errorMessageKey, formatDateTime, formatNumber, type MessageKey, type MessageValues } from './i18n';
import type { SupportedLocale } from './designTokens';
import { compareReportProgress } from './reportFreshness';

type ClientApi = ReturnType<typeof createClientApi>;
type ImpactRole = Impact['items'][number]['roles'][number];
export type ImpactNotification = ReturnType<typeof NotificationSchema.parse>;
export type NotificationLoadState = 'loading' | 'ready' | 'error';
type Translate = (key: MessageKey, values?: MessageValues) => string;

export interface ImpactPageOptions {
  notifications: readonly ImpactNotification[];
  notificationState: NotificationLoadState;
  onOpenNotificationReport: (reportId: string, notificationId: string, report?: ReportSummary) => void;
  onMarkNotificationRead: (notificationId: string) => Promise<boolean>;
  onRefreshNotifications: () => void;
}

export interface ImpactPageView {
  element: HTMLElement;
  readonly scrollTop: number;
  setNotifications(items: readonly ImpactNotification[], state: NotificationLoadState): void;
  dispose(): void;
}

const roleKeys: Record<ImpactRole, MessageKey> = {
  REPORTER: 'impact.role.reporter',
  CLEANER: 'impact.role.cleaner',
  VERIFIER: 'impact.role.verifier',
};

const statusKeys: Record<ReportSummary['status'], MessageKey> = {
  AWAITING_EXISTENCE: 'impact.status.awaitingExistence',
  VERIFIED: 'impact.status.verified',
  AWAITING_RESOLUTION: 'impact.status.awaitingResolution',
  RESOLVED: 'impact.status.resolved',
};

const routeKeys: Record<ReportSummary['route'], MessageKey> = {
  GREEN: 'impact.route.green',
  YELLOW: 'impact.route.yellow',
  RED: 'impact.route.red',
};

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function makeButton(label: string, className: string): HTMLButtonElement {
  const button = makeElement('button', className, label);
  button.type = 'button';
  return button;
}

function sameNotifications(
  left: readonly ImpactNotification[],
  right: readonly ImpactNotification[],
): boolean {
  return left.length === right.length && left.every((notification, index) => {
    const next = right[index];
    return notification.id === next.id
      && notification.kind === next.kind
      && notification.message === next.message
      && notification.reportId === next.reportId
      && notification.readAt === next.readAt;
  });
}

function append(parent: HTMLElement, ...children: HTMLElement[]): void {
  for (const child of children) parent.appendChild(child);
}

function mergeImpact(current: Impact, incoming: Impact, append: boolean): Impact {
  const newerAccount = incoming.balanceVersion >= current.balanceVersion;
  const baseItems = append || !newerAccount ? current.items : incoming.items;
  const extraItems = append || !newerAccount ? incoming.items : current.items;
  const items = new Map(baseItems.map((item) => [item.report.id, item]));
  for (const item of extraItems) {
    const existing = items.get(item.report.id);
    if (!existing || compareReportProgress(existing.report, item.report) < 0) items.set(item.report.id, item);
  }
  return { ...(newerAccount ? incoming : current), items: [...items.values()], nextCursor: incoming.nextCursor };
}

function metric(label: string, value: number | string, locale: SupportedLocale, suffix = ''): HTMLElement {
  const item = makeElement('div', 'impact-metric');
  item.appendChild(makeElement('span', 'impact-metric-label', label));
  item.appendChild(makeElement('strong', 'impact-metric-value',
    typeof value === 'number' ? `${formatNumber(locale, value)}${suffix}` : value));
  return item;
}

export function renderImpactPage(
  api: ClientApi,
  t: Translate,
  locale: SupportedLocale,
  onOpenReport: (report: ReportSummary) => void,
  initialScrollTop = 0,
  options: ImpactPageOptions = {
    notifications: [],
    notificationState: 'loading',
    onOpenNotificationReport: () => undefined,
    onMarkNotificationRead: async () => false,
    onRefreshNotifications: () => undefined,
  },
): ImpactPageView {
  const page = makeElement('section', 'impact-page');
  page.setAttribute('aria-labelledby', 'impact-heading');
  page.scrollTop = initialScrollTop;

  const heading = makeElement('h1', 'impact-heading', t('impact.title'));
  heading.id = 'impact-heading';
  const status = makeElement('p', 'impact-load-status', t('impact.loading'));
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-busy', 'true');
  const fixtureBanner = makeElement('p', 'fixture-banner', t('fixture.banner'));
  fixtureBanner.hidden = true;

  const totals = makeElement('section', 'impact-total-section');
  totals.hidden = true;
  totals.setAttribute('aria-label', t('impact.totals'));
  append(totals,
    makeElement('h2', undefined, t('impact.totals')),
    makeElement('div', 'impact-metric-grid impact-metric-grid--totals'),
  );
  const totalMetrics = totals.querySelector<HTMLElement>('.impact-metric-grid')!;

  const reporterSection = makeElement('section', 'impact-role-section');
  reporterSection.hidden = true;
  const reporterMetrics = makeElement('div', 'impact-metric-grid');
  append(reporterSection, makeElement('h2', undefined, t('impact.reporter')), reporterMetrics);

  const cleanerSection = makeElement('section', 'impact-role-section');
  cleanerSection.hidden = true;
  const cleanerMetrics = makeElement('div', 'impact-metric-grid');
  append(cleanerSection, makeElement('h2', undefined, t('impact.cleaner')), cleanerMetrics);

  const verificationSection = makeElement('section', 'impact-role-section');
  verificationSection.hidden = true;
  const verificationMetrics = makeElement('div', 'impact-metric-grid');
  append(verificationSection, makeElement('h2', undefined, t('impact.verification')), verificationMetrics);

  const notificationsSection = makeElement('section', 'impact-notifications-section');
  const notificationsStatus = makeElement('p', 'impact-notifications-status', t('impact.notificationsLoading'));
  notificationsStatus.setAttribute('role', 'status');
  notificationsStatus.setAttribute('aria-live', 'polite');
  notificationsStatus.tabIndex = -1;
  const notificationsList = makeElement('ul', 'impact-notifications-list');
  const emptyNotifications = makeElement('p', 'impact-empty-notifications', t('impact.notificationsEmpty'));
  emptyNotifications.hidden = true;
  const refreshNotificationsButton = makeButton(t('impact.notificationsRetry'), 'impact-notifications-retry');
  refreshNotificationsButton.hidden = true;
  append(notificationsSection,
    makeElement('h2', undefined, t('impact.notifications')),
    notificationsStatus,
    notificationsList,
    emptyNotifications,
    refreshNotificationsButton);

  const historySection = makeElement('section', 'impact-history-section');
  historySection.hidden = true;
  const historyList = makeElement('ul', 'impact-history-list');
  historyList.setAttribute('aria-label', t('impact.history'));
  const emptyHistory = makeElement('p', 'impact-empty-history', t('impact.emptyHistory'));
  emptyHistory.hidden = true;
  const retryButton = makeButton(t('impact.retry'), 'impact-retry-button');
  retryButton.hidden = true;
  const moreButton = makeButton(t('impact.loadMore'), 'impact-load-more-button');
  moreButton.hidden = true;
  append(historySection, makeElement('h2', undefined, t('impact.history')), historyList,
    emptyHistory, retryButton, moreButton);

  append(page, heading, status, fixtureBanner, totals, reporterSection, cleanerSection,
    verificationSection, notificationsSection, historySection);

  let active = true;
  let generation = 0;
  let controller: AbortController | undefined;
  let currentData: Impact | undefined;
  let nextCursor: string | null = null;
  let failedCursor: string | null = null;
  let restoreScrollPending = initialScrollTop > 0;
  let notificationItems: readonly ImpactNotification[] = options.notifications;
  let notificationState = options.notificationState;

  function setNotificationStatus(text: string): void {
    if (notificationsStatus.textContent !== text) notificationsStatus.textContent = text;
  }

  function renderNotifications(): void {
    const retryHadFocus = document.activeElement === refreshNotificationsButton;
    const activeElement = document.activeElement;
    const focusedButton = activeElement?.tagName === 'BUTTON'
      && notificationsList.contains(activeElement)
      ? activeElement as HTMLButtonElement
      : null;
    const focusedNotificationId = focusedButton
      ?.closest<HTMLElement>('.impact-notification-item')?.dataset.notificationId;
    const focusedAction = focusedButton?.classList.contains('impact-notification-mark-read')
      ? '.impact-notification-mark-read'
      : focusedButton?.classList.contains('impact-notification-open-report')
        ? '.impact-notification-open-report'
        : undefined;
    notificationsList.replaceChildren();
    refreshNotificationsButton.hidden = notificationState !== 'error';
    refreshNotificationsButton.disabled = false;
    emptyNotifications.hidden = notificationState !== 'ready' || notificationItems.length > 0;
    if (notificationState === 'loading') {
      setNotificationStatus(t('impact.notificationsLoading'));
    } else if (notificationState === 'error') {
      setNotificationStatus(t('impact.notificationsUnavailable'));
    } else {
      const unreadCount = notificationItems.filter((item) => item.readAt === null).length;
      setNotificationStatus(notificationItems.length === 0
        ? ''
        : unreadCount === 0
          ? t('impact.notificationsAllRead')
          : t('impact.notificationsUnreadCount', { count: unreadCount }));
    }

    for (const notification of notificationItems) {
      const item = makeElement('li', `impact-notification-item${notification.readAt === null
        ? ' impact-notification-item--unread' : ''}`);
      item.setAttribute('data-notification-id', notification.id);
      const message = makeElement('p', 'impact-notification-message', notification.message);
      const readState = makeElement('span', 'impact-notification-read-state', t(
        notification.readAt === null ? 'impact.notificationUnread' : 'impact.notificationRead',
      ));
      const actions = makeElement('div', 'impact-notification-actions');
      const openReport = makeButton(t('impact.openNotificationReport'), 'impact-notification-open-report');
      openReport.addEventListener('click', () => {
        const report = currentData?.items.find(({ report: summary }) => summary.id === notification.reportId)?.report;
        options.onOpenNotificationReport(notification.reportId, notification.id, report);
      });
      actions.appendChild(openReport);

      if (notification.readAt === null) {
        const markRead = makeButton(t('impact.markNotificationRead'), 'impact-notification-mark-read');
        markRead.setAttribute('data-notification-id', notification.id);
        const actionStatus = makeElement('span', 'impact-notification-action-status');
        actionStatus.setAttribute('role', 'status');
        markRead.addEventListener('click', () => {
          const restoreFocus = document.activeElement === markRead;
          markRead.disabled = true;
          actionStatus.textContent = '';
          void options.onMarkNotificationRead(notification.id).then((marked) => {
            if (active && !marked) {
              markRead.disabled = false;
              actionStatus.textContent = t('impact.notificationReadFailed');
              if (restoreFocus && (document.activeElement === document.body || !page.contains(document.activeElement))) {
                markRead.focus();
              }
            } else if (active && restoreFocus
              && (document.activeElement === document.body || !page.contains(document.activeElement))) {
              const item = Array.from(notificationsList.querySelectorAll<HTMLElement>('.impact-notification-item'))
                .find((candidate) => candidate.dataset.notificationId === notification.id);
              item?.querySelector<HTMLButtonElement>('.impact-notification-open-report')?.focus();
            }
          });
        });
        append(actions, markRead, actionStatus);
      }

      append(item, message, readState, actions);
      notificationsList.appendChild(item);
    }

    if (focusedNotificationId && focusedAction) {
      const item = Array.from(notificationsList.querySelectorAll<HTMLElement>('.impact-notification-item'))
        .find((candidate) => candidate.dataset.notificationId === focusedNotificationId);
      const target = item?.querySelector<HTMLButtonElement>(focusedAction)
        ?? item?.querySelector<HTMLButtonElement>('.impact-notification-open-report')
        ?? notificationsList.querySelector<HTMLButtonElement>('.impact-notification-open-report');
      target?.focus();
    }
    if (retryHadFocus && refreshNotificationsButton.hidden) notificationsStatus.focus();
  }

  function renderMetrics(data: Impact): void {
    totalMetrics.replaceChildren(
      metric(t('impact.earned'), data.totals.earnedRp, locale, ` ${t('impact.rp')}`),
      metric(t('impact.balance'), data.totals.balanceRp, locale, ` ${t('impact.rp')}`),
      metric(t('impact.score'), '—', locale),
    );
    totalMetrics.appendChild(makeElement('p', 'impact-score-note', t('impact.scoreNotConfigured')));
    reporterMetrics.replaceChildren(
      metric(t('impact.reportsCreated'), data.reporter.created, locale),
      metric(t('impact.inProgress'), data.reporter.inProgress, locale),
      metric(t('impact.resolved'), data.reporter.resolved, locale),
      metric(t('impact.roleEarned'), data.reporter.earnedRp, locale, ` ${t('impact.rp')}`),
      metric(t('impact.pending'), data.reporter.pendingRp, locale, ` ${t('impact.rp')}`),
    );
    cleanerMetrics.replaceChildren(
      metric(t('impact.cleanupsSubmitted'), data.cleaner.submitted, locale),
      metric(t('impact.cleanupsPending'), data.cleaner.pending, locale),
      metric(t('impact.cleanupsVerified'), data.cleaner.verified, locale),
      metric(t('impact.roleEarned'), data.cleaner.earnedRp, locale, ` ${t('impact.rp')}`),
      metric(t('impact.pending'), data.cleaner.pendingRp, locale, ` ${t('impact.rp')}`),
    );
    verificationMetrics.replaceChildren(
      metric(t('impact.acceptedVotes'), data.verification.acceptedVotes, locale),
      metric(t('impact.confirmedReports'), data.verification.confirmedReports, locale),
      metric(t('impact.roleEarned'), data.verification.earnedRp, locale, ` ${t('impact.rp')}`),
    );
  }

  function renderHistory(data: Impact): void {
    const items = [...data.items].sort((left, right) => {
      const dateDifference = Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt);
      return dateDifference || left.report.id.localeCompare(right.report.id);
    });
    historyList.replaceChildren();
    emptyHistory.hidden = items.length > 0;
    for (const item of items) {
      const listItem = makeElement('li', 'impact-history-item');
      const button = makeButton('', 'impact-history-link');
      button.setAttribute('data-report-id', item.report.id);
      const roleNames = item.roles.map((role) => t(roleKeys[role]));
      if (item.roles.includes('VERIFIER')) roleNames.push(t('impact.voteRecorded'));
      button.setAttribute('aria-label', [
        item.report.description,
        t(routeKeys[item.report.route]),
        t(statusKeys[item.report.status]),
        ...roleNames,
        formatDateTime(locale, item.lastUpdatedAt),
      ].join('. '));
      const metadata = makeElement('span', 'impact-history-meta');
      metadata.appendChild(makeElement('span', `impact-route impact-route--${item.report.route.toLowerCase()}`,
        t(routeKeys[item.report.route])));
      metadata.appendChild(makeElement('span', 'impact-report-status', t(statusKeys[item.report.status])));
      const roles = makeElement('span', 'impact-history-roles');
      for (const role of item.roles) roles.appendChild(makeElement('span', 'impact-role-pill', t(roleKeys[role])));
      if (item.roles.includes('VERIFIER')) {
        roles.appendChild(makeElement('span', 'impact-role-detail', t('impact.voteRecorded')));
      }
      const updated = makeElement('time', 'impact-history-date', formatDateTime(locale, item.lastUpdatedAt));
      updated.dateTime = item.lastUpdatedAt;
      append(button,
        makeElement('span', 'impact-history-description', item.report.description), metadata, roles, updated);
      if (item.report.isDemo) button.appendChild(makeElement('span', 'impact-demo-label', t('impact.demo')));
      button.addEventListener('click', () => onOpenReport(item.report));
      listItem.appendChild(button);
      historyList.appendChild(listItem);
    }
  }

  async function load(cursor: string | null = null): Promise<void> {
    if (!active) return;
    const currentGeneration = ++generation;
    controller?.abort();
    controller = new AbortController();
    failedCursor = null;
    retryButton.hidden = true;
    moreButton.disabled = true;
    if (!currentData) {
      status.textContent = t('impact.loading');
      status.setAttribute('aria-busy', 'true');
    } else if (cursor) {
      status.textContent = t('impact.loadingMore');
    }

    try {
      const path = cursor ? `/me/impact?cursor=${encodeURIComponent(cursor)}` : '/me/impact';
      const result = await api.request({
        path,
        auth: 'required',
        responseSchema: ImpactSchema,
        signal: controller.signal,
      });
      if (!active || currentGeneration !== generation) return;
      currentData = currentData ? mergeImpact(currentData, result.data, cursor !== null) : result.data;
      nextCursor = result.data.nextCursor;
      fixtureBanner.hidden = result.provenance.mode !== 'fixture';
      totals.hidden = false;
      reporterSection.hidden = false;
      cleanerSection.hidden = false;
      verificationSection.hidden = false;
      historySection.hidden = false;
      renderMetrics(currentData);
      renderHistory(currentData);
      if (cursor === null && restoreScrollPending) {
        page.scrollTop = initialScrollTop;
        restoreScrollPending = false;
      }
      moreButton.hidden = nextCursor === null;
      moreButton.disabled = false;
      moreButton.textContent = t('impact.loadMore');
      status.textContent = '';
      status.setAttribute('aria-busy', 'false');
    } catch (error) {
      if (!active || currentGeneration !== generation) return;
      status.textContent = t(error instanceof ApiClientError ? errorMessageKey(error.code) : 'error.generic');
      status.setAttribute('aria-busy', 'false');
      failedCursor = cursor;
      const retryable = error instanceof ApiClientError && error.retryable;
      retryButton.hidden = cursor !== null || !retryable;
      moreButton.hidden = cursor === null ? nextCursor === null : false;
      moreButton.textContent = cursor === null ? t('impact.loadMore') : t('impact.retry');
      moreButton.disabled = cursor !== null && !retryable;
      if (!currentData) {
        totals.hidden = true;
        reporterSection.hidden = true;
        cleanerSection.hidden = true;
        verificationSection.hidden = true;
        historySection.hidden = true;
      }
    }
  }

  retryButton.addEventListener('click', () => { void load(failedCursor); });
  moreButton.addEventListener('click', () => { if (nextCursor) void load(nextCursor); });
  refreshNotificationsButton.addEventListener('click', () => options.onRefreshNotifications());
  renderNotifications();
  void load();

  return {
    element: page,
    get scrollTop() { return page.scrollTop; },
    setNotifications(items, state) {
      const changed = notificationState !== state || !sameNotifications(notificationItems, items);
      notificationItems = items;
      notificationState = state;
      if (active && changed) renderNotifications();
    },
    dispose() {
      active = false;
      generation += 1;
      controller?.abort();
    },
  };
}
