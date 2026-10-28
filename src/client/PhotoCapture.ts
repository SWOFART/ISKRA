import { POLICY } from '../shared/contracts';
import type { MessageKey, MessageValues } from './i18n';

type Translate = (key: MessageKey, values?: MessageValues) => string;
export type CaptureStage = 'report' | 'cleanup';
export type CameraFailure = 'unsupported' | 'permission' | 'unavailable' | 'capture' | 'tooLarge';
export type CapturePhase = 'idle' | 'requesting' | 'ready' | 'error' | 'complete' | 'closed';

export interface CapturedPhoto {
  id: string;
  blob: Blob;
  previewUrl: string;
}

export interface PhotoCaptureRuntime {
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'> | null;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* Continue stopping the remaining tracks. */ }
  }
}

function cameraFailure(error: unknown): CameraFailure {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String(error.name)
    : '';
  return ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(name)
    ? 'permission'
    : 'unavailable';
}

/** In-memory capture state. It never writes photo bytes or metadata to persistent storage. */
export class PhotoCaptureSession {
  private phaseValue: CapturePhase = 'idle';
  private failureValue: CameraFailure | null = null;
  private streamValue: MediaStream | null = null;
  private photosValue: CapturedPhoto[] = [];
  private exitConfirmationValue = false;
  private requestGeneration = 0;
  private nextPhotoId = 0;
  private disposed = false;

  constructor(private readonly runtime: PhotoCaptureRuntime = {}) {}

  get phase(): CapturePhase { return this.phaseValue; }
  get failure(): CameraFailure | null { return this.failureValue; }
  get stream(): MediaStream | null { return this.streamValue; }
  get photos(): readonly CapturedPhoto[] { return this.photosValue; }
  get exitConfirmation(): boolean { return this.exitConfirmationValue; }
  get canCapture(): boolean { return this.phaseValue === 'ready' && this.photosValue.length < 5; }
  get canContinue(): boolean {
    return this.photosValue.length >= 1 && this.photosValue.length <= 5
      && this.phaseValue !== 'requesting' && this.phaseValue !== 'closed';
  }

  async requestCamera(): Promise<void> {
    if (this.disposed || ['requesting', 'ready', 'closed'].includes(this.phaseValue)) return;
    const mediaDevices = this.runtime.mediaDevices === undefined
      ? (typeof navigator === 'undefined' ? undefined : navigator.mediaDevices)
      : this.runtime.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      this.phaseValue = 'error';
      this.failureValue = 'unsupported';
      return;
    }

    const generation = ++this.requestGeneration;
    this.phaseValue = 'requesting';
    this.failureValue = null;
    try {
      const stream = await mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      });
      if (this.disposed || generation !== this.requestGeneration) {
        stopStream(stream);
        return;
      }
      this.streamValue = stream;
      this.phaseValue = 'ready';
    } catch (error) {
      if (this.disposed || generation !== this.requestGeneration) return;
      this.phaseValue = 'error';
      this.failureValue = cameraFailure(error);
    }
  }

  addPhoto(blob: Blob): boolean {
    if (!this.canCapture) return false;
    if (blob.type !== 'image/jpeg' || blob.size <= 0) {
      this.failCamera('capture');
      return false;
    }
    if (blob.size > POLICY.maxPhotoBytes) {
      this.failCamera('tooLarge');
      return false;
    }
    try {
      const createObjectURL = this.runtime.createObjectURL ?? URL.createObjectURL.bind(URL);
      this.photosValue = [...this.photosValue, {
        id: `capture-${++this.nextPhotoId}`,
        blob,
        previewUrl: createObjectURL(blob),
      }];
      this.failureValue = null;
      return true;
    } catch {
      this.failCamera('capture');
      return false;
    }
  }

  removePhoto(photoId: string): boolean {
    const photo = this.photosValue.find(({ id }) => id === photoId);
    if (!photo) return false;
    this.revoke(photo.previewUrl);
    this.photosValue = this.photosValue.filter(({ id }) => id !== photoId);
    if (this.phaseValue === 'complete') this.phaseValue = 'idle';
    return true;
  }

  async retakePhoto(photoId: string): Promise<void> {
    this.removePhoto(photoId);
    if (!this.streamValue) {
      if (this.phaseValue === 'error') this.phaseValue = 'idle';
      await this.requestCamera();
    }
  }

  failCamera(failure: CameraFailure): void {
    this.stopCamera();
    this.phaseValue = 'error';
    this.failureValue = failure;
  }

  stopCamera(): void {
    this.requestGeneration += 1;
    const stream = this.streamValue;
    this.streamValue = null;
    if (stream) stopStream(stream);
    if (this.phaseValue === 'ready' || this.phaseValue === 'requesting') this.phaseValue = 'idle';
  }

  requestExit(): void { this.exitConfirmationValue = true; }
  continueCreating(): void { this.exitConfirmationValue = false; }

  discardAndExit(): void {
    this.continueCreating();
    this.stopCamera();
    for (const photo of this.photosValue) this.revoke(photo.previewUrl);
    this.photosValue = [];
    this.failureValue = null;
    this.phaseValue = 'closed';
  }

  continueWithPhotos(): readonly CapturedPhoto[] | null {
    if (!this.canContinue) return null;
    this.continueCreating();
    this.stopCamera();
    this.phaseValue = 'complete';
    return [...this.photosValue];
  }

  reopen(): void {
    if (this.disposed || this.phaseValue !== 'closed') return;
    this.phaseValue = 'idle';
    this.failureValue = null;
    this.exitConfirmationValue = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.discardAndExit();
    this.disposed = true;
  }

  private revoke(url: string): void {
    const revokeObjectURL = this.runtime.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
    try { revokeObjectURL(url); } catch { /* Revocation is best effort during teardown. */ }
  }
}

export interface PhotoCaptureOptions {
  t: Translate;
  runtime?: PhotoCaptureRuntime;
  onContinue(photos: readonly CapturedPhoto[], stage: CaptureStage): void;
  onExit(): void;
  onVisibilityChange(open: boolean): void;
}

export interface PhotoCaptureView {
  element: HTMLElement;
  open(stage: CaptureStage): void;
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

async function encodeCameraFrame(video: HTMLVideoElement): Promise<Blob> {
  if (video.videoWidth < 1 || video.videoHeight < 1) throw new Error('Camera frame is not ready.');
  const canvas = document.createElement('canvas');
  const initialScale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
  let width = Math.max(1, Math.round(video.videoWidth * initialScale));
  let height = Math.max(1, Math.round(video.videoHeight * initialScale));
  const qualities = [0.84, 0.76, 0.68, 0.60, 0.52, 0.44, 0.36];

  for (const quality of qualities) {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Camera frame cannot be encoded.');
    context.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size > 0 && blob.size <= POLICY.maxPhotoBytes && blob.type === 'image/jpeg') return blob;
    width = Math.max(1, Math.round(width * 0.82));
    height = Math.max(1, Math.round(height * 0.82));
  }
  throw new Error('Camera frame is larger than the supported photo size.');
}

function failureKey(failure: CameraFailure): MessageKey {
  switch (failure) {
    case 'unsupported': return 'capture.cameraUnsupported';
    case 'permission': return 'capture.cameraPermission';
    case 'unavailable': return 'capture.cameraUnavailable';
    case 'capture': return 'capture.frameFailed';
    case 'tooLarge': return 'capture.photoTooLarge';
  }
}

export function renderPhotoCapture(options: PhotoCaptureOptions): PhotoCaptureView {
  const session = new PhotoCaptureSession(options.runtime);
  let stage: CaptureStage = 'report';
  let disposed = false;

  const root = makeElement('div', 'photo-capture-layer');
  root.hidden = true;
  const backdrop = makeElement('button', 'photo-capture-backdrop');
  backdrop.type = 'button';
  backdrop.setAttribute('aria-label', options.t('capture.exit'));
  const dialog = makeElement('section', 'photo-capture-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const heading = makeElement('h2', 'photo-capture-heading');
  heading.id = 'photo-capture-heading';
  dialog.setAttribute('aria-labelledby', heading.id);

  const closeButton = makeButton(options.t('capture.exit'), 'photo-capture-close');
  const header = makeElement('header', 'photo-capture-header');
  appendElements(header, heading, closeButton);

  const workspace = makeElement('div', 'photo-capture-workspace');
  const instructions = makeElement('p', 'photo-capture-instructions');
  const video = makeElement('video', 'photo-capture-video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('aria-label', options.t('capture.cameraPreview'));
  const status = makeElement('p', 'photo-capture-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const cameraControls = makeElement('div', 'photo-capture-camera-controls');
  const retryButton = makeButton(options.t('capture.retryCamera'), 'photo-capture-retry');
  const captureButton = makeButton(options.t('capture.takePhoto'), 'photo-capture-shutter');
  appendElements(cameraControls, retryButton, captureButton);

  const photoCount = makeElement('p', 'photo-capture-count');
  const photoList = makeElement('ol', 'photo-capture-list');
  const continueButton = makeButton(options.t('capture.continue'), 'photo-capture-continue');
  appendElements(workspace, instructions, video, status, cameraControls, photoCount, photoList, continueButton);

  const exitPrompt = makeElement('div', 'photo-capture-exit-prompt');
  exitPrompt.hidden = true;
  const exitHeading = makeElement('h3', 'photo-capture-exit-heading', options.t('capture.exitHeading'));
  exitHeading.id = 'photo-capture-exit-heading';
  const exitMessage = makeElement('p', 'photo-capture-exit-message', options.t('capture.exitMessage'));
  const continueCreatingButton = makeButton(options.t('capture.continueCreating'), 'photo-capture-keep');
  const discardButton = makeButton(options.t('capture.discardExit'), 'photo-capture-discard');
  appendElements(exitPrompt, exitHeading, exitMessage, continueCreatingButton, discardButton);
  appendElements(dialog, header, workspace, exitPrompt);
  appendElements(root, backdrop, dialog);

  function clearVideo(): void {
    if (!session.stream && video.srcObject) {
      video.pause();
      video.srcObject = null;
    }
  }

  function bindVideo(): void {
    const stream = session.stream;
    if (!stream || video.srcObject === stream) return;
    video.srcObject = stream;
    void video.play().catch(() => {
      video.srcObject = null;
      session.failCamera('unavailable');
      render();
    });
  }

  function renderPhotos(): void {
    photoList.replaceChildren();
    session.photos.forEach((photo, index) => {
      const item = makeElement('li', 'photo-capture-item');
      const preview = makeElement('img', 'photo-capture-preview');
      preview.src = photo.previewUrl;
      preview.alt = options.t('capture.photoAlt', { index: index + 1 });
      preview.referrerPolicy = 'no-referrer';
      const actions = makeElement('div', 'photo-capture-photo-actions');
      const retake = makeButton(options.t('capture.retakePhoto', { index: index + 1 }), 'photo-capture-retake');
      retake.addEventListener('click', () => {
        const retakeTask = session.retakePhoto(photo.id);
        render();
        void retakeTask.then(() => { render(); captureButton.focus(); });
      });
      const remove = makeButton(options.t('capture.deletePhoto', { index: index + 1 }), 'photo-capture-delete');
      remove.addEventListener('click', () => { session.removePhoto(photo.id); render(); captureButton.focus(); });
      appendElements(actions, retake, remove);
      appendElements(item, preview, actions);
      photoList.appendChild(item);
    });
  }

  function render(): void {
    if (disposed) return;
    bindVideo();
    clearVideo();
    heading.textContent = options.t(stage === 'report' ? 'capture.reportHeading' : 'capture.cleanupHeading');
    instructions.textContent = options.t(stage === 'report' ? 'capture.reportInstructions' : 'capture.cleanupInstructions');
    photoCount.textContent = options.t('capture.photoCount', { count: session.photos.length });
    video.hidden = session.phase !== 'ready';
    retryButton.hidden = !['idle', 'error'].includes(session.phase);
    retryButton.disabled = false;
    if (session.phase === 'requesting') status.textContent = options.t('capture.cameraStarting');
    else if (session.failure) status.textContent = options.t(failureKey(session.failure));
    else if (session.phase === 'ready') status.textContent = options.t('capture.cameraReady');
    else if (session.phase === 'complete') status.textContent = options.t('capture.nextStepPending');
    else status.textContent = '';

    captureButton.hidden = session.phase !== 'ready';
    captureButton.disabled = !session.canCapture;
    const captureLabel = options.t(session.photos.length >= 5 ? 'capture.maxPhotos' : 'capture.takePhoto');
    captureButton.textContent = captureLabel;
    captureButton.setAttribute('aria-label', captureLabel);
    continueButton.hidden = session.phase === 'complete';
    continueButton.disabled = !session.canContinue;
    photoList.setAttribute('aria-label', options.t('capture.photoList'));
    renderPhotos();

    const confirmingExit = session.exitConfirmation;
    dialog.setAttribute('role', confirmingExit ? 'alertdialog' : 'dialog');
    dialog.setAttribute('aria-labelledby', confirmingExit ? exitHeading.id : heading.id);
    workspace.hidden = confirmingExit;
    workspace.inert = confirmingExit;
    exitPrompt.hidden = !confirmingExit;
    if (confirmingExit) continueCreatingButton.focus();
  }

  function open(nextStage: CaptureStage): void {
    if (disposed || !root.hidden) return;
    if (session.phase === 'closed') session.reopen();
    stage = nextStage;
    root.hidden = false;
    options.onVisibilityChange(true);
    render();
    closeButton.focus();
    const cameraRequest = session.requestCamera();
    render();
    void cameraRequest.then(render);
  }

  function askToExit(): void {
    session.requestExit();
    render();
  }

  function focusableElements(): HTMLButtonElement[] {
    return Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
      .filter((button) => !button.hidden && !button.closest('[hidden]') && !button.closest('[inert]'));
  }

  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (session.exitConfirmation) {
        session.continueCreating();
        render();
        closeButton.focus();
      } else askToExit();
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

  closeButton.addEventListener('click', askToExit);
  backdrop.addEventListener('click', askToExit);
  continueCreatingButton.addEventListener('click', () => {
    session.continueCreating();
    render();
    closeButton.focus();
  });
  discardButton.addEventListener('click', () => {
    session.discardAndExit();
    clearVideo();
    root.hidden = true;
    options.onVisibilityChange(false);
    options.onExit();
  });
  retryButton.addEventListener('click', () => {
    retryButton.disabled = true;
    const cameraRequest = session.requestCamera();
    render();
    void cameraRequest.then(render);
  });
  captureButton.addEventListener('click', () => {
    captureButton.disabled = true;
    void encodeCameraFrame(video).then((blob) => {
      if (!session.addPhoto(blob)) status.textContent = options.t('capture.frameFailed');
    }).catch(() => session.failCamera('capture')).finally(render);
  });
  continueButton.addEventListener('click', () => {
    const photos = session.continueWithPhotos();
    if (!photos) return;
    clearVideo();
    options.onContinue(photos, stage);
    render();
  });

  return {
    element: root,
    open,
    dispose() {
      if (disposed) return;
      disposed = true;
      session.dispose();
      clearVideo();
      root.hidden = true;
      options.onVisibilityChange(false);
      root.parentNode?.removeChild(root);
    },
  };
}
