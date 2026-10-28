import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/client/App';
import { createClientApi, DEVELOPMENT_FIXTURE_LABEL, type FixtureResponse } from '../../../src/client/api';
import { clientDesign, type SupportedLocale } from '../../../src/client/designTokens';
import { ReportSummarySchema } from '../../../src/shared/contracts';

type TestListener = (event: Record<string, unknown>) => void;

class TestElement {
  readonly children: TestElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, TestListener[]>();
  className = '';
  disabled = false;
  id = '';
  hidden = false;
  href = '';
  tabIndex = 0;
  type = '';
  private ownText = '';

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.splice(0);
  }

  appendChild(element: TestElement): TestElement {
    this.children.push(element);
    return element;
  }

  replaceChildren(...elements: TestElement[]): void {
    this.children.splice(0, this.children.length, ...elements);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(name: string, listener: TestListener): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name: string, event: Record<string, unknown> = {}): void {
    if (name === 'click' && this.disabled) return;
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  focus(): void {
    focusedElement = this;
  }

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): TestElement[] {
    const matches: TestElement[] = [];
    if (this.matches(selector)) matches.push(this);
    for (const child of this.children) matches.push(...child.querySelectorAll(selector));
    return matches;
  }

  private matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('[') && selector.endsWith(']')) {
      const [name, value] = selector.slice(1, -1).split('=');
      return value === undefined
        ? this.attributes.has(name)
        : this.getAttribute(name) === value.replaceAll('"', '');
    }
    return this.tagName === selector.toLowerCase();
  }
}

let focusedElement: TestElement | null = null;

function createHarness(
  pathname = '/map',
  api = createClientApi({
    mode: 'fixture',
    fixtureResolver: () => ({ status: 200, body: { items: [], nextCursor: null } }),
  }),
  locale: SupportedLocale = 'en',
) {
  focusedElement = null;
  const location = { pathname };
  const windowListeners = new Map<string, ((event: unknown) => void)[]>();
  const accessAttempts: string[] = [];
  const fakeDocument = {
    createElement: (tagName: string) => new TestElement(tagName),
    documentElement: { lang: '' },
  };
  const fakeWindow = {
    location,
    history: {
      pushState: (_state: unknown, _title: string, path: string) => {
        location.pathname = path;
      },
    },
    addEventListener: (name: string, listener: (event: unknown) => void) => {
      const listeners = windowListeners.get(name) ?? [];
      listeners.push(listener);
      windowListeners.set(name, listeners);
    },
  };
  const fakeNavigator = new Proxy({}, {
    get: (_target, property) => {
      accessAttempts.push(String(property));
      return undefined;
    },
  });

  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('navigator', fakeNavigator);

  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
  });

  return {
    root: App(api, locale) as unknown as TestElement,
    location,
    accessAttempts,
    dispatchWindowEvent(name: string) {
      for (const listener of windowListeners.get(name) ?? []) listener({});
    },
  };
}

function selectedTab(root: TestElement): TestElement | undefined {
  return root.querySelectorAll('[role="tab"]').find(
    (tab) => tab.getAttribute('aria-selected') === 'true',
  );
}

const confirmedUnresolvedReport = ReportSummarySchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  route: 'GREEN',
  status: 'AWAITING_RESOLUTION',
  location: { lat: 49.14, lng: 9.22 },
  coverPhotoId: '22222222-2222-4222-8222-222222222222',
  description: 'Litter remains beside the path.',
  existenceYesCount: 8,
  resolutionYesCount: 2,
  existenceVerifiedAt: '2026-10-27T11:00:00.000Z',
  lastExistenceConfirmedAt: '2026-10-27T12:00:00.000Z',
  version: 8,
  updatedAt: '2026-10-27T12:00:00.000Z',
  isDemo: false,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('client shell', () => {
  it('loads shared fixtures through the app and visibly labels sample data', async () => {
    const { root } = createHarness('/map', createClientApi({ mode: 'fixture' }));

    await vi.waitFor(() => expect(root.querySelector('.fixture-banner')?.hidden).toBe(false));

    expect(root.querySelector('.fixture-banner')?.textContent).toBe(DEVELOPMENT_FIXTURE_LABEL);
    expect(root.querySelector('.map-status')?.textContent).toContain('1 sample report loaded.');
  });

  it('offers a user-triggered retry after retryable fixture errors', async () => {
    const responses: FixtureResponse[] = [
      {
        status: 429,
        body: {
          error: {
            code: 'RATE_LIMITED',
            message: 'Wait before trying again.',
            requestId: '11111111-1111-4111-8111-111111111111',
            retryable: true,
          },
        },
      },
      { status: 200, body: { items: [], nextCursor: null } },
    ];
    const fixtureResolver = vi.fn(() => responses.shift()!);
    const { root } = createHarness('/map', createClientApi({ mode: 'fixture', fixtureResolver }));
    const mapStatus = root.querySelector('.map-status');
    const retryButton = root.querySelector('.retry-button');

    await vi.waitFor(() => expect(retryButton?.hidden).toBe(false));
    expect(mapStatus?.textContent).toContain('Wait before trying again.');
    retryButton?.dispatch('click');
    await vi.waitFor(() => expect(mapStatus?.textContent).toContain('No sample reports are available yet.'));

    expect(fixtureResolver).toHaveBeenCalledTimes(2);
    expect(retryButton?.hidden).toBe(true);
  });

  it('honors Retry-After before enabling a user-triggered retry after 429', async () => {
    vi.useFakeTimers();
    const responses = [
      new Response(JSON.stringify({
        error: {
          code: 'RATE_LIMITED',
          message: 'Rate limit reached.',
          requestId: '11111111-1111-4111-8111-111111111111',
          retryable: true,
        },
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '2' },
      }),
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ];
    const fetcher = vi.fn(async () => responses.shift()!);
    const { root } = createHarness('/map', createClientApi({ mode: 'live', fetcher }));
    const mapStatus = root.querySelector('.map-status');
    const retryButton = root.querySelector('.retry-button');

    await vi.advanceTimersByTimeAsync(0);
    expect(retryButton?.hidden).toBe(false);
    expect(retryButton?.disabled).toBe(true);
    expect(mapStatus?.textContent).toContain('Please wait before retrying.');

    retryButton?.dispatch('click');
    expect(fetcher).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1999);
    expect(retryButton?.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(retryButton?.disabled).toBe(false);

    retryButton?.dispatch('click');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(mapStatus?.textContent).toContain('No reports are available yet.');
  });

  it('does not offer retry for non-retryable fixture errors', async () => {
    const api = createClientApi({
      mode: 'fixture',
      fixtureResolver: () => ({
        status: 400,
        body: {
          error: {
            code: 'INVALID_INPUT',
            message: 'Correct the request before continuing.',
            requestId: '11111111-1111-4111-8111-111111111111',
            retryable: false,
          },
        },
      }),
    });
    const { root } = createHarness('/map', api);
    const mapStatus = root.querySelector('.map-status');
    const retryButton = root.querySelector('.retry-button');

    await vi.waitFor(() => expect(mapStatus?.textContent).toContain('Correct the request before continuing.'));

    expect(retryButton?.hidden).toBe(true);
  });

  it('shows exactly three tabs and a Heilbronn map without accessing location or camera APIs', () => {
    const { root, accessAttempts } = createHarness();

    expect(root.querySelectorAll('[role="tab"]')
      .map((tab) => tab.querySelector('.nav-label')?.textContent)).toEqual([
      'Map', 'My Impact', 'Rewards',
    ]);
    expect(selectedTab(root)?.querySelector('.nav-label')?.textContent).toBe('Map');

    const mapCanvas = root.querySelector('.map-canvas');
    expect(mapCanvas?.getAttribute('data-latitude')).toBe(String(clientDesign.map.center.latitude));
    expect(mapCanvas?.getAttribute('data-longitude')).toBe(String(clientDesign.map.center.longitude));
    expect(mapCanvas?.getAttribute('data-zoom')).toBe(String(clientDesign.map.zoom));
    expect(accessAttempts).toEqual([]);
  });

  it('shows confirmed unresolved reports as active and keeps verification queries citywide', async () => {
    const requests: string[] = [];
    const api = createClientApi({
      mode: 'fixture',
      fixtureResolver: (request) => {
        requests.push(request.path);
        return { status: 200, body: { items: [confirmedUnresolvedReport], nextCursor: null } };
      },
    });
    const { root } = createHarness('/map', api);

    await vi.waitFor(() => expect(root.querySelector('.report-list-item')).not.toBeNull());

    const reportRow = root.querySelector('.report-list-item');
    expect(reportRow?.textContent).toContain('Cleanup awaiting verification');
    expect(reportRow?.textContent).toContain('Existence: 3/3 threshold · 8 confirmations');
    expect(new URL(requests[0], 'https://iskra.invalid').searchParams.get('resolved')).toBe('false');
    expect(new URL(requests[0], 'https://iskra.invalid').searchParams.get('needsVerification')).toBe('false');

    root.querySelectorAll('.map-filter-button')[0].dispatch('click');
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const verificationQuery = new URL(requests[1], 'https://iskra.invalid').searchParams;
    expect(verificationQuery.get('needsVerification')).toBe('true');
    expect(verificationQuery.get('bbox')).toBeNull();

    root.querySelectorAll('.map-filter-button')[1].dispatch('click');
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    const resolvedQuery = new URL(requests[2], 'https://iskra.invalid').searchParams;
    expect(resolvedQuery.get('resolved')).toBe('true');
  });

  it('filters the three route layers with readable route labels', async () => {
    const requests: string[] = [];
    const api = createClientApi({
      mode: 'fixture',
      fixtureResolver: (request) => {
        requests.push(request.path);
        return { status: 200, body: { items: [], nextCursor: null } };
      },
    });
    const { root } = createHarness('/map', api);

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(root.querySelectorAll('.route-filter').map((button) => button.textContent))
      .toEqual(['Green', 'Yellow', 'Red']);

    root.querySelectorAll('.route-filter')[2].dispatch('click');
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(new URL(requests[1], 'https://iskra.invalid').searchParams.get('routes'))
      .toBe('GREEN,YELLOW');
  });

  it.each([
    ['/impact', 'My Impact', 'Sign in to see your reports and community contributions.'],
    ['/rewards', 'Rewards', 'Sign in to see your reward balance and available rewards.'],
  ])('opens the protected %s deep link with a sign-in option', (path, label, message) => {
    const { root, location } = createHarness(path);
    const panel = root.querySelector('.tab-panel');

    expect(location.pathname).toBe(path);
    expect(selectedTab(root)?.querySelector('.nav-label')?.textContent).toBe(label);
    expect(panel?.textContent).toContain(message);
    expect(panel?.querySelector('button')?.textContent).toBe('Sign in');
  });

  it('supports arrow, Home and End keyboard navigation while updating browser history', () => {
    const { root, location } = createHarness();
    const tabs = root.querySelectorAll('[role="tab"]');
    const preventDefault = vi.fn();

    tabs[0].dispatch('keydown', { key: 'ArrowRight', preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focusedElement).toBe(tabs[1]);
    expect(selectedTab(root)).toBe(tabs[1]);
    expect(location.pathname).toBe('/impact');

    tabs[1].dispatch('keydown', { key: 'End', preventDefault });
    expect(focusedElement).toBe(tabs[2]);
    expect(selectedTab(root)).toBe(tabs[2]);
    expect(location.pathname).toBe('/rewards');

    tabs[2].dispatch('keydown', { key: 'Home', preventDefault });
    expect(focusedElement).toBe(tabs[0]);
    expect(selectedTab(root)).toBe(tabs[0]);
    expect(location.pathname).toBe('/map');
  });

  it('supports touch-friendly tab activation through the button click event', () => {
    const { root, location } = createHarness();
    const tabs = root.querySelectorAll('[role="tab"]');

    tabs[2].dispatch('click');

    expect(selectedTab(root)).toBe(tabs[2]);
    expect(location.pathname).toBe('/rewards');
  });

  it('keeps the guest report entry deferred without requesting location or photos', () => {
    const { root, accessAttempts } = createHarness();
    const reportButton = root.querySelector('.report-button');

    reportButton?.dispatch('click');

    const notice = root.querySelector('.map-notice');
    expect(notice?.hidden).toBe(false);
    expect(notice?.textContent).toContain('No location or photos have been requested.');
    expect(accessAttempts).toEqual([]);
  });

  it('restores the selected tab on browser back/forward navigation', () => {
    const { root, location, dispatchWindowEvent } = createHarness('/impact');
    location.pathname = '/rewards';
    dispatchWindowEvent('popstate');

    expect(selectedTab(root)?.querySelector('.nav-label')?.textContent).toBe('Rewards');
    expect(root.querySelector('.tab-panel')?.textContent).toContain(
      'Sign in to see your reward balance and available rewards.',
    );
  });

  it.each(['/impact', '/rewards'])('keeps deferred %s actions honest', (path) => {
    const { root } = createHarness(path);
    const panel = root.querySelector('.tab-panel');
    const signIn = panel?.querySelector('button');

    signIn?.dispatch('click');

    expect(panel?.textContent).toContain(
      'Sign-in will be available when account access is connected.',
    );
  });

  it('renders German navigation and map copy for the German locale', async () => {
    const { root } = createHarness('/map', createClientApi({
      mode: 'fixture',
      fixtureResolver: () => ({ status: 200, body: { items: [], nextCursor: null } }),
    }), 'de');

    expect(root.querySelectorAll('[role="tab"]')
      .map((tab) => tab.querySelector('.nav-label')?.textContent)).toEqual([
      'Karte', 'Mein Einfluss', 'Belohnungen',
    ]);
    expect(root.querySelector('.report-button')?.textContent).toBe('Müll melden');
    await vi.waitFor(() => expect(root.querySelector('.map-status')?.textContent)
      .toContain('Es sind noch keine Beispiel-Meldungen verfügbar.'));
  });

  it('switches language without losing the selected tab', () => {
    const { root, location } = createHarness('/impact');
    const germanButton = root.querySelectorAll('.locale-button')
      .find((button) => button.getAttribute('lang') === 'de');

    germanButton?.dispatch('click');

    expect(selectedTab(root)?.querySelector('.nav-label')?.textContent).toBe('Mein Einfluss');
    expect(location.pathname).toBe('/impact');
    expect(root.querySelector('.tab-panel')?.textContent).toContain('Dein Einfluss');
    const activeLocale = root.querySelectorAll('.locale-button')
      .find((button) => button.getAttribute('aria-pressed') === 'true');
    expect(activeLocale?.getAttribute('lang')).toBe('de');
  });
});
