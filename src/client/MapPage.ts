import { ReportListSchema, type ReportSummary, type Route } from '../shared/contracts';
import { ApiClientError, createClientApi } from './api';
import { clientDesign, type SupportedLocale } from './designTokens';
import { errorMessageKey, type MessageKey, type MessageValues } from './i18n';
import { cityViewport, clusterReports, viewportForReports, type GeoBounds } from './mapModel';

type ClientApi = ReturnType<typeof createClientApi>;
type Translate = (key: MessageKey, values?: MessageValues) => string;

const routeOrder: readonly Route[] = ['GREEN', 'YELLOW', 'RED'];
const routeKeys: Record<Route, MessageKey> = {
  GREEN: 'map.route.green',
  YELLOW: 'map.route.yellow',
  RED: 'map.route.red',
};

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

function routeLabel(route: Route, t: Translate): string {
  return t(routeKeys[route]);
}

function statusLabel(report: ReportSummary, t: Translate): string {
  switch (report.status) {
    case 'AWAITING_EXISTENCE':
      return t('map.status.awaitingExistence');
    case 'VERIFIED':
      return t('map.status.confirmedOpen');
    case 'AWAITING_RESOLUTION':
      return t('map.status.awaitingResolution');
    case 'RESOLVED':
      return t('map.status.resolved');
  }
}

function progressLabels(report: ReportSummary, t: Translate, locale: SupportedLocale): string[] {
  const threshold = Math.min(report.existenceYesCount, 3);
  const existence = t('map.progress.existence', {
    threshold,
    total: report.existenceYesCount,
  });
  const latest = report.lastExistenceConfirmedAt
    ? t('map.progress.latest', {
      date: new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(report.lastExistenceConfirmedAt)),
    })
    : '';

  if (report.status === 'AWAITING_EXISTENCE') return [existence, latest].filter(Boolean);
  if (report.status === 'AWAITING_RESOLUTION') {
    return [
      t('map.progress.resolution', { count: report.resolutionYesCount }),
      existence,
      latest,
    ].filter(Boolean);
  }
  if (report.status === 'RESOLVED') {
    return [t('map.progress.resolved'), existence, latest].filter(Boolean);
  }
  return [t('map.progress.confirmedOpen'), existence, latest].filter(Boolean);
}

function countMessage(count: number, fixture: boolean, t: Translate): string {
  const source = fixture ? t('map.countSource.sample') : '';
  return count === 0
    ? t('map.countNone', { source })
    : t('map.countLoaded', {
      count,
      source,
      noun: t(count === 1 ? 'map.noun.one' : 'map.noun.other'),
    });
}

function queryForFilters(
  routes: ReadonlySet<Route>,
  needsVerification: boolean,
  resolved: boolean,
  cursor: string | null,
): string {
  const query = new URLSearchParams({
    cityId: clientDesign.map.cityId,
    needsVerification: String(needsVerification),
    resolved: String(resolved),
    limit: '100',
  });
  const selected = routeOrder.filter((route) => routes.has(route));
  if (selected.length > 0) query.set('routes', selected.join(','));
  if (cursor) query.set('cursor', cursor);
  return `/reports?${query.toString()}`;
}

export function renderMapPage(
  onReport: () => void,
  api: ClientApi,
  t: Translate,
  locale: SupportedLocale,
): HTMLElement {
  const page = makeElement('section', 'map-page');
  page.setAttribute('aria-label', t('map.region'));

  const mapArea = makeElement('div', 'map-area');
  const mapCanvas = makeElement('div', 'map-canvas');
  mapCanvas.setAttribute('data-latitude', String(clientDesign.map.center.latitude));
  mapCanvas.setAttribute('data-longitude', String(clientDesign.map.center.longitude));
  mapCanvas.setAttribute('data-zoom', String(clientDesign.map.zoom));
  mapCanvas.setAttribute('aria-hidden', 'true');

  const markerLayer = makeElement('div', 'map-marker-layer');
  markerLayer.setAttribute('aria-label', t('map.markersLabel'));
  const mapViewport = makeElement('div', 'map-viewport');
  mapViewport.setAttribute('role', 'region');
  mapViewport.setAttribute('aria-label', t('map.canvasLabel'));
  appendElements(mapViewport, mapCanvas, markerLayer);

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
  appendElements(mapStatus, makeElement('span', 'status-dot'), mapStatusText, retryButton);

  const routeFilters = makeElement('div', 'route-filters');
  routeFilters.setAttribute('role', 'group');
  routeFilters.setAttribute('aria-label', t('map.routesLabel'));
  const selectedRoutes = new Set<Route>(routeOrder);
  const needsVerificationButton = makeButton(t('map.filter.needsVerification'), 'map-filter-button');
  needsVerificationButton.setAttribute('aria-pressed', 'false');
  needsVerificationButton.addEventListener('click', () => {
    needsVerification = !needsVerification;
    needsVerificationButton.setAttribute('aria-pressed', String(needsVerification));
    void loadReports();
  });
  const resolvedButton = makeButton(t('map.filter.resolved'), 'map-filter-button');
  resolvedButton.setAttribute('aria-pressed', 'false');
  resolvedButton.addEventListener('click', () => {
    includeResolved = !includeResolved;
    resolvedButton.setAttribute('aria-pressed', String(includeResolved));
    void loadReports();
  });

  for (const route of routeOrder) {
    const button = makeButton(routeLabel(route, t), `route-filter route-filter--${route.toLowerCase()}`);
    button.setAttribute('aria-pressed', 'true');
    button.setAttribute('data-route', route);
    button.addEventListener('click', () => {
      if (selectedRoutes.has(route)) selectedRoutes.delete(route);
      else selectedRoutes.add(route);
      button.setAttribute('aria-pressed', String(selectedRoutes.has(route)));
      void loadReports();
    });
    routeFilters.appendChild(button);
  }

  const filterBar = makeElement('div', 'map-filter-bar');
  filterBar.setAttribute('role', 'group');
  filterBar.setAttribute('aria-label', t('map.filtersLabel'));
  appendElements(filterBar, routeFilters, needsVerificationButton, resolvedButton);

  const fitButton = makeButton(t('map.fitReports'), 'map-fit-button');
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

  const listPanel = makeElement('section', 'report-list-fallback');
  listPanel.setAttribute('aria-labelledby', 'map-report-list-heading');
  const listHeader = makeElement('div', 'report-list-header');
  const listHeading = makeElement('h2', undefined, t('map.list.heading'));
  listHeading.id = 'map-report-list-heading';
  const listSummary = makeElement('span', 'report-list-summary');
  appendElements(listHeader, listHeading, listSummary);
  const reportList = makeElement('ul', 'map-report-list');
  reportList.id = 'map-report-list';
  appendElements(listPanel, fixtureBanner, listHeader, reportList);

  appendElements(mapArea,
    mapViewport,
    mapLabel,
    mapStatus,
    filterBar,
    fitButton,
    reportButton,
    mapNotice,
  );
  appendElements(page, mapArea, listPanel);

  let reports: ReportSummary[] = [];
  let viewport: GeoBounds = cityViewport(clientDesign.map.center);
  let needsVerification = false;
  let includeResolved = false;
  let selectedReportId: string | null = null;
  let reportLoadBusy = true;
  let reportLoadFailed = false;
  let loadGeneration = 0;

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

  function renderReports(): void {
    const visibleReports = reports.filter((report) => selectedRoutes.has(report.route)
      && (includeResolved || report.status !== 'RESOLVED'));
    const mapWidth = mapViewport.clientWidth || 1000;
    const mapHeight = mapViewport.clientHeight || 700;
    const clusters = clusterReports(visibleReports, viewport, 54, mapWidth, mapHeight);
    markerLayer.replaceChildren();
    reportList.replaceChildren();

    for (const cluster of clusters) {
      const clusterRoutes = routeOrder.filter((route) => cluster.reports.some((report) => report.route === route));
      const routeSummary = clusterRoutes.map((route) => routeLabel(route, t)).join(', ');
      const mixedRouteClass = clusterRoutes.length === 1
        ? `map-marker--${clusterRoutes[0].toLowerCase()}`
        : 'map-marker--mixed';
      const marker = makeButton(
        cluster.reports.length > 1 ? String(cluster.reports.length) : '•',
        `map-marker ${cluster.reports.length > 1 ? 'map-marker--cluster' : ''} ${mixedRouteClass}`,
      );
      const marginX = (19 / mapWidth) * 100;
      const marginY = (19 / mapHeight) * 100;
      const left = Math.max(marginX, Math.min(100 - marginX, (cluster.x / mapWidth) * 100));
      const top = Math.max(marginY, Math.min(100 - marginY, (cluster.y / mapHeight) * 100));
      marker.setAttribute('style', `left:${left}%;top:${top}%;`);
      marker.setAttribute('aria-label', cluster.reports.length > 1
        ? t('map.clusterLabel', { count: cluster.reports.length, routes: routeSummary })
        : t('map.markerLabel', {
          route: routeLabel(cluster.reports[0].route, t),
          status: statusLabel(cluster.reports[0], t),
        }));
      marker.setAttribute('aria-controls', reportList.id);
      marker.setAttribute('aria-pressed', String(cluster.reports.some(({ id }) => id === selectedReportId)));
      marker.addEventListener('click', () => {
        if (cluster.reports.length > 1) viewport = viewportForReports(cluster.reports, viewport);
        selectedReportId = cluster.reports[0].id;
        renderReports();
        reportList.querySelector<HTMLButtonElement>(`[data-report-id="${selectedReportId}"]`)?.focus();
      });
      markerLayer.appendChild(marker);
    }

    for (const report of visibleReports) {
      const item = makeElement('li', 'report-list-row');
      const select = makeButton('', `report-list-item${report.id === selectedReportId ? ' report-list-item--selected' : ''}`);
      select.setAttribute('data-report-id', report.id);
      select.setAttribute('aria-pressed', String(report.id === selectedReportId));
      const route = makeElement('span', `report-route report-route--${report.route.toLowerCase()}`,
        routeLabel(report.route, t));
      const status = makeElement('span', 'report-status-text', statusLabel(report, t));
      const description = makeElement('span', 'report-description', report.description);
      const progress = makeElement('span', 'report-progress');
      for (const line of progressLabels(report, t, locale)) {
        progress.appendChild(makeElement('span', undefined, line));
      }
      appendElements(select, route, status, description, progress);
      select.addEventListener('click', () => {
        selectedReportId = report.id;
        viewport = viewportForReports([report], viewport);
        renderReports();
      });
      item.appendChild(select);
      reportList.appendChild(item);
    }

    listSummary.textContent = t('map.list.count', { count: visibleReports.length });
    if (visibleReports.length === 0) {
      const emptyKey = selectedRoutes.size === 0
        ? 'map.list.noRoutes'
        : reportLoadFailed
          ? 'map.list.unavailable'
          : reportLoadBusy ? 'map.list.loading' : 'map.list.empty';
      const empty = makeElement('li', 'report-list-empty', t(
        emptyKey,
      ));
      reportList.appendChild(empty);
    }
    fitButton.disabled = visibleReports.length === 0;
  }

  async function loadReports(): Promise<void> {
    clearRetryTimer();
    const generation = ++loadGeneration;
    retryButton.disabled = false;
    retryButton.hidden = true;
    mapStatus.setAttribute('aria-busy', 'true');
    mapStatusText.textContent = t('map.loading');
    reportLoadBusy = true;
    reportLoadFailed = false;
    reports = [];
    selectedReportId = null;
    fixtureBanner.hidden = true;
    renderReports();

    if (selectedRoutes.size === 0) {
      reportLoadBusy = false;
      renderReports();
      mapStatusText.textContent = t('map.list.noRoutes');
      mapStatus.setAttribute('aria-busy', 'false');
      return;
    }

    try {
      const nextReports = new Map<string, ReportSummary>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let fixture = false;
      let hasMore = false;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        if (cursor) {
          if (seenCursors.has(cursor)) throw new Error('The reports cursor repeated.');
          seenCursors.add(cursor);
        }
        const result: {
          data: ReturnType<typeof ReportListSchema.parse>;
          provenance: { mode: 'live' | 'fixture' };
        } = await api.request({
          path: queryForFilters(selectedRoutes, needsVerification, includeResolved, cursor),
          responseSchema: ReportListSchema,
        });
        if (generation !== loadGeneration) return;
        fixture ||= result.provenance.mode === 'fixture';
        for (const report of result.data.items) nextReports.set(report.id, report);
        cursor = result.data.nextCursor;
        hasMore = cursor !== null;
        if (!cursor) break;
      }

      if (generation !== loadGeneration) return;
      reports = [...nextReports.values()];
      if (!reports.some(({ id }) => id === selectedReportId)) selectedReportId = null;
      reportLoadBusy = false;
      fixtureBanner.hidden = !fixture;
      renderReports();
      mapStatusText.textContent = hasMore
        ? t('map.countLoadedTruncated', { count: reports.filter((report) => selectedRoutes.has(report.route)
          && (includeResolved || report.status !== 'RESOLVED')).length })
        : countMessage(reports.filter((report) => selectedRoutes.has(report.route)
          && (includeResolved || report.status !== 'RESOLVED')).length, fixture, t);
    } catch (error) {
      if (generation !== loadGeneration) return;
      fixtureBanner.hidden = true;
      reports = [];
      selectedReportId = null;
      reportLoadBusy = false;
      reportLoadFailed = true;
      mapStatusText.textContent = error instanceof ApiClientError
        ? errorText(error)
        : t('map.reportsUnavailable');
      const canRetry = error instanceof ApiClientError && error.retryable;
      retryButton.hidden = !canRetry;
      if (canRetry) deferRetry(error);
      renderReports();
    } finally {
      if (generation === loadGeneration) {
        reportLoadBusy = false;
        mapStatus.setAttribute('aria-busy', 'false');
      }
    }
  }

  retryButton.addEventListener('click', () => {
    if (!retryButton.hidden && !retryButton.disabled) void loadReports();
  });
  fitButton.addEventListener('click', () => {
    viewport = viewportForReports(reports.filter((report) => selectedRoutes.has(report.route)
      && (includeResolved || report.status !== 'RESOLVED')),
      cityViewport(clientDesign.map.center));
    renderReports();
  });

  void loadReports();
  return page;
}
