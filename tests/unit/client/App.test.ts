import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/client/App';
import { clientDesign } from '../../../src/client/designTokens';

type TestListener = (event: Record<string, unknown>) => void;

class TestElement {
  readonly children: TestElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, TestListener[]>();
  className = '';
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

function createHarness(pathname = '/map') {
  focusedElement = null;
  const location = { pathname };
  const windowListeners = new Map<string, ((event: unknown) => void)[]>();
  const accessAttempts: string[] = [];
  const fakeDocument = {
    createElement: (tagName: string) => new TestElement(tagName),
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

  return {
    root: App() as unknown as TestElement,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('client shell', () => {
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
});
