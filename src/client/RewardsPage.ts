import {
  DemoRewardVoucherListSchema,
  type DemoRewardVoucher,
} from '../shared/contracts';
import { formatNumber, type MessageKey, type MessageValues } from './i18n';
import type { SupportedLocale } from './designTokens';
import cafeDrinkImage from './assets/rewards/cafe-drink.webp';
import cafePastryImage from './assets/rewards/cafe-pastry.webp';
import reusableCupImage from './assets/rewards/reusable-cup.webp';

type Translate = (key: MessageKey, values?: MessageValues) => string;
type OfferMessageKey = Extract<MessageKey, `rewards.offer.${string}`>;

const LOCAL_REWARDS_STORAGE_KEY = 'iskra:rewards:demo:v1';
const STARTING_DEMO_BALANCE_RP = 45;

interface LocalDemoReward {
  id: string;
  titleKey: OfferMessageKey;
  descriptionKey: OfferMessageKey;
  imageUrl: string;
  imageAltKey: OfferMessageKey;
  costRp: number;
}

const DEMO_CATALOG: readonly LocalDemoReward[] = [
  {
    id: '22222222-2222-4222-8222-000000000005',
    titleKey: 'rewards.offer.cafeDrink.title',
    descriptionKey: 'rewards.offer.cafeDrink.description',
    imageUrl: cafeDrinkImage,
    imageAltKey: 'rewards.offer.cafeDrink.imageAlt',
    costRp: 5,
  },
  {
    id: '22222222-2222-4222-8222-000000000015',
    titleKey: 'rewards.offer.cafeCombo.title',
    descriptionKey: 'rewards.offer.cafeCombo.description',
    imageUrl: cafePastryImage,
    imageAltKey: 'rewards.offer.cafeCombo.imageAlt',
    costRp: 15,
  },
  {
    id: '22222222-2222-4222-8222-000000000040',
    titleKey: 'rewards.offer.reusableCup.title',
    descriptionKey: 'rewards.offer.reusableCup.description',
    imageUrl: reusableCupImage,
    imageAltKey: 'rewards.offer.reusableCup.imageAlt',
    costRp: 40,
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
  let selectedReward: LocalDemoReward | undefined;

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
      const image = makeElement('img', 'rewards-card-image');
      image.src = reward.imageUrl;
      image.alt = t(reward.imageAltKey);
      image.width = 640;
      image.height = 640;
      image.decoding = 'async';
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
        image,
        makeElement('h3', 'rewards-card-title', t(reward.titleKey)),
        makeElement('p', 'rewards-card-description', t(reward.descriptionKey)),
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

  function openConfirmation(reward: LocalDemoReward): void {
    selectedReward = reward;
    renderConfirmation();
    if (!confirmation.open) confirmation.showModal();
    confirmButton.focus();
  }

  function renderConfirmation(): void {
    const reward = selectedReward;
    if (!reward) return;
    confirmationTitle.textContent = t(reward.titleKey);
    confirmationCurrent.textContent = `${t('rewards.current')}: ${formatRp(locale, balance)}`;
    confirmationCost.textContent = `${t('rewards.cost')}: ${formatRp(locale, reward.costRp)}`;
    const remaining = balance >= reward.costRp ? formatRp(locale, balance - reward.costRp) : '—';
    confirmationRemaining.textContent = `${t('rewards.remaining')}: ${remaining}`;
    confirmationTerms.textContent = t('rewards.demoTerms');
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
      title: t(reward.titleKey),
      description: t(reward.descriptionKey),
      costRpSnapshot: reward.costRp,
      displayCode: `DEMO-${voucherId.toUpperCase()}`,
      status: 'RECEIVED',
      createdAt: new Date().toISOString(),
      isDemo: true,
      demoTerms: t('rewards.demoTerms'),
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
