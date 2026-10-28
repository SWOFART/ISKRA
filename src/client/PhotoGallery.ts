import type { Photo } from '../shared/contracts';
import type { MessageKey, MessageValues } from './i18n';

type Translate = (key: MessageKey, values?: MessageValues) => string;
let nextGalleryId = 0;

export interface PhotoGalleryOptions {
  title: string;
  photos: readonly Photo[];
  t: Translate;
  refreshPhotos(): Promise<readonly Photo[]>;
}

export interface PhotoGalleryView {
  element: HTMLElement;
  updatePhotos(photos: readonly Photo[]): void;
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

export function renderPhotoGallery(options: PhotoGalleryOptions): PhotoGalleryView {
  let photos = [...options.photos];
  let selectedIndex = 0;
  let autoRefreshAttempted = new Set<string>();
  let failedPhotoIds = new Set<string>();
  let pointerStart: number | null = null;
  let suppressOpenClick = false;
  let open = false;
  let disposed = false;
  let opener: HTMLButtonElement | null = null;

  const element = makeElement('section', 'photo-gallery');
  element.setAttribute('aria-label', options.title);
  const heading = makeElement('h3', 'photo-gallery-heading', options.title);
  const count = makeElement('span', 'photo-gallery-count');
  const header = makeElement('div', 'photo-gallery-header');
  appendElements(header, heading, count);

  const viewport = makeElement('div', 'photo-gallery-viewport');
  viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', options.title);
  const figure = makeElement('figure', 'photo-gallery-figure');
  const status = makeElement('p', 'photo-gallery-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  appendElements(viewport, figure, status);

  const controls = makeElement('div', 'photo-gallery-controls');
  const previousButton = makeButton(options.t('report.photoPrevious'), 'photo-gallery-previous');
  const position = makeElement('span', 'photo-gallery-position');
  const nextButton = makeButton(options.t('report.photoNext'), 'photo-gallery-next');
  appendElements(controls, previousButton, position, nextButton);

  const lightbox = makeElement('section', 'photo-lightbox');
  lightbox.hidden = true;
  lightbox.setAttribute('role', 'dialog');
  lightbox.setAttribute('aria-modal', 'true');
  const lightboxTitle = makeElement('h2', 'photo-lightbox-title');
  lightboxTitle.id = `photo-lightbox-title-${++nextGalleryId}`;
  lightbox.setAttribute('aria-labelledby', lightboxTitle.id);
  const backdrop = makeElement('div', 'photo-lightbox-backdrop');
  backdrop.setAttribute('aria-hidden', 'true');
  const lightboxClose = makeButton(options.t('report.photoCloseFullscreen'), 'photo-lightbox-close');
  const lightboxHeader = makeElement('header', 'photo-lightbox-header');
  appendElements(lightboxHeader, lightboxTitle, lightboxClose);
  const lightboxImage = makeElement('img', 'photo-lightbox-image');
  lightboxImage.referrerPolicy = 'no-referrer';
  lightboxImage.decoding = 'async';
  const lightboxControls = makeElement('div', 'photo-lightbox-controls');
  const lightboxPrevious = makeButton(options.t('report.photoPrevious'), 'photo-lightbox-previous');
  const lightboxPosition = makeElement('span', 'photo-lightbox-position');
  const lightboxNext = makeButton(options.t('report.photoNext'), 'photo-lightbox-next');
  appendElements(lightboxControls, lightboxPrevious, lightboxPosition, lightboxNext);
  appendElements(lightbox, backdrop, lightboxHeader, lightboxImage, lightboxControls);

  const refreshInFlight = new Map<string, Promise<void>>();

  function currentPhoto(): Photo | undefined {
    return photos[selectedIndex];
  }

  function photoPosition(): string {
    return options.t('report.photoPosition', { index: selectedIndex + 1, count: photos.length });
  }

  function updateNavigation(): void {
    const hasMany = photos.length > 1;
    count.textContent = options.t('report.photoCount', {
      count: photos.length,
      unit: options.t(photos.length === 1 ? 'report.photoSingular' : 'report.photoPlural'),
    });
    position.textContent = photos.length ? photoPosition() : '';
    previousButton.disabled = !hasMany || selectedIndex === 0;
    nextButton.disabled = !hasMany || selectedIndex >= photos.length - 1;
    previousButton.hidden = !hasMany;
    nextButton.hidden = !hasMany;
    lightboxPosition.textContent = photos.length ? photoPosition() : '';
    lightboxPrevious.disabled = !hasMany || selectedIndex === 0;
    lightboxNext.disabled = !hasMany || selectedIndex >= photos.length - 1;
    lightboxPrevious.hidden = !hasMany;
    lightboxNext.hidden = !hasMany;
    lightboxTitle.textContent = photos.length
      ? `${options.title} · ${photoPosition()}`
      : options.title;
  }

  function changeIndex(nextIndex: number): void {
    if (photos.length === 0) return;
    selectedIndex = Math.max(0, Math.min(photos.length - 1, nextIndex));
    render();
  }

  function showUnavailable(photo: Photo): void {
    failedPhotoIds.add(photo.id);
    render();
  }

  async function refreshFor(photo: Photo, manual = false): Promise<void> {
    const existing = refreshInFlight.get(photo.mediaUrl);
    if (existing) return existing;
    if (!manual && autoRefreshAttempted.has(photo.id)) {
      showUnavailable(photo);
      return;
    }
    autoRefreshAttempted.add(photo.id);
    status.textContent = options.t('report.photoRefreshing');

    const request = (async () => {
      try {
        const refreshed = await options.refreshPhotos();
        if (disposed) return;
        const currentId = currentPhoto()?.id;
        const previousExpiry = Date.parse(photo.expiresAt);
        const latest = refreshed.find(({ id }) => id === photo.id);
        const nextExpiry = latest ? Date.parse(latest.expiresAt) : Number.NaN;
        const renewed = latest && latest.mediaUrl !== photo.mediaUrl
          && Number.isFinite(nextExpiry) && nextExpiry > Date.now()
          || latest && nextExpiry > previousExpiry && nextExpiry > Date.now();
        if (!latest || !renewed) {
          failedPhotoIds.add(photo.id);
          return;
        }
        photos = [...refreshed];
        failedPhotoIds.delete(photo.id);
        const restoredIndex = photos.findIndex(({ id }) => id === currentId);
        if (restoredIndex >= 0) selectedIndex = restoredIndex;
      } catch {
        if (!disposed) failedPhotoIds.add(photo.id);
      } finally {
        refreshInFlight.delete(photo.mediaUrl);
        if (!disposed) render();
      }
    })();
    refreshInFlight.set(photo.mediaUrl, request);
    await request;
  }

  function renderPhoto(photo: Photo, image: HTMLImageElement): void {
    image.alt = `${options.title} · ${photoPosition()}`;
    image.onerror = () => { void refreshFor(photo); };
    image.src = photo.mediaUrl;
  }

  function render(): void {
    if (disposed) return;
    const photo = currentPhoto();
    figure.replaceChildren();
    status.textContent = '';
    if (!photo) {
      figure.appendChild(makeElement('p', 'photo-gallery-empty', options.t('report.photoEmpty')));
      updateNavigation();
      lightbox.hidden = true;
      open = false;
      return;
    }

    updateNavigation();
    if (failedPhotoIds.has(photo.id)) {
      figure.appendChild(makeElement('p', 'photo-gallery-placeholder', options.t('report.photoUnavailable')));
      status.textContent = options.t('report.photoUnavailable');
      const retry = makeButton(options.t('report.photoRetry'), 'photo-gallery-retry');
      retry.addEventListener('click', () => {
        failedPhotoIds.delete(photo.id);
        autoRefreshAttempted.delete(photo.id);
        void refreshFor(photo, true);
      });
      figure.appendChild(retry);
      return;
    }
    const expiry = Date.parse(photo.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      figure.appendChild(makeElement('p', 'photo-gallery-placeholder', options.t('report.photoRefreshing')));
      void refreshFor(photo);
      return;
    }

    const openButton = makeButton(options.t('report.photoView', { index: selectedIndex + 1 }), 'photo-gallery-open');
    openButton.dataset.photoId = photo.id;
    const image = makeElement('img', 'photo-gallery-image');
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.decoding = 'async';
    renderPhoto(photo, image);
    openButton.appendChild(image);
    openButton.addEventListener('click', () => {
      if (suppressOpenClick) { suppressOpenClick = false; return; }
      openFullscreen(openButton);
    });
    figure.appendChild(openButton);

    if (open) {
      opener = element.querySelector<HTMLButtonElement>(`.photo-gallery-open[data-photo-id="${photo.id}"]`) ?? opener;
      renderFullscreenPhoto(photo);
    }
  }

  function renderFullscreenPhoto(photo: Photo): void {
    lightboxImage.alt = `${options.title} · ${photoPosition()}`;
    lightboxImage.onerror = () => { void refreshFor(photo); };
    lightboxImage.src = photo.mediaUrl;
    updateNavigation();
  }

  function openFullscreen(button: HTMLButtonElement): void {
    opener = button;
    open = true;
    const photo = currentPhoto();
    if (!photo) return;
    renderFullscreenPhoto(photo);
    lightbox.hidden = false;
    lightboxClose.focus();
  }

  function closeFullscreen(): void {
    open = false;
    lightbox.hidden = true;
    opener?.focus();
    opener = null;
  }

  function moveBy(direction: -1 | 1): void {
    changeIndex(selectedIndex + direction);
  }

  previousButton.addEventListener('click', () => moveBy(-1));
  nextButton.addEventListener('click', () => moveBy(1));
  lightboxPrevious.addEventListener('click', () => moveBy(-1));
  lightboxNext.addEventListener('click', () => moveBy(1));
  lightboxClose.addEventListener('click', closeFullscreen);
  backdrop.addEventListener('click', closeFullscreen);

  viewport.addEventListener('pointerdown', (event) => { pointerStart = event.clientX; });
  viewport.addEventListener('pointerup', (event) => {
    if (pointerStart === null) return;
    const delta = event.clientX - pointerStart;
    pointerStart = null;
    if (Math.abs(delta) < 48) return;
    suppressOpenClick = true;
    moveBy(delta < 0 ? 1 : -1);
    window.setTimeout(() => { suppressOpenClick = false; }, 0);
  });
  viewport.addEventListener('pointercancel', () => { pointerStart = null; });
  viewport.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' && selectedIndex < photos.length - 1) {
      event.preventDefault(); moveBy(1);
    } else if (event.key === 'ArrowLeft' && selectedIndex > 0) {
      event.preventDefault(); moveBy(-1);
    }
  });

  lightbox.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); closeFullscreen(); return;
    }
    if (event.key === 'ArrowRight' && selectedIndex < photos.length - 1) {
      event.preventDefault(); event.stopPropagation(); moveBy(1); return;
    }
    if (event.key === 'ArrowLeft' && selectedIndex > 0) {
      event.preventDefault(); event.stopPropagation(); moveBy(-1); return;
    }
    if (event.key !== 'Tab') return;
    event.stopPropagation();
    const focusable = Array.from(lightbox.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
      .filter((button) => !button.hidden && !button.closest('[hidden]'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });

  appendElements(element, header, viewport, controls, lightbox);
  render();
  return {
    element,
    updatePhotos(nextPhotos) {
      const currentId = currentPhoto()?.id;
      photos = [...nextPhotos];
      const nextIndex = photos.findIndex(({ id }) => id === currentId);
      selectedIndex = nextIndex >= 0 ? nextIndex : Math.min(selectedIndex, Math.max(photos.length - 1, 0));
      render();
    },
    dispose() {
      disposed = true;
      open = false;
      refreshInFlight.clear();
      element.parentNode?.removeChild(element);
    },
  };
}
