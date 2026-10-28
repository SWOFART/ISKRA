import { ReportDetailSchema, type Photo, type ReportSummary, type Route, type Stage } from '../shared/contracts';
import type { Infer } from '../shared/schema';
import type { SupportedLocale } from './designTokens';
import { formatDateTime, type MessageKey, type MessageValues } from './i18n';
import { renderPhotoGallery, type PhotoGalleryView } from './PhotoGallery';

type Translate = (key: MessageKey, values?: MessageValues) => string;
type ReportDetail = Infer<typeof ReportDetailSchema>;
type GalleryStage = 'before' | 'after';
type SheetState = 'closed' | 'partial' | 'full';

export interface ReportSheetOptions {
  t: Translate;
  locale: SupportedLocale;
  onLocaleChange(locale: SupportedLocale): void;
  onClose(reportId: string): void;
  onRetry(reportId: string): void;
  refreshPhotos(reportId: string, stage: GalleryStage): Promise<readonly Photo[]>;
  onVisibilityChange(open: boolean): void;
}

export interface ReportSheetView {
  element: HTMLElement;
  open(report: ReportSummary): void;
  setDetail(detail: ReportDetail): void;
  setError(): void;
  dismiss(): void;
  dispose(): void;
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
  button.setAttribute('aria-label', label);
  return button;
}

function appendElements(parent: HTMLElement, ...elements: HTMLElement[]): void {
  for (const element of elements) parent.appendChild(element);
}

function routeKey(route: Route): MessageKey {
  switch (route) {
    case 'GREEN': return 'map.route.green';
    case 'YELLOW': return 'map.route.yellow';
    case 'RED': return 'map.route.red';
  }
}

function statusKey(status: ReportSummary['status']): MessageKey {
  switch (status) {
    case 'AWAITING_EXISTENCE': return 'map.status.awaitingExistence';
    case 'VERIFIED': return 'map.status.confirmedOpen';
    case 'AWAITING_RESOLUTION': return 'map.status.awaitingResolution';
    case 'RESOLVED': return 'map.status.resolved';
  }
}

function stageKey(stage: Stage): MessageKey {
  return stage === 'EXISTENCE' ? 'report.stage.existence' : 'report.stage.resolution';
}

export function renderReportSheet(options: ReportSheetOptions): ReportSheetView {
  let sheetState: SheetState = 'closed';
  let summary: ReportSummary | null = null;
  let detail: ReportDetail | null = null;
  let pointerStart: number | null = null;
  let galleries: PhotoGalleryView[] = [];

  const root = makeElement('div', 'report-sheet-layer');
  root.hidden = true;
  const backdrop = makeElement('div', 'report-sheet-backdrop');
  backdrop.setAttribute('aria-hidden', 'true');
  const dialog = makeElement('section', 'report-sheet');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'report-sheet-heading');

  const handle = makeElement('div', 'report-sheet-handle');
  handle.setAttribute('aria-hidden', 'true');
  const header = makeElement('header', 'report-sheet-header');
  const heading = makeElement('h2', 'report-sheet-heading', options.t('report.heading'));
  heading.id = 'report-sheet-heading';
  const localeGroup = makeElement('div', 'report-sheet-locale');
  localeGroup.setAttribute('role', 'group');
  localeGroup.setAttribute('aria-label', options.t('header.localeLabel'));
  for (const [locale, label] of [['en', 'English'], ['de', 'Deutsch']] as const) {
    const button = makeButton(label, 'report-sheet-locale-button');
    button.setAttribute('lang', locale);
    button.setAttribute('aria-pressed', String(locale === options.locale));
    button.addEventListener('click', () => options.onLocaleChange(locale));
    localeGroup.appendChild(button);
  }
  const headerActions = makeElement('div', 'report-sheet-header-actions');
  const expandButton = makeButton(options.t('report.expand'), 'report-sheet-expand');
  const closeButton = makeButton(options.t('report.close'), 'report-sheet-close');
  appendElements(headerActions, localeGroup, expandButton, closeButton);
  appendElements(header, heading, headerActions);

  const content = makeElement('div', 'report-sheet-content');
  content.tabIndex = 0;
  content.setAttribute('aria-busy', 'false');
  appendElements(dialog, handle, header, content);
  appendElements(root, backdrop, dialog);

  function disposeGalleries(): void {
    for (const gallery of galleries) gallery.dispose();
    galleries = [];
  }

  function setState(next: Exclude<SheetState, 'closed'>): void {
    sheetState = next;
    dialog.dataset.state = next;
    dialog.classList.toggle('report-sheet--full', next === 'full');
    expandButton.textContent = options.t(next === 'full' ? 'report.collapse' : 'report.expand');
    expandButton.setAttribute('aria-label', options.t(next === 'full' ? 'report.collapse' : 'report.expand'));
    expandButton.setAttribute('aria-expanded', String(next === 'full'));
  }

  function renderLoading(): void {
    disposeGalleries();
    content.setAttribute('aria-busy', 'true');
    const loading = makeElement('p', 'report-sheet-message', options.t('report.loading'));
    loading.setAttribute('role', 'status');
    content.replaceChildren(loading);
  }

  function renderError(): void {
    disposeGalleries();
    content.setAttribute('aria-busy', 'false');
    const message = makeElement('p', 'report-sheet-message', options.t('report.loadError'));
    message.setAttribute('role', 'status');
    const retry = makeButton(options.t('report.retry'), 'report-sheet-retry');
    retry.addEventListener('click', () => { if (summary) options.onRetry(summary.id); });
    content.replaceChildren(message, retry);
  }

  function renderDetail(): void {
    if (!summary || !detail) { renderLoading(); return; }
    disposeGalleries();
    content.setAttribute('aria-busy', 'false');

    const route = makeElement('span', `report-route report-route--${detail.route.toLowerCase()}`,
      options.t(routeKey(detail.route)));
    const status = makeElement('p', 'report-detail-status', options.t(statusKey(detail.status)));
    const description = makeElement('p', 'report-detail-description', detail.description);
    const overview = makeElement('section', 'report-detail-overview');
    overview.setAttribute('aria-label', options.t('report.overview'));
    appendElements(overview, route, status, description);

    const progress = makeElement('section', 'report-stage-progress');
    progress.setAttribute('aria-label', options.t('report.progress'));
    const progressHeading = makeElement('h3', undefined, options.t('report.progress'));
    const existence = makeElement('p', 'report-stage-count', options.t('map.progress.existence', {
      threshold: Math.min(detail.existenceYesCount, 3),
      total: detail.existenceYesCount,
    }));
    appendElements(progress, progressHeading, existence);
    if (detail.lastExistenceConfirmedAt) {
      const date = formatDateTime(options.locale, detail.lastExistenceConfirmedAt);
      progress.appendChild(makeElement('p', 'report-latest-confirmation', options.t('map.progress.latest', { date })));
    }
    if (detail.afterPhotos.length > 0 || detail.status === 'AWAITING_RESOLUTION' || detail.status === 'RESOLVED') {
      const resolutionText = detail.status === 'RESOLVED'
        ? options.t('map.progress.resolved')
        : options.t('map.progress.resolution', { count: detail.resolutionYesCount });
      progress.appendChild(makeElement('p', 'report-stage-count', resolutionText));
    }
    if (detail.openVoteStages.length > 0) {
      const current = detail.currentStage ? options.t(stageKey(detail.currentStage)) : '';
      const openStages = detail.openVoteStages.map((stage) => options.t(stageKey(stage))).join(', ');
      const stages = makeElement('p', 'report-open-stages', options.t('report.openStages', { current, stages: openStages }));
      progress.appendChild(stages);
    }

    const beforeGallery = renderPhotoGallery({
      title: options.t('report.beforePhotos'),
      photos: detail.beforePhotos,
      t: options.t,
      refreshPhotos: () => options.refreshPhotos(detail!.id, 'before'),
    });
    galleries.push(beforeGallery);
    const afterGallery = renderPhotoGallery({
      title: options.t('report.afterPhotos'),
      photos: detail.afterPhotos,
      t: options.t,
      refreshPhotos: () => options.refreshPhotos(detail!.id, 'after'),
    });
    galleries.push(afterGallery);

    content.replaceChildren(overview, progress, beforeGallery.element, afterGallery.element);
  }

  function open(report: ReportSummary): void {
    summary = report;
    detail = null;
    root.hidden = false;
    options.onVisibilityChange(true);
    setState('partial');
    renderLoading();
    closeButton.focus();
  }

  function close(notify = true): void {
    if (sheetState === 'closed') return;
    const reportId = summary?.id;
    sheetState = 'closed';
    root.hidden = true;
    disposeGalleries();
    content.replaceChildren();
    options.onVisibilityChange(false);
    if (notify && reportId) options.onClose(reportId);
  }

  function focusableElements(): HTMLButtonElement[] {
    return Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
      .filter((button) => !button.hidden && !button.closest('[hidden]'));
  }

  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements();
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });

  function cycleSheetByDrag(deltaY: number): void {
    if (deltaY < -48) setState('full');
    else if (deltaY > 48) {
      if (sheetState === 'full') setState('partial');
      else close();
    }
  }

  handle.addEventListener('pointerdown', (event) => { pointerStart = event.clientY; });
  handle.addEventListener('pointerup', (event) => {
    if (pointerStart === null) return;
    cycleSheetByDrag(event.clientY - pointerStart);
    pointerStart = null;
  });
  handle.addEventListener('pointercancel', () => { pointerStart = null; });
  expandButton.addEventListener('click', () => setState(sheetState === 'full' ? 'partial' : 'full'));
  closeButton.addEventListener('click', () => close());
  backdrop.addEventListener('click', () => close());

  return {
    element: root,
    open,
    setDetail(nextDetail) {
      if (!summary || nextDetail.id !== summary.id) return;
      detail = nextDetail;
      renderDetail();
    },
    setError: renderError,
    dismiss: () => close(false),
    dispose() {
      close(false);
      root.parentNode?.removeChild(root);
    },
  };
}
