import {
  DemoRewardVoucherListSchema,
  type DemoRewardCatalogItem,
  type DemoRewardVoucher,
} from '../shared/contracts';
import { formatNumber, type MessageKey, type MessageValues } from './i18n';
import type { SupportedLocale } from './designTokens';

type Translate = (key: MessageKey, values?: MessageValues) => string;

const LOCAL_REWARDS_STORAGE_KEY = 'iskra:rewards:demo:v1';
const STARTING_DEMO_BALANCE_RP = 45;
const DEMO_TERMS = 'Demo only. No real-world value, partner, QR code, expiry, payout, or fulfillment.';

const DEMO_CATALOG: readonly DemoRewardCatalogItem[] = [
  {
    id: '11111111-1111-4111-8111-000000000005',
    title: 'Demo reward · 5 RP',
    description: 'Illustrative demo voucher; no goods or services are provided.',
    costRp: 5,
    isDemo: true,
    demoTerms: DEMO_TERMS,
  },
  {
    id: '11111111-1111-4111-8111-000000000015',
    title: 'Demo reward · 15 RP',
    description: 'Illustrative demo voucher; no goods or services are provided.',
    costRp: 15,
    isDemo: true,
    demoTerms: DEMO_TERMS,
  },
  {
    id: '11111111-1111-4111-8111-000000000040',
    title: 'Demo reward · 40 RP',
    description: 'Illustrative demo voucher; no goods or services are provided.',
    costRp: 40,
    isDemo: true,
    demoTerms: DEMO_TERMS,
  },
];

interface LocalRewardsState {
  balance: number;
  vouchers: DemoRewardVoucher[];
}

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function makeButton(label: string, className: string): HTMLButtonElement {
  const button = makeElement('button', className, label);
  button.type = 'button';
  return button;
}

function appendChildren(parent: HTMLElement, ...children: HTMLElement[]): void {
  for (const child of children) parent.appendChild(child);
}

function formatRp(locale: SupportedLocale, value: number): string {
  return `${formatNumber(locale, value)} RP`;
}

function readLocalRewards(): LocalRewardsState {
  try {
    const stored = window.localStorage.getItem(LOCAL_REWARDS_STORAGE_KEY);
    if (!stored) return { balance: STARTING_DEMO_BALANCE_RP, vouchers: [] };

    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== 'object') return { balance: STARTING_DEMO_BALANCE_RP, vouchers: [] };
    const record = value as Record<string, unknown>;
    if (!Number.isSafeInteger(record.balance) || (record.balance as number) < 0 || !Array.isArray(record.vouchers)) {
      return { balance: STARTING_DEMO_BALANCE_RP, vouchers: [] };
    }

    const parsedVouchers = DemoRewardVoucherListSchema.safeParse({
      items: record.vouchers.slice(0, 100),
      nextCursor: null,
    });
    if (!parsedVouchers.success) return { balance: STARTING_DEMO_BALANCE_RP, vouchers: [] };

    return { balance: record.balance as number, vouchers: parsedVouchers.data.items };
  } catch {
    return { balance: STARTING_DEMO_BALANCE_RP, vouchers: [] };
  }
}

function writeLocalRewards(state: LocalRewardsState): void {
  try {
    window.localStorage.setItem(LOCAL_REWARDS_STORAGE_KEY, JSON.stringify({
      balance: state.balance,
      vouchers: state.vouchers.slice(0, 100),
    }));
  } catch {
    // Keep the demo usable for this page session when browser storage is unavailable.
  }
}

export interface RewardsPageView {
  element: HTMLElement;
  dispose(): void;
}

export function renderRewardsPage(t: Translate, locale: SupportedLocale): RewardsPageView {
  const page = makeElement('section', 'rewards-page');
  page.setAttribute('aria-labelledby', 'rewards-heading');
  const heading = makeElement('h1', undefined, t('rewards.title'));
  heading.id = 'rewards-heading';
  const localNotice = makeElement('p', 'rewards-demo-notice', t('rewards.localOnly'));

  const localState = readLocalRewards();
  let balance = localState.balance;
  let vouchers = localState.vouchers;
  let selectedReward: DemoRewardCatalogItem | undefined;

  const balanceSection = makeElement('section', 'rewards-balance-section');
  balanceSection.appendChild(makeElement('h2', undefined, t('rewards.balance')));
  const balanceValue = makeElement('strong', 'rewards-balance-value', formatRp(locale, balance));
  balanceSection.appendChild(balanceValue);

  const catalogSection = makeElement('section', 'rewards-catalog-section');
  catalogSection.appendChild(makeElement('h2', undefined, t('rewards.catalog')));
  const catalogGrid = makeElement('div', 'rewards-catalog-grid');
  catalogGrid.setAttribute('aria-label', t('rewards.catalog'));
  const catalogEmpty = makeElement('p', 'rewards-empty', t('rewards.catalogEmpty'));
  catalogEmpty.hidden = true;
  appendChildren(catalogSection, catalogGrid, catalogEmpty);

  const voucherSection = makeElement('section', 'rewards-vouchers-section');
  voucherSection.appendChild(makeElement('h2', undefined, t('rewards.vouchers')));
  const voucherList = makeElement('ul', 'rewards-voucher-list');
  const voucherEmpty = makeElement('p', 'rewards-empty', t('rewards.vouchersEmpty'));
  appendChildren(voucherSection, voucherList, voucherEmpty);

  const announcement = makeElement('p', 'rewards-announcement');
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');

  const confirmation = document.createElement('dialog');
  confirmation.className = 'rewards-confirmation';
  confirmation.setAttribute('aria-labelledby', 'rewards-confirmation-heading');
  const confirmationHeading = makeElement('h2', undefined, t('rewards.confirmTitle'));
  confirmationHeading.id = 'rewards-confirmation-heading';
  const confirmationMessage = makeElement('p', 'rewards-confirmation-message', t('rewards.confirmMessage'));
  const confirmationTitle = makeElement('p', 'rewards-confirmation-title');
  const confirmationCurrent = makeElement('p', 'rewards-confirmation-current');
  const confirmationCost = makeElement('p', 'rewards-confirmation-cost');
  const confirmationRemaining = makeElement('p', 'rewards-confirmation-remaining');
  const confirmationTermsLabel = makeElement('h3', undefined, t('rewards.terms'));
  const confirmationTerms = makeElement('p', 'rewards-confirmation-terms');
  const confirmationDemo = makeElement('p', 'rewards-demo-notice', t('rewards.demoNotice'));
  const confirmationActions = makeElement('div', 'rewards-confirmation-actions');
  const confirmButton = makeButton(t('rewards.confirm'), 'rewards-confirm');
  const cancelButton = makeButton(t('rewards.cancel'), 'rewards-cancel');
  appendChildren(confirmationActions, confirmButton, cancelButton);
  appendChildren(confirmation, confirmationHeading, confirmationMessage, confirmationTitle,
    confirmationCurrent, confirmationCost, confirmationRemaining, confirmationTermsLabel,
    confirmationTerms, confirmationDemo, confirmationActions);

  appendChildren(page, heading, localNotice, balanceSection, catalogSection, voucherSection,
    announcement, confirmation);

  function renderCatalog(): void {
    catalogGrid.replaceChildren();
    catalogEmpty.hidden = DEMO_CATALOG.length > 0;
    for (const reward of DEMO_CATALOG) {
      const card = makeElement('article', 'rewards-card');
      const remaining = balance >= reward.costRp ? formatRp(locale, balance - reward.costRp) : '—';
      const progress = document.createElement('progress');
      progress.className = 'rewards-progress';
      progress.max = reward.costRp;
      progress.value = Math.min(balance, reward.costRp);
      progress.setAttribute('aria-label', t('rewards.availableProgress', {
        current: formatNumber(locale, balance), cost: formatNumber(locale, reward.costRp),
      }));
      const redeemButton = makeButton(t('rewards.get'), 'rewards-get');
      redeemButton.disabled = balance < reward.costRp;
      redeemButton.addEventListener('click', () => openConfirmation(reward));
      appendChildren(card,
        makeElement('h3', 'rewards-card-title', reward.title),
        makeElement('p', 'rewards-card-description', reward.description),
        makeElement('span', 'rewards-demo-label', t('rewards.demoLabel')),
        makeElement('p', 'rewards-current', `${t('rewards.current')}: ${formatRp(locale, balance)}`),
        makeElement('p', 'rewards-cost', `${t('rewards.cost')}: ${formatRp(locale, reward.costRp)}`),
        makeElement('p', 'rewards-remaining', `${t('rewards.remaining')}: ${remaining}`),
        progress,
        redeemButton,
      );
      catalogGrid.appendChild(card);
    }
  }

  function renderVouchers(): void {
    voucherList.replaceChildren();
    voucherEmpty.hidden = vouchers.length > 0;
    for (const voucher of vouchers) {
      const item = makeElement('li', 'rewards-voucher');
      appendChildren(item,
        makeElement('h3', 'rewards-voucher-title', voucher.title),
        makeElement('p', 'rewards-voucher-description', voucher.description),
        makeElement('span', 'rewards-demo-label', t('rewards.receivedLabel')),
        makeElement('p', 'rewards-voucher-cost', `${t('rewards.cost')}: ${formatRp(locale, voucher.costRpSnapshot)}`),
        makeElement('p', 'rewards-voucher-code-label', t('rewards.codeLabel')),
        makeElement('code', 'rewards-voucher-code', voucher.displayCode),
        makeElement('h4', 'rewards-voucher-terms-label', t('rewards.terms')),
        makeElement('p', 'rewards-voucher-terms', voucher.demoTerms),
      );
      voucherList.appendChild(item);
    }
  }

  function openConfirmation(reward: DemoRewardCatalogItem): void {
    selectedReward = reward;
    renderConfirmation();
    if (!confirmation.open) confirmation.showModal();
    confirmButton.focus();
  }

  function renderConfirmation(): void {
    const reward = selectedReward;
    if (!reward) return;
    confirmationTitle.textContent = reward.title;
    confirmationCurrent.textContent = `${t('rewards.current')}: ${formatRp(locale, balance)}`;
    confirmationCost.textContent = `${t('rewards.cost')}: ${formatRp(locale, reward.costRp)}`;
    const remaining = balance >= reward.costRp ? formatRp(locale, balance - reward.costRp) : '—';
    confirmationRemaining.textContent = `${t('rewards.remaining')}: ${remaining}`;
    confirmationTerms.textContent = reward.demoTerms;
    confirmButton.disabled = balance < reward.costRp;
  }

  function redeemLocally(): void {
    const reward = selectedReward;
    if (!reward || balance < reward.costRp) return;

    confirmButton.disabled = true;
    const voucherId = crypto.randomUUID().toLowerCase();
    const voucher: DemoRewardVoucher = {
      id: voucherId,
      catalogId: reward.id,
      title: reward.title,
      description: reward.description,
      costRpSnapshot: reward.costRp,
      displayCode: `DEMO-${voucherId.toUpperCase()}`,
      status: 'RECEIVED',
      createdAt: new Date().toISOString(),
      isDemo: true,
      demoTerms: reward.demoTerms,
    };

    balance -= reward.costRp;
    vouchers = [voucher, ...vouchers.filter((item) => item.id !== voucher.id)].slice(0, 100);
    writeLocalRewards({ balance, vouchers });
    balanceValue.textContent = formatRp(locale, balance);
    renderVouchers();
    renderCatalog();
    announcement.textContent = t('rewards.received', {
      points: reward.costRp,
      balance: formatNumber(locale, balance),
    });
    confirmation.close();
  }

  confirmButton.addEventListener('click', redeemLocally);
  cancelButton.addEventListener('click', () => confirmation.close());
  confirmation.addEventListener('cancel', (event) => { event.preventDefault(); confirmation.close(); });
  confirmation.addEventListener('close', () => { selectedReward = undefined; });

  renderCatalog();
  renderVouchers();

  return {
    element: page,
    dispose() {
      if (confirmation.open) confirmation.close();
    },
  };
}
