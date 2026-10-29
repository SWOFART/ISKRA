import {
  CleanupAnalysisRequestSchema,
  CleanupAnalysisSchema,
  CleanupReceiptSchema,
  CleanupRequestSchema,
  POLICY,
  UploadRequestSchema,
  UploadTicketSchema,
  type CleanupAnalysis,
  type ErrorCode,
  type Point,
} from '../shared/contracts';
import type { Infer } from '../shared/schema';
import { ApiClientError, type createClientApi, type ApiResult } from './api';
import { createOperationKeyScope } from './operationKey';
import {
  captureFreshCleanupLocation,
  LocationCaptureError,
  type CleanupLocationBinding,
} from './locationCapture';
import { errorMessageKey, type MessageKey, type MessageValues } from './i18n';
import type { SupportedLocale } from './designTokens';
import type { CapturedPhoto } from './PhotoCapture';

type ClientApi = ReturnType<typeof createClientApi>;
type Translate = (key: MessageKey, values?: MessageValues) => string;
type CleanupAssessment = Extract<CleanupAnalysis, { status: 'READY' }>['result'];
type CleanupReceipt = Infer<typeof CleanupReceiptSchema>;
type UploadTicket = Infer<typeof UploadTicketSchema>;
type UploadState = { ticket?: UploadTicket; photoId?: string };

const analysisPollIntervalMs = 750;
const analysisWaitLimitMs = 90_000;
const maximumRetryTimerMs = 2_147_483_647;

let cleanupRetryAvailableAt = 0;
let cleanupRetryTimer: ReturnType<typeof setTimeout> | undefined;
const cleanupRetryListeners = new Set<() => void>();

function cleanupRetryIsBlocked(): boolean {
  return cleanupRetryAvailableAt > Date.now();
}

function notifyCleanupRetryListeners(): void {
  cleanupRetryListeners.forEach((listener) => listener());
}

function scheduleCleanupRetryExpiry(): void {
  const remainingMs = cleanupRetryAvailableAt - Date.now();
  if (remainingMs > 0) {
    cleanupRetryTimer = setTimeout(scheduleCleanupRetryExpiry, Math.min(remainingMs, maximumRetryTimerMs));
    return;
  }
  cleanupRetryTimer = undefined;
  cleanupRetryAvailableAt = 0;
  notifyCleanupRetryListeners();
}

function deferCleanupRetry(delayMs: number): void {
  cleanupRetryAvailableAt = Math.max(cleanupRetryAvailableAt, Date.now() + delayMs);
  if (cleanupRetryTimer !== undefined) clearTimeout(cleanupRetryTimer);
  notifyCleanupRetryListeners();
  cleanupRetryTimer = setTimeout(
    scheduleCleanupRetryExpiry,
    Math.min(cleanupRetryAvailableAt - Date.now(), maximumRetryTimerMs),
  );
}

function subscribeToCleanupRetry(listener: () => void): () => void {
  cleanupRetryListeners.add(listener);
  return () => cleanupRetryListeners.delete(listener);
}

export interface CleanupTarget {
  id: string;
  location: Point;
}

export interface CleanupSubmissionOptions {
  api: ClientApi;
  t: Translate;
  locale: SupportedLocale;
  onEditPhotos(): void;
  onDiscard(): void;
  onOpenImpact(): void;
  onCommitted(result: ApiResult<CleanupReceipt>): void;
  onVisibilityChange(open: boolean): void;
}

export interface CleanupSubmissionView {
  element: HTMLElement;
  open(photos: readonly CapturedPhoto[], report: CleanupTarget): void;
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

function errorCode(error: unknown): ErrorCode | 'INVALID_RESPONSE' | undefined {
  return error instanceof ApiClientError ? error.code : undefined;
}

function appendChildren(parent: HTMLElement, ...children: HTMLElement[]): void {
  children.forEach((child) => parent.appendChild(child));
}

export function renderCleanupSubmission(options: CleanupSubmissionOptions): CleanupSubmissionView {
  const { api, t } = options;
  const root = makeElement('section', 'photo-capture-handoff');
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  const card = makeElement('div', 'photo-capture-handoff-card');
  const heading = makeElement('h2', 'photo-capture-handoff-heading');
  heading.id = 'cleanup-submission-heading';
  root.setAttribute('aria-labelledby', heading.id);
  const message = makeElement('p', 'photo-capture-handoff-message');
  const independent = makeElement('p', 'report-cleanup-note');
  const photoCount = makeElement('p', 'photo-capture-count');
  const photoList = makeElement('ol', 'photo-capture-list photo-capture-handoff-list');
  photoList.setAttribute('aria-label', t('capture.photoList'));
  const locationStatus = makeElement('p', 'photo-capture-location-status');
  locationStatus.setAttribute('role', 'status');
  locationStatus.setAttribute('aria-live', 'polite');
  const analysisStatus = makeElement('p', 'report-analysis-status');
  analysisStatus.setAttribute('role', 'status');
  analysisStatus.setAttribute('aria-live', 'polite');
  analysisStatus.setAttribute('aria-busy', 'false');
  const assessmentPanel = makeElement('section', 'report-assessment');
  assessmentPanel.hidden = true;
  const assessmentReason = makeElement('p', 'report-assessment-reason');
  const retakeGuidance = makeElement('p', 'report-retake-guidance');
  retakeGuidance.setAttribute('role', 'status');
  const acceptedPreview = makeElement('p', 'report-accepted-preview');
  acceptedPreview.hidden = true;
  const actions = makeElement('div', 'photo-capture-handoff-actions');
  const editPhotosButton = makeButton(t('capture.editPhotos'), 'photo-capture-edit');
  const requestLocationButton = makeButton(t('capture.getLocation'), 'photo-capture-location');
  const analyzeButton = makeButton(t('capture.analyzePhotos'), 'photo-capture-continue');
  const retryButton = makeButton(t('capture.retryAnalysis'), 'photo-capture-continue');
  retryButton.hidden = true;
  const sendButton = makeButton(t('capture.cleanupSend'), 'photo-capture-continue');
  sendButton.hidden = true;
  const impactButton = makeButton(t('capture.cleanupImpact'), 'photo-capture-edit');
  impactButton.hidden = true;
  const closeButton = makeButton(t('capture.cleanupClose'), 'photo-capture-discard');
  closeButton.hidden = true;
  const discardButton = makeButton(t('capture.discardSession'), 'photo-capture-discard');
  appendChildren(
    actions, editPhotosButton, requestLocationButton, analyzeButton, retryButton,
    sendButton, impactButton, closeButton, discardButton,
  );
  appendChildren(assessmentPanel, assessmentReason, retakeGuidance, acceptedPreview);
  appendChildren(
    card, heading, message, independent, photoCount, photoList, locationStatus, analysisStatus, assessmentPanel, actions,
  );
  root.appendChild(card);

  let disposed = false;
  let busy = false;
  let photos: CapturedPhoto[] = [];
  let uploads: UploadState[] = [];
  let report: CleanupTarget | null = null;
  let locationBinding: CleanupLocationBinding | null = null;
  let assessment: CleanupAssessment | null = null;
  let activeAnalysisId: string | null = null;
  let acceptedAnalysisId: string | null = null;
  let receipt: CleanupReceipt | null = null;
  let lost = false;
  let retryAction: 'analysis' | 'submission' | 'status' | null = null;
  let failureStep: 'upload' | 'analysis' | null = null;
  let locationGeneration = 0;
  let flowGeneration = 0;
  let retryFailureMessage: { text: string; flowGeneration: number } | null = null;
  const analysisOperation = createOperationKeyScope();
  const submissionOperation = createOperationKeyScope();

  function deferRetry(error: unknown): void {
    const delayMs = error instanceof ApiClientError && error.retryable ? error.retryAfterMs : undefined;
    if (!delayMs || delayMs <= 0) return;
    retryFailureMessage = { text: analysisStatus.textContent, flowGeneration };
    deferCleanupRetry(delayMs);
  }

  function setLocationMessage(key: MessageKey, values?: MessageValues): void {
    locationStatus.textContent = t(key, values);
    locationStatus.setAttribute('aria-busy', 'false');
  }

  function updateActions(): void {
    const accepting = assessment?.decision === 'ACCEPT' && !lost && !receipt;
    const retaking = assessment?.decision === 'RETAKE';
    const finished = receipt !== null || lost;
    editPhotosButton.textContent = t(retaking ? 'capture.retakePhotos' : 'capture.editPhotos');
    editPhotosButton.hidden = busy || finished;
    requestLocationButton.hidden = !!assessment || busy || finished;
    requestLocationButton.disabled = busy || cleanupRetryIsBlocked();
    analyzeButton.hidden = !!assessment || busy || finished;
    analyzeButton.disabled = busy || !locationBinding || cleanupRetryIsBlocked();
    analyzeButton.textContent = t(failureStep === 'upload' ? 'capture.retryUpload' : 'capture.analyzePhotos');
    retryButton.hidden = busy || retryAction === null || retaking || finished || !!accepting;
    retryButton.disabled = busy || cleanupRetryIsBlocked();
    sendButton.hidden = !accepting || busy;
    sendButton.disabled = busy || cleanupRetryIsBlocked();
    sendButton.textContent = t(retryAction === 'submission' ? 'capture.cleanupRetrySend' : 'capture.cleanupSend');
    impactButton.hidden = !receipt;
    closeButton.hidden = !finished;
    discardButton.hidden = finished;
    discardButton.disabled = busy;
    independent.textContent = t('capture.cleanupIndependent');
  }

  function syncRetryState(): void {
    updateActions();
    if (root.hidden) return;
    if (cleanupRetryIsBlocked()) {
      analysisStatus.textContent = t('capture.retryWait');
      return;
    }
    if (analysisStatus.textContent === t('capture.retryWait')) {
      analysisStatus.textContent = retryFailureMessage?.flowGeneration === flowGeneration
        ? retryFailureMessage.text
        : '';
    }
    retryFailureMessage = null;
  }

  function setBusy(nextBusy: boolean, statusKey?: MessageKey, values?: MessageValues): void {
    busy = nextBusy;
    analysisStatus.setAttribute('aria-busy', String(busy));
    if (statusKey) analysisStatus.textContent = t(statusKey, values);
    updateActions();
  }

  function resetFlow(): void {
    flowGeneration += 1;
    locationGeneration += 1;
    uploads = photos.map(() => ({}));
    locationBinding = null;
    assessment = null;
    activeAnalysisId = null;
    acceptedAnalysisId = null;
    receipt = null;
    lost = false;
    retryAction = null;
    failureStep = null;
    analysisOperation.complete();
    submissionOperation.complete();
    assessmentPanel.hidden = true;
    acceptedPreview.hidden = true;
    assessmentReason.textContent = '';
    retakeGuidance.textContent = '';
    requestLocationButton.textContent = t('capture.getLocation');
    setLocationMessage('capture.locationNotRequested');
    analysisStatus.textContent = '';
    setBusy(false);
  }

  function open(nextPhotos: readonly CapturedPhoto[], nextReport: CleanupTarget): void {
    if (disposed) return;
    photos = [...nextPhotos];
    report = nextReport;
    resetFlow();
    heading.textContent = t('capture.handoffHeading');
    message.textContent = t('capture.cleanupHandoffMessage', { count: photos.length });
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
    syncRetryState();
    editPhotosButton.focus();
  }

  function close(): void {
    locationGeneration += 1;
    flowGeneration += 1;
    root.hidden = true;
    options.onVisibilityChange(false);
  }

  async function requestLocation(): Promise<void> {
    if (!report || busy || cleanupRetryIsBlocked()) return;
    const generation = ++locationGeneration;
    analysisOperation.complete();
    locationBinding = null;
    setLocationMessage('capture.locationRequesting');
    locationStatus.setAttribute('aria-busy', 'true');
    requestLocationButton.disabled = true;
    updateActions();
    try {
      const binding = await captureFreshCleanupLocation(report.location);
      if (generation !== locationGeneration || root.hidden) return;
      locationBinding = binding;
      requestLocationButton.textContent = t('capture.refreshLocation');
      setLocationMessage('capture.locationSuccessCleanup', {
        accuracy: Math.round(binding.location.accuracyM),
        distance: Math.round(binding.distanceM),
      });
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
    if (!report) return null;
    for (let index = 0; index < photos.length; index += 1) {
      if (generation !== flowGeneration) return null;
      const state = uploads[index];
      if (state.photoId) continue;
      const photo = photos[index];
      setBusy(true, 'capture.uploadingPhoto', { current: index + 1, total: photos.length });
      const ticketBody = {
        purpose: 'CLEANUP' as const,
        reportId: report.id,
        mimeType: photo.blob.type,
        byteSize: photo.blob.size,
        ordinal: index + 1,
      };
      if (!state.ticket) {
        const ticket = await api.request({
          path: '/uploads',
          method: 'POST',
          body: ticketBody,
          bodySchema: UploadRequestSchema,
          responseSchema: UploadTicketSchema,
          acceptedStatuses: [200, 201],
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
            body: ticketBody,
            bodySchema: UploadRequestSchema,
            responseSchema: UploadTicketSchema,
            acceptedStatuses: [200, 201],
          });
          state.ticket = replacement.data;
          const uploaded = await api.uploadPhoto(state.ticket, photo.blob);
          state.photoId = uploaded.data.photoId;
        } else throw error;
      }
    }
    return uploads.map((upload) => upload.photoId).filter((id): id is string => !!id);
  }

  async function readAnalysis(analysisId: string, generation: number): Promise<CleanupAnalysis | null> {
    const deadline = Date.now() + analysisWaitLimitMs;
    let result: CleanupAnalysis;
    do {
      if (generation !== flowGeneration) return null;
      result = (await api.request({
        path: `/ai/analyses/${analysisId}`,
        responseSchema: CleanupAnalysisSchema,
      })).data;
      if (result.status !== 'RUNNING') return result;
      setBusy(true, 'capture.waitingAnalysis');
      if (Date.now() >= deadline) return result;
      await new Promise((resolve) => setTimeout(resolve, analysisPollIntervalMs));
    } while (generation === flowGeneration);
    return null;
  }

  function displayAssessment(result: CleanupAnalysis): void {
    activeAnalysisId = null;
    analysisOperation.complete();
    retryAction = null;
    failureStep = null;
    acceptedAnalysisId = result.status === 'READY' && result.result.decision === 'ACCEPT' ? result.analysisId : null;
    if (result.status === 'RUNNING') {
      activeAnalysisId = result.analysisId;
      setBusy(false, 'capture.analysisStillRunning');
      retryAction = 'status';
      retryButton.textContent = t('capture.checkAnalysis');
      updateActions();
      return;
    }
    assessmentPanel.hidden = true;
    if (result.status === 'FAILED') {
      setBusy(false, errorMessageKey(result.error.code));
      retryAction = 'analysis';
      retryButton.textContent = t('capture.retryAnalysis');
      updateActions();
      return;
    }
    assessment = result.result;
    assessmentPanel.hidden = false;
    if (assessment.decision === 'RETAKE') {
      acceptedPreview.hidden = true;
      assessmentReason.textContent = t('capture.retakeReason', { reason: assessment.reason });
      retakeGuidance.textContent = t('capture.retakeInstruction', { instruction: assessment.instruction });
      setBusy(false, 'capture.cleanupRetakeRequired');
      updateActions();
      return;
    }
    acceptedPreview.hidden = false;
    acceptedPreview.textContent = t('capture.cleanupReview', {
      points: POLICY.cleanerRp,
      count: 0,
    });
    assessmentReason.textContent = assessment.reason;
    analysisStatus.textContent = '';
    setBusy(false);
    updateActions();
    sendButton.focus();
  }

  async function analyzePhotos(): Promise<void> {
    if (!report || !locationBinding || photos.length < 1 || busy || cleanupRetryIsBlocked()) return;
    const generation = ++flowGeneration;
    retryAction = null;
    failureStep = activeAnalysisId ? 'analysis' : 'upload';
    setBusy(true, 'capture.uploadStarting');
    try {
      const photoIds = await uploadPhotos(generation);
      if (!photoIds || generation !== flowGeneration) return;
      let result: CleanupAnalysis;
      if (activeAnalysisId) {
        failureStep = 'analysis';
        result = await readAnalysis(activeAnalysisId, generation) as CleanupAnalysis;
      } else {
        failureStep = 'analysis';
        setBusy(true, 'capture.analyzing');
        result = (await api.request({
          path: '/ai/analyze-cleanup',
          method: 'POST',
          body: {
            reportId: report.id,
            photoIds,
            location: locationBinding.location,
            outputLocale: options.locale,
          },
          bodySchema: CleanupAnalysisRequestSchema,
          responseSchema: CleanupAnalysisSchema,
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
      if (generation !== flowGeneration || disposed || root.hidden) {
        deferRetry(error);
        return;
      }
      const code = errorCode(error);
      const locationKey = code === 'TOO_FAR' ? 'capture.locationTooFar'
        : code === 'LOCATION_INACCURATE' ? 'capture.locationInaccurate'
          : code === 'LOCATION_STALE' ? 'capture.locationStale'
            : code === 'PIN_TOO_FAR' ? 'capture.locationPinRejected'
              : null;
      if (locationKey) {
        locationBinding = null;
        setLocationMessage(locationKey);
        locationGeneration += 1;
      }
      if (error instanceof ApiClientError && !error.retryable) analysisOperation.complete();
      setBusy(false, locationKey ?? (code ? errorMessageKey(code) : 'error.generic'));
      retryAction = failureStep === 'upload' ? null : 'analysis';
      deferRetry(error);
      updateActions();
    }
  }

  async function sendCleanup(): Promise<void> {
    if (!report || !acceptedAnalysisId || busy || cleanupRetryIsBlocked() || receipt || lost) return;
    const generation = ++flowGeneration;
    retryAction = null;
    setBusy(true, 'capture.cleanupSending');
    let result: ApiResult<CleanupReceipt>;
    try {
      result = await api.request({
        path: `/reports/${report.id}/cleanups`,
        method: 'POST',
        body: { analysisId: acceptedAnalysisId },
        bodySchema: CleanupRequestSchema,
        responseSchema: CleanupReceiptSchema,
        operation: submissionOperation,
        acceptedStatuses: [200, 201],
      });
    } catch (error) {
      if (generation !== flowGeneration || disposed || root.hidden) {
        deferRetry(error);
        return;
      }
      const code = errorCode(error);
      if (code === 'CLEANUP_ALREADY_SUBMITTED') {
        lost = true;
        submissionOperation.complete();
        setBusy(false, 'error.CLEANUP_ALREADY_SUBMITTED');
        return;
      }
      if (error instanceof ApiClientError && !error.retryable) submissionOperation.complete();
      retryAction = error instanceof ApiClientError && error.retryable ? 'submission' : null;
      setBusy(false, code ? errorMessageKey(code) : 'error.generic');
      deferRetry(error);
      updateActions();
      return;
    }
    if (generation !== flowGeneration || disposed || root.hidden) return;
    submissionOperation.complete();
    receipt = result.data;
    acceptedPreview.textContent = t('capture.cleanupAccepted', {
      points: result.data.provisionalRp,
      count: result.data.report.resolutionYesCount,
    });
    analysisStatus.textContent = '';
    setBusy(false);
    options.onCommitted(result);
    impactButton.focus();
  }

  requestLocationButton.addEventListener('click', () => { void requestLocation(); });
  analyzeButton.addEventListener('click', () => { void analyzePhotos(); });
  retryButton.addEventListener('click', () => {
    if (busy || cleanupRetryIsBlocked()) return;
    retryButton.hidden = true;
    void analyzePhotos();
  });
  sendButton.addEventListener('click', () => { void sendCleanup(); });
  impactButton.addEventListener('click', () => {
    close();
    options.onOpenImpact();
  });
  closeButton.addEventListener('click', () => {
    close();
    options.onDiscard();
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
      if (busy) return;
      if (receipt || lost) closeButton.click();
      else editPhotosButton.click();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
      .filter((element) => !element.hidden && !element.closest('[hidden]'));
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

  const unsubscribeRetryState = subscribeToCleanupRetry(syncRetryState);

  return {
    element: root,
    open,
    dispose() {
      if (disposed) return;
      disposed = true;
      close();
      unsubscribeRetryState();
      photoList.replaceChildren();
    },
  };
}
