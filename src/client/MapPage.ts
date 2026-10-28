import { ReportDetailSchema, ReportListSchema, type ErrorCode, type Photo, type Point, type ReportSummary, type Route } from '../shared/contracts';
import type { Map as MapLibreMap } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { ApiClientError, createClientApi } from './api';
import { clientDesign, type SupportedLocale } from './designTokens';
import { errorMessageKey, type MessageKey, type MessageValues } from './i18n';
import { cityViewport, clusterReports, viewportForReports, type GeoBounds } from './mapModel';
import { renderPhotoCapture, type CapturedPhoto, type CaptureStage } from './PhotoCapture';
import { renderReportSheet } from './ReportSheet';
import {
  acquireFreshLocation,
  bindCleanupLocation,
  bindReportLocation,
  isLocationRecoveryError,
  LocationCaptureError,
  type AnalysisLocationBinding,
  type LocationCaptureFailure,
} from './locationCapture';

type ClientApi = ReturnType<typeof createClientApi>;
type Translate = (key: MessageKey, values?: MessageValues) => string;

const routeOrder: readonly Route[] = ['GREEN', 'YELLOW', 'RED'];
const routeKeys: Record<Route, MessageKey> = {
  GREEN: 'map.route.green',
  YELLOW: 'map.route.yellow',
  RED: 'map.route.red',
};
const defaultMapStyleUrl = 'https://api.maptiler.com/maps/streets-v4/style.json';

export interface MapPageView {
  element: HTMLElement;
  state: MapPageState;
  mount(): void;
  openCapture(stage: 'report'): void;
  openCapture(stage: 'cleanup', reportPin: Point): void;
  getLocationBinding(): AnalysisLocationBinding | null;
  locationRejected(code: ErrorCode): void;
  dispose(): void;
}

export interface MapPageState {
  routes: Route[];
  needsVerification: boolean;
  includeResolved: boolean;
  selectedReportId: string | null;
  expandedClusterReportIds: string[] | null;
  center: { latitude: number; longitude: number };
  zoom: number;
}

function createMapPageState(): MapPageState {
  return {
    routes: [...routeOrder],
    needsVerification: false,
    includeResolved: false,
    selectedReportId: null,
    expandedClusterReportIds: null,
    center: { ...clientDesign.map.center },
    zoom: clientDesign.map.zoom,
  };
}

function mapStyleUrl(): string | null {
  const key = import.meta.env.VITE_MAPTILER_KEY?.trim();
  if (!key) return null;

  try {
    const url = new URL(import.meta.env.VITE_MAP_STYLE_URL?.trim() || defaultMapStyleUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'api.maptiler.com'
      || url.username || url.password || url.hash
      || !/^\/maps\/[a-zA-Z0-9_-]+\/style\.json$/.test(url.pathname)) return null;
    url.search = '';
    url.searchParams.set('key', key);
    return url.toString();
  } catch {
    return null;
  }
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
  initialState?: MapPageState,
  setChromeInert?: (inert: boolean) => void,
  onLocaleChange?: (locale: SupportedLocale) => void,
): MapPageView {
  const pageState = initialState ?? createMapPageState();
  const page = makeElement('section', 'map-page');
  page.setAttribute('aria-label', t('map.region'));

  const mapArea = makeElement('div', 'map-area');
  const mapCanvas = makeElement('div', 'map-canvas');
  mapCanvas.setAttribute('data-latitude', String(clientDesign.map.center.latitude));
  mapCanvas.setAttribute('data-longitude', String(clientDesign.map.center.longitude));
  mapCanvas.setAttribute('data-zoom', String(clientDesign.map.zoom));

  const markerLayer = makeElement('div', 'map-marker-layer');
  markerLayer.setAttribute('aria-label', t('map.markersLabel'));
  const mapViewport = makeElement('div', 'map-viewport');
  mapViewport.setAttribute('role', 'region');
  mapViewport.setAttribute('aria-label', t('map.canvasLabel'));
  appendElements(mapViewport, mapCanvas, markerLayer);

  const tileStatus = makeElement('div', 'map-tile-status');
  tileStatus.setAttribute('role', 'status');
  tileStatus.setAttribute('aria-live', 'polite');
  tileStatus.setAttribute('aria-busy', 'false');
  tileStatus.hidden = true;
  const tileStatusText = makeElement('span', undefined, t('map.tilesUnavailable'));
  const retryTilesButton = makeButton(t('map.retryTiles'), 'retry-tiles-button');
  retryTilesButton.setAttribute('aria-label', t('map.retryTilesLabel'));
  retryTilesButton.hidden = true;
  appendElements(tileStatus, tileStatusText, retryTilesButton);

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
  const selectedRoutes = new Set<Route>(pageState.routes);
  let needsVerification = pageState.needsVerification;
  let includeResolved = pageState.includeResolved;
  let selectedReportId = pageState.selectedReportId;
  let expandedClusterReportIds = pageState.expandedClusterReportIds;
  const needsVerificationButton = makeButton(t('map.filter.needsVerification'), 'map-filter-button');
  needsVerificationButton.setAttribute('aria-pressed', String(needsVerification));
  needsVerificationButton.addEventListener('click', () => {
    needsVerification = !needsVerification;
    pageState.needsVerification = needsVerification;
    needsVerificationButton.setAttribute('aria-pressed', String(needsVerification));
    void loadReports();
  });
  const resolvedButton = makeButton(t('map.filter.resolved'), 'map-filter-button');
  resolvedButton.setAttribute('aria-pressed', String(includeResolved));
  resolvedButton.addEventListener('click', () => {
    includeResolved = !includeResolved;
    pageState.includeResolved = includeResolved;
    resolvedButton.setAttribute('aria-pressed', String(includeResolved));
    void loadReports();
  });

  for (const route of routeOrder) {
    const button = makeButton(routeLabel(route, t), `route-filter route-filter--${route.toLowerCase()}`);
    button.setAttribute('aria-pressed', String(selectedRoutes.has(route)));
    button.setAttribute('data-route', route);
    button.addEventListener('click', () => {
      if (selectedRoutes.has(route)) selectedRoutes.delete(route);
      else selectedRoutes.add(route);
      pageState.routes = routeOrder.filter((selected) => selectedRoutes.has(selected));
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
  const clusterDetails = makeElement('section', 'map-cluster-details');
  clusterDetails.setAttribute('aria-label', t('map.clusterDetails.region'));
  clusterDetails.setAttribute('aria-live', 'polite');
  clusterDetails.hidden = true;
  const clusterDetailsHeading = makeElement('h3', 'map-cluster-details-heading');
  const clusterDetailsList = makeElement('ul', 'map-cluster-details-list');
  appendElements(clusterDetails, clusterDetailsHeading, clusterDetailsList);
  const reportList = makeElement('ul', 'map-report-list');
  reportList.id = 'map-report-list';
  appendElements(listPanel, fixtureBanner, listHeader, clusterDetails, reportList);

  appendElements(mapArea,
    mapViewport,
    tileStatus,
    mapLabel,
    mapStatus,
    filterBar,
    fitButton,
    reportButton,
    mapNotice,
  );
  appendElements(page, mapArea, listPanel);

  let reports: ReportSummary[] = [];
  let detailLoadGeneration = 0;
  const reportSheet = renderReportSheet({
    t,
    locale,
    onLocaleChange: (nextLocale) => onLocaleChange?.(nextLocale),
    onClose: (reportId) => {
      detailLoadGeneration += 1;
      selectedReportId = null;
      pageState.selectedReportId = null;
      renderReports();
      reportList.querySelector<HTMLButtonElement>(`.report-list-item[data-report-id="${reportId}"]`)?.focus();
    },
    onRetry: (reportId) => { void loadReportDetail(reportId); },
    refreshPhotos: async (reportId, stage): Promise<readonly Photo[]> => {
      const response = await api.request({
        path: `/reports/${reportId}`,
        responseSchema: ReportDetailSchema,
      });
      return stage === 'before' ? response.data.beforePhotos : response.data.afterPhotos;
    },
    onVisibilityChange: (open) => {
      mapArea.inert = open;
      listPanel.inert = open;
      setChromeInert?.(open);
    },
  });
  page.appendChild(reportSheet.element);
  const setCaptureModalInert = (open: boolean): void => {
    mapArea.inert = open;
    listPanel.inert = open;
    setChromeInert?.(open);
  };
  const photoCapture = renderPhotoCapture({
    t,
    onContinue: (photos, stage) => showCaptureHandoff(photos, stage, captureTarget),
    onExit: () => reportButton.focus(),
    onVisibilityChange: setCaptureModalInert,
  });
  page.appendChild(photoCapture.element);

  const captureHandoff = makeElement('section', 'photo-capture-handoff');
  captureHandoff.hidden = true;
  captureHandoff.setAttribute('role', 'dialog');
  captureHandoff.setAttribute('aria-modal', 'true');
  const handoffHeading = makeElement('h2', 'photo-capture-handoff-heading', t('capture.handoffHeading'));
  handoffHeading.id = 'photo-capture-handoff-heading';
  captureHandoff.setAttribute('aria-labelledby', handoffHeading.id);
  const handoffCard = makeElement('div', 'photo-capture-handoff-card');
  const handoffMessage = makeElement('p', 'photo-capture-handoff-message');
  const handoffPhotosLabel = makeElement('p', 'photo-capture-count');
  const handoffPhotosList = makeElement('ol', 'photo-capture-list photo-capture-handoff-list');
  const handoffLocationStatus = makeElement('p', 'photo-capture-location-status');
  handoffLocationStatus.setAttribute('role', 'status');
  handoffLocationStatus.setAttribute('aria-live', 'polite');
  handoffLocationStatus.setAttribute('aria-busy', 'false');
  const handoffActions = makeElement('div', 'photo-capture-handoff-actions');
  const editPhotosButton = makeButton(t('capture.editPhotos'), 'photo-capture-edit');
  const requestLocationButton = makeButton(t('capture.getLocation'), 'photo-capture-location');
  const discardPhotosButton = makeButton(t('capture.discardSession'), 'photo-capture-discard');
  appendElements(handoffActions, editPhotosButton, requestLocationButton, discardPhotosButton);
  appendElements(handoffCard, handoffHeading, handoffMessage, handoffPhotosLabel, handoffPhotosList, handoffLocationStatus, handoffActions);
  captureHandoff.appendChild(handoffCard);
  page.appendChild(captureHandoff);

  let handoffPhotos: readonly CapturedPhoto[] = [];
  let handoffStage: CaptureStage = 'report';
  let captureTarget: Point | undefined;
  let handoffTarget: Point | undefined;
  let handoffLocationBinding: AnalysisLocationBinding | null = null;
  let locationRequestGeneration = 0;

  function locationFailureKey(failure: LocationCaptureFailure): MessageKey {
    switch (failure) {
      case 'unsupported': return 'capture.locationUnsupported';
      case 'permission': return 'capture.locationPermission';
      case 'timeout': return 'capture.locationTimeout';
      case 'unavailable': return 'capture.locationUnavailable';
      case 'inaccurate': return 'capture.locationInaccurate';
      case 'stale': return 'capture.locationStale';
      case 'tooFar': return 'capture.locationTooFar';
    }
  }

  function resetHandoffLocation(): void {
    locationRequestGeneration += 1;
    handoffLocationBinding = null;
    handoffLocationStatus.textContent = t('capture.locationNotRequested');
    handoffLocationStatus.setAttribute('aria-busy', 'false');
    requestLocationButton.disabled = false;
    requestLocationButton.textContent = t('capture.getLocation');
  }

  async function requestHandoffLocation(): Promise<void> {
    const generation = ++locationRequestGeneration;
    handoffLocationBinding = null;
    handoffLocationStatus.textContent = t('capture.locationRequesting');
    handoffLocationStatus.setAttribute('aria-busy', 'true');
    requestLocationButton.disabled = true;
    try {
      const fix = await acquireFreshLocation();
      const binding = handoffStage === 'report'
        ? bindReportLocation(fix)
        : handoffTarget
          ? bindCleanupLocation(fix, handoffTarget)
          : null;
      if (!binding) throw new Error('Cleanup location capture requires the report pin.');
      if (generation !== locationRequestGeneration || captureHandoff.hidden) return;
      handoffLocationBinding = binding;
      handoffLocationStatus.textContent = binding.purpose === 'report'
        ? t('capture.locationSuccessReport', { accuracy: Math.round(binding.location.accuracyM) })
        : t('capture.locationSuccessCleanup', {
          accuracy: Math.round(binding.location.accuracyM),
          distance: Math.round(binding.distanceM),
        });
      requestLocationButton.textContent = t('capture.refreshLocation');
    } catch (error) {
      if (generation !== locationRequestGeneration || captureHandoff.hidden) return;
      const reason = error instanceof LocationCaptureError ? error.reason : 'unavailable';
      handoffLocationStatus.textContent = t(locationFailureKey(reason));
      requestLocationButton.textContent = t('capture.retryLocation');
    } finally {
      if (generation === locationRequestGeneration && !captureHandoff.hidden) {
        handoffLocationStatus.setAttribute('aria-busy', 'false');
        requestLocationButton.disabled = false;
      }
    }
  }

  function showCaptureHandoff(photos: readonly CapturedPhoto[], stage: CaptureStage, target?: Point): void {
    handoffPhotos = [...photos];
    handoffStage = stage;
    handoffTarget = target ? { lat: target.lat, lng: target.lng } : undefined;
    handoffHeading.textContent = t('capture.handoffHeading');
    handoffMessage.textContent = t('capture.handoffMessage', { count: handoffPhotos.length });
    handoffPhotosLabel.textContent = t('capture.photoCount', { count: handoffPhotos.length });
    resetHandoffLocation();
    handoffPhotosList.replaceChildren();
    handoffPhotos.forEach((photo, index) => {
      const item = makeElement('li', 'photo-capture-item');
      const preview = makeElement('img', 'photo-capture-preview');
      preview.src = photo.previewUrl;
      preview.alt = t('capture.photoAlt', { index: index + 1 });
      preview.referrerPolicy = 'no-referrer';
      item.appendChild(preview);
      handoffPhotosList.appendChild(item);
    });
    captureHandoff.hidden = false;
    setCaptureModalInert(true);
    editPhotosButton.focus();
  }

  editPhotosButton.addEventListener('click', () => {
    captureHandoff.hidden = true;
    handoffPhotos = [];
    resetHandoffLocation();
    setCaptureModalInert(false);
    photoCapture.open(handoffStage);
  });
  requestLocationButton.addEventListener('click', () => { void requestHandoffLocation(); });
  discardPhotosButton.addEventListener('click', () => {
    captureHandoff.hidden = true;
    handoffPhotos = [];
    handoffTarget = undefined;
    captureTarget = undefined;
    resetHandoffLocation();
    setCaptureModalInert(false);
    photoCapture.discard();
  });
  captureHandoff.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      editPhotosButton.click();
      return;
    }
    if (event.key !== 'Tab') return;
    const buttons = [editPhotosButton, requestLocationButton, discardPhotosButton]
      .filter((button) => !button.hidden && !button.disabled);
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  let mapInstance: MapLibreMap | null = null;
  let mapReady = false;
  let tileFailureSeen = false;
  let resizeObserver: ResizeObserver | undefined;
  let mapGeneration = 0;
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

  function fitMapToReports(targetReports: readonly ReportSummary[]): void {
    if (!mapInstance || !mapReady || targetReports.length === 0) return;
    const bounds = viewportForReports(targetReports, cityViewport(clientDesign.map.center));
    mapInstance.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], {
      padding: 72,
      maxZoom: 16,
      duration: 300,
    });
  }

  async function loadReportDetail(reportId: string): Promise<void> {
    const generation = ++detailLoadGeneration;
    try {
      const response = await api.request({
        path: `/reports/${reportId}`,
        responseSchema: ReportDetailSchema,
      });
      if (generation !== detailLoadGeneration || selectedReportId !== reportId) return;
      reportSheet.setDetail(response.data);
    } catch {
      if (generation === detailLoadGeneration && selectedReportId === reportId) reportSheet.setError();
    }
  }

  function selectReport(report: ReportSummary, fit = false): void {
    if (fit) fitMapToReports([report]);
    selectedReportId = report.id;
    pageState.selectedReportId = report.id;
    reportSheet.open(report);
    renderReports();
    void loadReportDetail(report.id);
  }

  function rememberMapCamera(): void {
    if (!mapInstance) return;
    const center = mapInstance.getCenter();
    pageState.center = { latitude: center.lat, longitude: center.lng };
    pageState.zoom = mapInstance.getZoom();
  }

  function renderReports(): void {
    const visibleReports = reports.filter((report) => selectedRoutes.has(report.route)
      && (includeResolved || report.status !== 'RESOLVED'));
    const mapWidth = mapViewport.clientWidth || 1000;
    const mapHeight = mapViewport.clientHeight || 700;
    const clusters = mapInstance && mapReady
      ? clusterReports(visibleReports, cityViewport(clientDesign.map.center), 54, mapWidth, mapHeight,
        (location) => {
          if (!mapInstance?.getBounds().contains([location.lng, location.lat])) return null;
          const point = mapInstance.project([location.lng, location.lat]);
          return { x: point.x, y: point.y };
        })
      : [];
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
      marker.style.left = `${left}%`;
      marker.style.top = `${top}%`;
      marker.setAttribute('aria-label', cluster.reports.length > 1
        ? t('map.clusterLabel', { count: cluster.reports.length, routes: routeSummary })
        : t('map.markerLabel', {
          route: routeLabel(cluster.reports[0].route, t),
          status: statusLabel(cluster.reports[0], t),
        }));
      marker.setAttribute('aria-controls', reportList.id);
      marker.setAttribute('aria-pressed', String(cluster.reports.some(({ id }) => id === selectedReportId)));
      marker.addEventListener('click', () => {
        expandedClusterReportIds = cluster.reports.length > 1
          ? cluster.reports.map(({ id }) => id)
          : null;
        pageState.expandedClusterReportIds = expandedClusterReportIds;
        if (cluster.reports.length > 1) fitMapToReports(cluster.reports);
        selectReport(cluster.reports[0]);
      });
      markerLayer.appendChild(marker);
    }

    const expandedClusterReports = expandedClusterReportIds
      ? visibleReports.filter(({ id }) => expandedClusterReportIds?.includes(id))
      : [];
    clusterDetails.hidden = expandedClusterReports.length === 0;
    clusterDetailsHeading.textContent = expandedClusterReports.length > 0
      ? t('map.clusterDetails.heading', { count: expandedClusterReports.length })
      : '';
    clusterDetailsList.replaceChildren();
    for (const report of expandedClusterReports) {
      const item = makeElement('li', 'map-cluster-report-row');
      const select = makeButton('', 'map-cluster-report');
      select.setAttribute('data-report-id', report.id);
      select.setAttribute('aria-pressed', String(report.id === selectedReportId));
      select.setAttribute('aria-label', t('map.clusterDetails.itemLabel', {
        route: routeLabel(report.route, t),
        status: statusLabel(report, t),
        description: report.description,
      }));
      appendElements(select,
        makeElement('span', `report-route report-route--${report.route.toLowerCase()}`, routeLabel(report.route, t)),
        makeElement('span', 'report-status-text', statusLabel(report, t)),
        makeElement('span', 'report-description', report.description));
      select.addEventListener('click', () => {
        selectReport(report, true);
      });
      item.appendChild(select);
      clusterDetailsList.appendChild(item);
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
        selectReport(report, true);
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

  async function loadReports(preserveSelection = false): Promise<void> {
    clearRetryTimer();
    const generation = ++loadGeneration;
    retryButton.disabled = false;
    retryButton.hidden = true;
    mapStatus.setAttribute('aria-busy', 'true');
    mapStatusText.textContent = t('map.loading');
    reportLoadBusy = true;
    reportLoadFailed = false;
    reports = [];
    if (!preserveSelection) {
      selectedReportId = null;
      expandedClusterReportIds = null;
      pageState.selectedReportId = null;
      pageState.expandedClusterReportIds = null;
      detailLoadGeneration += 1;
      reportSheet.dismiss();
    }
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
      if (!reports.some(({ id }) => id === selectedReportId)) {
        selectedReportId = null;
        pageState.selectedReportId = null;
        reportSheet.dismiss();
      }
      expandedClusterReportIds = expandedClusterReportIds?.filter((id) => reports.some(({ id: reportId }) => reportId === id)) ?? null;
      pageState.expandedClusterReportIds = expandedClusterReportIds;
      reportLoadBusy = false;
      fixtureBanner.hidden = !fixture;
      if (preserveSelection && selectedReportId) {
        const selectedReport = reports.find(({ id }) => id === selectedReportId);
        if (selectedReport) {
          reportSheet.open(selectedReport);
          void loadReportDetail(selectedReport.id);
        }
      }
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
      if (!preserveSelection) {
        selectedReportId = null;
        expandedClusterReportIds = null;
        pageState.selectedReportId = null;
        pageState.expandedClusterReportIds = null;
      }
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
    fitMapToReports(reports.filter((report) => selectedRoutes.has(report.route)
      && (includeResolved || report.status !== 'RESOLVED')),
    );
    renderReports();
  });

  function showTileFailure(missingKey = false): void {
    tileStatusText.textContent = t(missingKey ? 'map.tilesMissingKey' : 'map.tilesUnavailable');
    retryTilesButton.hidden = missingKey;
    retryTilesButton.disabled = false;
    tileStatus.setAttribute('aria-busy', 'false');
    tileStatus.hidden = false;
  }

  async function initializeMap(): Promise<void> {
    if (typeof HTMLElement === 'undefined' || !(mapCanvas instanceof HTMLElement)) return;
    const style = mapStyleUrl();
    if (!style) {
      showTileFailure(true);
      return;
    }

    const generation = ++mapGeneration;
    tileStatusText.textContent = t('map.tilesLoading');
    tileStatus.setAttribute('aria-busy', 'true');
    tileStatus.hidden = false;
    retryTilesButton.hidden = true;
    retryTilesButton.disabled = true;
    try {
      const { Map: MapLibreMapConstructor, setWorkerUrl } = await import('maplibre-gl');
      if (generation !== mapGeneration || !mapCanvas.isConnected) return;
      setWorkerUrl(maplibreWorkerUrl);
      const cityBounds = cityViewport(clientDesign.map.center);
      const instance = new MapLibreMapConstructor({
        container: mapCanvas,
        style,
        center: [pageState.center.longitude, pageState.center.latitude],
        zoom: pageState.zoom,
        minZoom: 11,
        maxZoom: 18,
        maxBounds: [[cityBounds.west, cityBounds.south], [cityBounds.east, cityBounds.north]],
        pitchWithRotate: false,
        dragRotate: false,
      });
      mapInstance = instance;
      mapReady = false;
      tileFailureSeen = false;
      instance.on('error', () => {
        if (mapInstance !== instance) return;
        tileFailureSeen = true;
        showTileFailure();
      });
      instance.once('load', () => {
        if (mapInstance !== instance) return;
        mapReady = true;
        instance.resize();
        if (!tileFailureSeen) {
          tileStatus.hidden = true;
          tileStatus.setAttribute('aria-busy', 'false');
          retryTilesButton.disabled = false;
        }
        renderReports();
      });
      instance.on('moveend', () => {
        rememberMapCamera();
        renderReports();
      });
      resizeObserver = new ResizeObserver(() => instance.resize());
      resizeObserver.observe(mapViewport);
    } catch {
      if (generation === mapGeneration) showTileFailure();
    }
  }

  retryTilesButton.addEventListener('click', () => {
    if (retryTilesButton.hidden) return;
    retryTilesButton.disabled = true;
    mapInstance?.remove();
    mapInstance = null;
    mapReady = false;
    mapGeneration += 1;
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    void initializeMap();
  });

  function disposeMap(): void {
    loadGeneration += 1;
    mapGeneration += 1;
    detailLoadGeneration += 1;
    clearRetryTimer();
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    rememberMapCamera();
    mapInstance?.remove();
    mapInstance = null;
    mapReady = false;
    reportSheet.dispose();
    handoffPhotos = [];
    handoffLocationBinding = null;
    handoffTarget = undefined;
    captureTarget = undefined;
    locationRequestGeneration += 1;
    captureHandoff.hidden = true;
    photoCapture.dispose();
  }

  void loadReports(initialState !== undefined);
  return {
    element: page,
    state: pageState,
    mount: () => { void initializeMap(); },
    openCapture: ((stage: CaptureStage, target?: Point) => {
      if (stage === 'cleanup' && !target) throw new TypeError('Cleanup capture requires the report pin.');
      captureTarget = target ? { lat: target.lat, lng: target.lng } : undefined;
      photoCapture.open(stage);
    }) as MapPageView['openCapture'],
    getLocationBinding: () => handoffLocationBinding,
    locationRejected: (code) => {
      if (!isLocationRecoveryError(code) || captureHandoff.hidden) return;
      resetHandoffLocation();
      handoffLocationStatus.textContent = t(code === 'TOO_FAR'
        ? 'capture.locationTooFar'
        : code === 'LOCATION_INACCURATE'
          ? 'capture.locationInaccurate'
          : code === 'PIN_TOO_FAR'
            ? 'capture.locationPinRejected'
            : 'capture.locationStale');
      requestLocationButton.textContent = t('capture.retryLocation');
      requestLocationButton.focus();
    },
    dispose: disposeMap,
  };
}
