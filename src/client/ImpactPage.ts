import { ImpactSchema, type Impact, type ReportSummary } from '../shared/contracts';
import { ApiClientError, createClientApi } from './api';
import { errorMessageKey, formatDateTime, formatNumber, type MessageKey, type MessageValues } from './i18n';
import type { SupportedLocale } from './designTokens';

type ClientApi = ReturnType<typeof createClientApi>;
type ImpactRole = Impact['items'][number]['roles'][number];
type Translate = (key: MessageKey, values?: MessageValues) => string;

export interface ImpactPageView {
  element: HTMLElement;
  readonly scrollTop: number;
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

function append(parent: HTMLElement, ...children: HTMLElement[]): void {
  for (const child of children) parent.appendChild(child);
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
    verificationSection, historySection);

  let active = true;
  let generation = 0;
  let controller: AbortController | undefined;
  let currentData: Impact | undefined;
  let nextCursor: string | null = null;
  let failedCursor: string | null = null;
  let restoreScrollPending = initialScrollTop > 0;

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
      if (cursor && currentData) {
        const byReportId = new Map(currentData.items.map((item) => [item.report.id, item]));
        for (const item of result.data.items) byReportId.set(item.report.id, item);
        currentData = { ...result.data, items: [...byReportId.values()] };
      } else {
        currentData = result.data;
      }
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
  void load();

  return {
    element: page,
    get scrollTop() { return page.scrollTop; },
    dispose() {
      active = false;
      generation += 1;
      controller?.abort();
    },
  };
}
