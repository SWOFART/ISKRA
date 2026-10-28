import {
  POLICY,
  PublicationReceiptSchema,
  PublishRequestSchema,
  ReportAnalysisRequestSchema,
  ReportAnalysisSchema,
  ReportAssessmentSchema,
  UploadRequestSchema,
  UploadTicketSchema,
  type ErrorCode,
  type Location,
  type Point,
  type Route,
} from '../shared/contracts';
import type { Infer } from '../shared/schema';
import { ApiClientError, createClientApi, type ApiResult } from './api';
import { createOperationKeyScope } from './operationKey';
import { captureFreshReportLocation, isLocationRecoveryError, LocationCaptureError, type ReportLocationBinding } from './locationCapture';
import { errorMessageKey, type MessageKey, type MessageValues } from './i18n';
import type { SupportedLocale } from './designTokens';
import type { CapturedPhoto } from './PhotoCapture';

type ClientApi = ReturnType<typeof createClientApi>;
type Translate = (key: MessageKey, values?: MessageValues) => string;
type ReportAnalysis = Infer<typeof ReportAnalysisSchema>;
type ReportAssessment = Infer<typeof ReportAssessmentSchema>;
type PublicationReceipt = Infer<typeof PublicationReceiptSchema>;
type UploadTicket = Infer<typeof UploadTicketSchema>;
type UploadState = { ticket?: UploadTicket; photoId?: string };

const analysisPollIntervalMs = 750;
const analysisWaitLimitMs = 90_000;

export interface ReportSubmissionOptions {
  api: ClientApi;
  t: Translate;
  locale: SupportedLocale;
  onEditPhotos(): void;
  onDiscard(): void;
  onPublished(result: ApiResult<PublicationReceipt>): void;
  onVisibilityChange(open: boolean): void;
}

export interface ReportSubmissionView {
  element: HTMLElement;
  open(photos: readonly CapturedPhoto[]): void;
  dispose(): void;
}

function makeElement<K extends keyof HTMLElementTagNameMap>(tagName: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  return element;
}

function makeButton(label: string, className: string): HTMLButtonElement {
  const button = makeElement('button', className);
  button.type = 'button';
  button.textContent = label;
  return button;
}

function routeKey(route: Route): MessageKey {
  return `map.route.${route.toLowerCase()}` as MessageKey;
}

function errorCode(error: unknown): ErrorCode | 'INVALID_RESPONSE' | undefined {
  return error instanceof ApiClientError ? error.code : undefined;
}

export function renderReportSubmission(options: ReportSubmissionOptions): ReportSubmissionView {
  const { api, t } = options;
  const root = makeElement('section', 'photo-capture-handoff');
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  const card = makeElement('div', 'photo-capture-handoff-card');
  const heading = makeElement('h2', 'photo-capture-handoff-heading');
  heading.id = 'report-submission-heading';
  root.setAttribute('aria-labelledby', heading.id);
  const message = makeElement('p', 'photo-capture-handoff-message');
  const photoCount = makeElement('p', 'photo-capture-count');
  const photoList = makeElement('ol', 'photo-capture-list photo-capture-handoff-list');
  photoList.setAttribute('aria-label', t('capture.photoList'));
  const locationStatus = makeElement('p', 'photo-capture-location-status');
  locationStatus.setAttribute('role', 'status');
  locationStatus.setAttribute('aria-live', 'polite');
  const fixtureNotice = makeElement('p', 'report-fixture-banner');
  fixtureNotice.setAttribute('role', 'note');
  fixtureNotice.textContent = t('fixture.banner');
  fixtureNotice.hidden = api.mode !== 'fixture';
  const analysisStatus = makeElement('p', 'report-analysis-status');
  analysisStatus.setAttribute('role', 'status');
  analysisStatus.setAttribute('aria-live', 'polite');
  analysisStatus.setAttribute('aria-busy', 'false');
  const assessmentPanel = makeElement('section', 'report-assessment');
  assessmentPanel.hidden = true;
  const assessmentReason = makeElement('p', 'report-assessment-reason');
  const retakeGuidance = makeElement('p', 'report-retake-guidance');
  retakeGuidance.setAttribute('role', 'status');
  const acceptedPreview = makeElement('div', 'report-accepted-preview');
  acceptedPreview.hidden = true;
  const routeLabel = makeElement('span', 'report-route-label');
  routeLabel.textContent = t('capture.lockedRoute');
  const routeValue = makeElement('output', 'report-route-value');
  routeValue.setAttribute('aria-live', 'polite');
  const safetyGuidance = makeElement('p', 'report-safety-guidance');
  safetyGuidance.setAttribute('role', 'alert');
  safetyGuidance.hidden = true;
  const descriptionLabel = makeElement('label', 'report-description-label');
  descriptionLabel.textContent = t('capture.descriptionLabel');
  const description = makeElement('textarea', 'report-description-input');
  description.id = 'report-description-input';
  description.maxLength = 1000;
  description.rows = 4;
  descriptionLabel.htmlFor = description.id;
  const actions = makeElement('div', 'photo-capture-handoff-actions');
  const editPhotosButton = makeButton(t('capture.editPhotos'), 'photo-capture-edit');
  const requestLocationButton = makeButton(t('capture.getLocation'), 'photo-capture-location');
  const analyzeButton = makeButton(t('capture.analyzePhotos'), 'photo-capture-continue');
  const retryButton = makeButton(t('capture.retryAnalysis'), 'photo-capture-retry');
  const publishButton = makeButton(t('capture.publishReport'), 'photo-capture-publish');
  const discardButton = makeButton(t('capture.discardSession'), 'photo-capture-discard');
  retryButton.hidden = true;
  publishButton.hidden = true;
  appendElements(acceptedPreview, routeLabel, routeValue, safetyGuidance, descriptionLabel, description);
  appendElements(assessmentPanel, assessmentReason, retakeGuidance, acceptedPreview);
  appendElements(actions, editPhotosButton, requestLocationButton, analyzeButton, retryButton, publishButton, discardButton);
  appendElements(card, heading, message, photoCount, photoList, locationStatus, fixtureNotice,
    analysisStatus, assessmentPanel, actions);
  root.appendChild(card);

  let photos: readonly CapturedPhoto[] = [];
  let uploads: UploadState[] = [];
  let locationBinding: ReportLocationBinding | null = null;
  let assessment: ReportAssessment | null = null;
  let activeAnalysisId: string | null = null;
  let lastAcceptedAnalysisId: string | null = null;
  let locationGeneration = 0;
  let flowGeneration = 0;
  let busy = false;
  let disposed = false;
  let retryAction: 'analysis' | 'status' | 'publication' | null = null;
  let failureStep: 'upload' | 'analysis' | null = null;
  let retryAvailableAt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const analysisOperation = createOperationKeyScope();
  const publishOperation = createOperationKeyScope();

  function retryIsBlocked(): boolean {
    return retryAvailableAt > Date.now();
  }

  function clearRetryDelay(): void {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    retryAvailableAt = 0;
  }

  function deferRetry(error: unknown): void {
    const delayMs = error instanceof ApiClientError && error.retryable ? error.retryAfterMs : undefined;
    if (!delayMs || delayMs <= 0) return;
    clearRetryDelay();
    retryAvailableAt = Date.now() + delayMs;
    const waitingFlowGeneration = flowGeneration;
    const failureMessage = analysisStatus.textContent;
    analysisStatus.textContent = t('capture.retryWait');
    const enableRetry = () => {
      const remainingMs = retryAvailableAt - Date.now();
      if (remainingMs > 0) {
        retryTimer = setTimeout(enableRetry, Math.min(remainingMs, 2_147_483_647));
        return;
      }
      retryTimer = undefined;
      retryAvailableAt = 0;
      if (!disposed && !root.hidden) {
        analysisStatus.textContent = flowGeneration === waitingFlowGeneration ? failureMessage : '';
        updateActions();
      }
    };
    retryTimer = setTimeout(enableRetry, Math.min(delayMs, 2_147_483_647));
    updateActions();
  }

  function setLocationMessage(key: MessageKey, values?: MessageValues): void {
    locationStatus.textContent = t(key, values);
    locationStatus.setAttribute('aria-busy', 'false');
  }

  function updateActions(): void {
    const accepting = assessment?.decision === 'ACCEPT';
    const retaking = assessment?.decision === 'RETAKE';
    editPhotosButton.textContent = t(retaking ? 'capture.retakePhotos' : 'capture.editPhotos');
    editPhotosButton.hidden = busy;
    requestLocationButton.hidden = !!assessment || busy;
    requestLocationButton.disabled = busy || retryIsBlocked();
    analyzeButton.hidden = !!assessment || busy;
    analyzeButton.disabled = busy || !locationBinding || retryIsBlocked();
    analyzeButton.textContent = t(failureStep === 'upload' ? 'capture.retryUpload' : 'capture.analyzePhotos');
    retryButton.hidden = busy || retryAction === null || !!accepting || !!retaking;
    retryButton.disabled = busy || retryIsBlocked();
    publishButton.hidden = !accepting || busy;
    publishButton.textContent = t(retryAction === 'publication' ? 'capture.retryPublish' : 'capture.publishReport');
    publishButton.disabled = busy || description.value.trim().length === 0
      || (retryAction === 'publication' && retryIsBlocked());
    description.disabled = busy;
    discardButton.disabled = busy;
  }

  function setBusy(nextBusy: boolean, statusKey?: MessageKey, values?: MessageValues): void {
    busy = nextBusy;
    analysisStatus.setAttribute('aria-busy', String(busy));
    if (statusKey) analysisStatus.textContent = t(statusKey, values);
    updateActions();
  }

  function resetHandoff(): void {
    flowGeneration += 1;
    locationGeneration += 1;
    uploads = photos.map(() => ({}));
    locationBinding = null;
    assessment = null;
    activeAnalysisId = null;
    lastAcceptedAnalysisId = null;
    retryAction = null;
    failureStep = null;
    analysisOperation.complete();
    publishOperation.complete();
    assessmentPanel.hidden = true;
    acceptedPreview.hidden = true;
    safetyGuidance.hidden = true;
    retryGuidanceReset();
    description.value = '';
    requestLocationButton.textContent = t('capture.getLocation');
    setLocationMessage('capture.locationNotRequested');
    analysisStatus.textContent = '';
    setBusy(false);
  }

  function retryGuidanceReset(): void {
    assessmentReason.textContent = '';
    retakeGuidance.textContent = '';
  }

  function open(nextPhotos: readonly CapturedPhoto[]): void {
    if (disposed) return;
    photos = [...nextPhotos];
    resetHandoff();
    heading.textContent = t('capture.handoffHeading');
    message.textContent = t('capture.reportHandoffMessage', { count: photos.length });
    photoCount.textContent = t('capture.photoCount', { count: photos.length });
    photoList.replaceChildren();
    photos.forEach((photo, index) => {
      const item = makeElement('li', 'photo-capture-item');
      const preview = makeElement('img', 'photo-capture-preview');
      preview.src = photo.previewUrl;
      preview.alt = t('capture.photoAlt', { index: index + 1 });
      preview.referrerPolicy = 'no-referrer';
      item.appendChild(preview);
      photoList.appendChild(item);
    });
    root.hidden = false;
    options.onVisibilityChange(true);
    if (retryIsBlocked()) analysisStatus.textContent = t('capture.retryWait');
    editPhotosButton.focus();
  }

  function close(): void {
    locationGeneration += 1;
    flowGeneration += 1;
    root.hidden = true;
    options.onVisibilityChange(false);
  }

  async function requestLocation(): Promise<void> {
    if (busy || retryIsBlocked()) return;
    const generation = ++locationGeneration;
    analysisOperation.complete();
    locationBinding = null;
    setLocationMessage('capture.locationRequesting');
    locationStatus.setAttribute('aria-busy', 'true');
    requestLocationButton.disabled = true;
    updateActions();
    try {
      const binding = await captureFreshReportLocation();
      if (generation !== locationGeneration || root.hidden) return;
      locationBinding = binding;
      requestLocationButton.textContent = t('capture.refreshLocation');
      setLocationMessage('capture.locationSuccessReport', { accuracy: Math.round(binding.location.accuracyM) });
    } catch (error) {
      if (generation !== locationGeneration || root.hidden) return;
      const reason = error instanceof LocationCaptureError ? error.reason : 'unavailable';
      const key: Record<LocationCaptureError['reason'], MessageKey> = {
        unsupported: 'capture.locationUnsupported',
        permission: 'capture.locationPermission',
        timeout: 'capture.locationTimeout',
        unavailable: 'capture.locationUnavailable',
        inaccurate: 'capture.locationInaccurate',
        stale: 'capture.locationStale',
        tooFar: 'capture.locationTooFar',
      };
      requestLocationButton.textContent = t('capture.retryLocation');
      setLocationMessage(key[reason]);
    } finally {
      if (generation === locationGeneration && !root.hidden) {
        requestLocationButton.disabled = false;
        updateActions();
      }
    }
  }

  async function uploadPhotos(generation: number): Promise<string[] | null> {
    for (let index = 0; index < photos.length; index += 1) {
      if (generation !== flowGeneration) return null;
      const state = uploads[index];
      if (state.photoId) continue;
      const photo = photos[index];
      setBusy(true, 'capture.uploadingPhoto', { current: index + 1, total: photos.length });
      if (!state.ticket) {
        const ticket = await api.request({
          path: '/uploads',
          method: 'POST',
          body: { purpose: 'REPORT', mimeType: photo.blob.type, byteSize: photo.blob.size, ordinal: index + 1 },
          bodySchema: UploadRequestSchema,
          responseSchema: UploadTicketSchema,
        });
        state.ticket = ticket.data;
      }
      try {
        const uploaded = await api.uploadPhoto(state.ticket, photo.blob);
        state.photoId = uploaded.data.photoId;
      } catch (error) {
        if (error instanceof ApiClientError && (error.status === 409 || error.status === 410)) {
          const replacement = await api.request({
            path: '/uploads',
            method: 'POST',
            body: { purpose: 'REPORT', mimeType: photo.blob.type, byteSize: photo.blob.size, ordinal: index + 1 },
            bodySchema: UploadRequestSchema,
            responseSchema: UploadTicketSchema,
          });
          state.ticket = replacement.data;
          const uploaded = await api.uploadPhoto(state.ticket, photo.blob);
          state.photoId = uploaded.data.photoId;
        } else throw error;
      }
    }
    return uploads.map((upload) => upload.photoId).filter((id): id is string => !!id);
  }

  async function readAnalysis(analysisId: string, generation: number): Promise<ReportAnalysis | null> {
    const deadline = Date.now() + analysisWaitLimitMs;
    let result: ReportAnalysis;
    do {
      if (generation !== flowGeneration) return null;
      result = (await api.request({
        path: `/ai/analyses/${analysisId}`,
        responseSchema: ReportAnalysisSchema,
      })).data;
      if (result.status !== 'RUNNING') return result;
      setBusy(true, 'capture.waitingAnalysis');
      if (Date.now() >= deadline) return result;
      await new Promise((resolve) => setTimeout(resolve, analysisPollIntervalMs));
    } while (generation === flowGeneration);
    return null;
  }

  function displayAssessment(result: ReportAnalysis): void {
    activeAnalysisId = null;
    analysisOperation.complete();
    retryAction = null;
    failureStep = null;
    lastAcceptedAnalysisId = result.status === 'READY' && result.result.decision === 'ACCEPT'
      ? result.analysisId
      : null;
    if (result.status === 'RUNNING') {
      activeAnalysisId = result.analysisId;
      setBusy(false, 'capture.analysisStillRunning');
      retryAction = 'status';
      retryButton.textContent = t('capture.checkAnalysis');
      retryButton.hidden = false;
      updateActions();
      return;
    }
    assessmentPanel.hidden = true;
    if (result.status === 'FAILED') {
      setBusy(false, errorMessageKey(result.error.code));
      retryAction = 'analysis';
      retryButton.textContent = t('capture.retryAnalysis');
      retryButton.hidden = false;
      updateActions();
      return;
    }
    assessment = result.result;
    assessmentPanel.hidden = false;
    if (assessment.decision === 'RETAKE') {
      acceptedPreview.hidden = true;
      assessmentReason.textContent = t('capture.retakeReason', { reason: assessment.reason });
      retakeGuidance.textContent = t('capture.retakeInstruction', { instruction: assessment.instruction });
      setBusy(false, 'capture.retakeRequired');
      updateActions();
      return;
    }
    acceptedPreview.hidden = false;
    assessmentReason.textContent = assessment.reason;
    routeValue.textContent = t(routeKey(assessment.route));
    description.value = assessment.description;
    safetyGuidance.hidden = assessment.hazardLevel === 'NONE';
    safetyGuidance.textContent = assessment.safetyMessage;
    setBusy(false, 'capture.reviewAccepted');
    updateActions();
    description.focus();
  }

  async function analyzePhotos(): Promise<void> {
    if (!locationBinding || photos.length < 1 || busy || retryIsBlocked()) return;
    const generation = ++flowGeneration;
    retryAction = null;
    failureStep = activeAnalysisId ? 'analysis' : 'upload';
    setBusy(true, 'capture.uploadStarting');
    try {
      const photoIds = await uploadPhotos(generation);
      if (!photoIds || generation !== flowGeneration) return;
      let result: ReportAnalysis;
      if (activeAnalysisId) {
        failureStep = 'analysis';
        result = await readAnalysis(activeAnalysisId, generation) as ReportAnalysis;
      } else {
        failureStep = 'analysis';
        setBusy(true, 'capture.analyzing');
        result = (await api.request({
          path: '/ai/analyze-report',
          method: 'POST',
          body: {
            photoIds,
            comment: '',
            measuredLocation: locationBinding.location as Location,
            pin: locationBinding.pin as Point,
            cityId: 'heilbronn',
            outputLocale: options.locale,
          },
          bodySchema: ReportAnalysisRequestSchema,
          responseSchema: ReportAnalysisSchema,
          operation: analysisOperation,
          acceptedStatuses: [200, 202],
        })).data;
      }
      if (generation !== flowGeneration || disposed || root.hidden) return;
      if (result.status === 'RUNNING') {
        activeAnalysisId = result.analysisId;
        const polled = await readAnalysis(result.analysisId, generation);
        if (!polled || generation !== flowGeneration || disposed || root.hidden) return;
        result = polled;
      }
      displayAssessment(result);
    } catch (error) {
      if (generation !== flowGeneration || disposed || root.hidden) return;
      const code = errorCode(error);
      if (code && code !== 'INVALID_RESPONSE' && isLocationRecoveryError(code)) {
        locationBinding = null;
        setLocationMessage(errorMessageKey(code));
        locationGeneration += 1;
      }
      if (error instanceof ApiClientError && !error.retryable) analysisOperation.complete();
      setBusy(false, code ? errorMessageKey(code) : 'error.generic');
      if (failureStep === 'upload') {
        retryAction = null;
      } else {
        retryAction = 'analysis';
        retryButton.textContent = t('capture.retryAnalysis');
      }
      deferRetry(error);
      updateActions();
    }
  }

  async function publishReport(): Promise<void> {
    if (!assessment || assessment.decision !== 'ACCEPT' || !lastAcceptedAnalysisId || busy
      || retryIsBlocked()) return;
    const generation = ++flowGeneration;
    retryAction = null;
    setBusy(true, 'capture.publishing');
    let result: ApiResult<PublicationReceipt>;
    try {
      result = await api.request({
        path: '/reports',
        method: 'POST',
        body: { analysisId: lastAcceptedAnalysisId, description: description.value.trim() },
        bodySchema: PublishRequestSchema,
        responseSchema: PublicationReceiptSchema,
        operation: publishOperation,
        acceptedStatuses: [200, 201],
      });
    } catch (error) {
      if (generation !== flowGeneration || disposed || root.hidden) return;
      const code = errorCode(error);
      if (error instanceof ApiClientError && !error.retryable) publishOperation.complete();
      retryAction = error instanceof ApiClientError && error.retryable ? 'publication' : null;
      setBusy(false, code ? errorMessageKey(code) : 'error.generic');
      deferRetry(error);
      updateActions();
      return;
    }
    if (generation !== flowGeneration || disposed || root.hidden) return;
    publishOperation.complete();
    close();
    options.onPublished(result);
  }

  requestLocationButton.addEventListener('click', () => { void requestLocation(); });
  analyzeButton.addEventListener('click', () => { void analyzePhotos(); });
  retryButton.addEventListener('click', () => {
    if (busy || retryIsBlocked()) return;
    retryButton.hidden = true;
    if (assessment?.decision === 'ACCEPT') void publishReport();
    else void analyzePhotos();
  });
  publishButton.addEventListener('click', () => { void publishReport(); });
  description.addEventListener('input', () => {
    if (retryAction === 'publication') publishOperation.complete();
    updateActions();
  });
  editPhotosButton.addEventListener('click', () => {
    if (busy) return;
    close();
    options.onEditPhotos();
  });
  discardButton.addEventListener('click', () => {
    if (busy) return;
    close();
    options.onDiscard();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) editPhotosButton.click();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement | HTMLInputElement>(
      'button:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), input:not([disabled]):not([hidden])',
    )].filter((element) => !element.closest('[hidden]'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });

  function appendElements(parent: HTMLElement, ...elements: HTMLElement[]): void {
    elements.forEach((element) => parent.appendChild(element));
  }

  return {
    element: root,
    open,
    dispose() {
      if (disposed) return;
      disposed = true;
      close();
      clearRetryDelay();
      photoList.replaceChildren();
    },
  };
}
