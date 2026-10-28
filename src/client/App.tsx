import { clientDesign } from './designTokens';

type TabId = 'map' | 'impact' | 'rewards';

const tabPaths: Record<TabId, string> = {
  map: '/map',
  impact: '/impact',
  rewards: '/rewards',
};

function tabFromPath(pathname: string): TabId {
  if (pathname === tabPaths.impact) return 'impact';
  if (pathname === tabPaths.rewards) return 'rewards';
  return 'map';
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

function renderMapPanel(onReport: () => void): HTMLElement {
  const page = makeElement('section', 'map-page');
  page.setAttribute('aria-label', 'Map of Heilbronn');

  const mapCanvas = makeElement('div', 'map-canvas');
  mapCanvas.setAttribute('role', 'img');
  mapCanvas.setAttribute('aria-label', 'Map preview centered on Heilbronn');
  mapCanvas.setAttribute('data-latitude', String(clientDesign.map.center.latitude));
  mapCanvas.setAttribute('data-longitude', String(clientDesign.map.center.longitude));
  mapCanvas.setAttribute('data-zoom', String(clientDesign.map.zoom));

  const mapLabel = makeElement('div', 'map-location');
  appendElements(mapLabel,
    makeElement('span', 'eyebrow', 'YOUR CITY'),
    makeElement('strong', undefined, 'Heilbronn'),
  );

  const mapStatus = makeElement('div', 'map-status');
  appendElements(mapStatus,
    makeElement('span', 'status-dot'),
    makeElement('span', undefined, 'Report map is not connected yet.'),
  );

  const reportButton = makeButton('Report litter', 'report-button');
  reportButton.setAttribute('aria-label', 'Start a litter report');
  reportButton.addEventListener('click', onReport);

  const mapNotice = makeElement('p', 'map-notice');
  mapNotice.hidden = true;
  mapNotice.setAttribute('role', 'status');

  appendElements(page, mapCanvas, mapLabel, mapStatus, reportButton, mapNotice);
  return page;
}

function renderDeferredPanel(
  heading: string,
  message: string,
  actionLabel?: string,
): HTMLElement {
  const page = makeElement('section', 'deferred-page');
  page.setAttribute('aria-labelledby', 'deferred-heading');

  const card = makeElement('div', 'deferred-card');
  appendElements(card,
    makeElement('span', 'deferred-icon', '✳'),
    makeElement('h1', undefined, heading),
    makeElement('p', undefined, message),
  );

  if (actionLabel) {
    const action = makeButton(actionLabel, 'secondary-button');
    const notice = makeElement('p', 'action-notice');
    notice.hidden = true;
    notice.setAttribute('role', 'status');
    action.addEventListener('click', () => {
      notice.textContent = 'Sign-in will be available when account access is connected.';
      notice.hidden = false;
    });
    appendElements(card, action, notice);
  }

  const headingElement = card.querySelector('h1');
  headingElement?.setAttribute('id', 'deferred-heading');
  appendElements(page, card);
  return page;
}

export function App(): HTMLElement {
  const shell = makeElement('div', 'app-shell');
  const header = makeElement('header', 'app-header');
  const brand = makeElement('a', 'brand', 'ISKRA');
  brand.href = tabPaths.map;
  brand.setAttribute('aria-label', 'ISKRA — Map');
  appendElements(header, brand, makeElement('span', 'header-caption', 'A cleaner city, together'));

  const main = makeElement('main', 'app-main');
  const tablist = makeElement('nav', 'bottom-nav');
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Main navigation');

  const labels: Record<TabId, string> = {
    map: 'Map',
    impact: 'My Impact',
    rewards: 'Rewards',
  };
  const tabOrder = ['map', 'impact', 'rewards'] as const;
  const icons: Record<TabId, string> = {
    map: '⌖',
    impact: '◉',
    rewards: '◇',
  };
  const tabs = new Map<TabId, HTMLButtonElement>();

  for (const tabId of ['map', 'impact', 'rewards'] as const) {
    const tab = makeButton('', 'nav-tab');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-label', labels[tabId]);
    tab.id = `tab-${tabId}`;
    tab.setAttribute('aria-controls', 'main-panel');
    appendElements(tab,
      makeElement('span', 'nav-icon', icons[tabId]),
      makeElement('span', 'nav-label', labels[tabId]),
    );
    tab.addEventListener('click', () => activateTab(tabId, true));
    tab.addEventListener('keydown', (event) => {
      const currentIndex = tabOrder.indexOf(tabId);
      let nextIndex: number;

      if (event.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % tabOrder.length;
      } else if (event.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + tabOrder.length) % tabOrder.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = tabOrder.length - 1;
      } else {
        return;
      }

      event.preventDefault();
      const nextTab = tabs.get(tabOrder[nextIndex]);
      nextTab?.focus();
      activateTab(tabOrder[nextIndex], true);
    });
    tabs.set(tabId, tab);
    appendElements(tablist, tab);
  }

  let selectedTab = tabFromPath(window.location.pathname);
  function activateTab(tabId: TabId, updateHistory: boolean): void {
    selectedTab = tabId;
    if (updateHistory && window.location.pathname !== tabPaths[tabId]) {
      window.history.pushState({}, '', tabPaths[tabId]);
    }

    for (const [id, tab] of tabs) {
      const isSelected = id === selectedTab;
      tab.setAttribute('aria-selected', String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
    }

    const panel = makeElement('div', 'tab-panel');
    panel.id = 'main-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `tab-${selectedTab}`);
    panel.tabIndex = 0;

    if (selectedTab === 'map') {
      const map = renderMapPanel(() => {
        const notice = panel.querySelector<HTMLElement>('.map-notice');
        if (notice) {
          notice.textContent = 'Camera reporting is not connected yet. No location or photos have been requested.';
          notice.hidden = false;
        }
      });
      appendElements(panel, map);
    } else if (selectedTab === 'impact') {
      appendElements(panel,
        renderDeferredPanel(
          'Your impact',
          'Sign in to see your reports and community contributions.',
          'Sign in',
        ),
      );
    } else {
      appendElements(panel,
        renderDeferredPanel(
          'Rewards',
          'Sign in to see your reward balance and available rewards.',
          'Sign in',
        ),
      );
    }

    main.replaceChildren(panel);
  }

  window.addEventListener('popstate', () => {
    activateTab(tabFromPath(window.location.pathname), false);
  });

  appendElements(shell, header, main, tablist);
  activateTab(selectedTab, false);
  return shell;
}
