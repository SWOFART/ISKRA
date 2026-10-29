import {
  DemoRewardCatalogSchema,
  DemoRewardRedemptionReceiptSchema,
  DemoRewardRedemptionRequestSchema,
  DemoRewardVoucherListSchema,
  ImpactSchema,
  type DemoRewardCatalogItem,
  type DemoRewardVoucher,
} from '../shared/contracts';
import { ApiClientError, createClientApi } from './api';
import { errorMessageKey, formatNumber, type MessageKey, type MessageValues } from './i18n';
import type { SupportedLocale } from './designTokens';
import { createOperationKeyScope, type OperationKeyScope } from './operationKey';

type ClientApi = ReturnType<typeof createClientApi>;
type Translate = (key: MessageKey, values?: MessageValues) => string;
type LoadState = 'loading' | 'ready' | 'error';
const pendingRedemptionOperations = new Map<string, OperationKeyScope>();

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

export interface RewardsPageView {
  element: HTMLElement;
  dispose(): void;
}

export function renderRewardsPage(api: ClientApi, t: Translate, locale: SupportedLocale): RewardsPageView {
  const page = makeElement('section', 'rewards-page');
  page.setAttribute('aria-labelledby', 'rewards-heading');
  const heading = makeElement('h1', undefined, t('rewards.title'));
  heading.id = 'rewards-heading';

  const balanceSection = makeElement('section', 'rewards-balance-section');
  balanceSection.appendChild(makeElement('h2', undefined, t('rewards.balance')));
  const balanceValue = makeElement('strong', 'rewards-balance-value', '—');
  const balanceStatus = makeElement('p', 'rewards-balance-status', t('impact.loading'));
  balanceStatus.setAttribute('role', 'status');
  balanceStatus.setAttribute('aria-live', 'polite');
  const balanceRetry = makeButton(t('rewards.retry'), 'rewards-retry rewards-balance-retry');
  balanceRetry.hidden = true;
  appendChildren(balanceSection, balanceValue, balanceStatus, balanceRetry);

  const catalogSection = makeElement('section', 'rewards-catalog-section');
  catalogSection.appendChild(makeElement('h2', undefined, t('rewards.catalog')));
  const catalogStatus = makeElement('p', 'rewards-catalog-status', t('rewards.catalogLoading'));
  catalogStatus.setAttribute('role', 'status');
  catalogStatus.setAttribute('aria-live', 'polite');
  const catalogRetry = makeButton(t('rewards.retry'), 'rewards-retry');
  catalogRetry.hidden = true;
  const catalogGrid = makeElement('div', 'rewards-catalog-grid');
  catalogGrid.setAttribute('aria-label', t('rewards.catalog'));
  const catalogEmpty = makeElement('p', 'rewards-empty', t('rewards.catalogEmpty'));
  catalogEmpty.hidden = true;
  appendChildren(catalogSection, catalogStatus, catalogRetry, catalogGrid, catalogEmpty);

  const voucherSection = makeElement('section', 'rewards-vouchers-section');
  voucherSection.appendChild(makeElement('h2', undefined, t('rewards.vouchers')));
  const voucherStatus = makeElement('p', 'rewards-vouchers-status', t('rewards.vouchersLoading'));
  voucherStatus.setAttribute('role', 'status');
  voucherStatus.setAttribute('aria-live', 'polite');
  const voucherRetry = makeButton(t('rewards.retry'), 'rewards-retry');
  voucherRetry.hidden = true;
  const voucherList = makeElement('ul', 'rewards-voucher-list');
  const voucherEmpty = makeElement('p', 'rewards-empty', t('rewards.vouchersEmpty'));
  voucherEmpty.hidden = true;
  const voucherMore = makeButton(t('rewards.loadMore'), 'rewards-load-more');
  voucherMore.hidden = true;
  appendChildren(voucherSection, voucherStatus, voucherRetry, voucherList, voucherEmpty, voucherMore);

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
  const redemptionStatus = makeElement('p', 'rewards-redemption-status');
  redemptionStatus.setAttribute('role', 'status');
  redemptionStatus.setAttribute('aria-live', 'polite');
  const confirmationActions = makeElement('div', 'rewards-confirmation-actions');
  const confirmButton = makeButton(t('rewards.confirm'), 'rewards-confirm');
  const cancelButton = makeButton(t('rewards.cancel'), 'rewards-cancel');
  appendChildren(confirmationActions, confirmButton, cancelButton);
  appendChildren(confirmation, confirmationHeading, confirmationMessage, confirmationTitle,
    confirmationCurrent, confirmationCost, confirmationRemaining, confirmationTermsLabel,
    confirmationTerms, confirmationDemo, redemptionStatus, confirmationActions);

  appendChildren(page, heading, balanceSection, catalogSection, voucherSection, announcement, confirmation);

  let active = true;
  let balance: number | undefined;
  let balanceVersion = -1;
  let catalog: DemoRewardCatalogItem[] = [];
  let catalogState: LoadState = 'loading';
  let vouchers: DemoRewardVoucher[] = [];
  let voucherState: LoadState = 'loading';
  let voucherCursor: string | null = null;
  let selectedReward: DemoRewardCatalogItem | undefined;
  let loadGeneration = 0;
  const controller = new AbortController();

  function renderCatalog(): void {
    catalogGrid.replaceChildren();
    catalogStatus.textContent = catalogState === 'loading'
      ? t('rewards.catalogLoading')
      : catalogState === 'error' ? t('error.UNAVAILABLE') : '';
    catalogRetry.hidden = catalogState !== 'error';
    catalogEmpty.hidden = catalogState !== 'ready' || catalog.length > 0;
    for (const reward of catalog) {
      const card = makeElement('article', 'rewards-card');
      const currentBalance = balance ?? 0;
      const remaining = balance !== undefined && currentBalance >= reward.costRp
        ? formatRp(locale, currentBalance - reward.costRp) : '—';
      const progress = document.createElement('progress');
      progress.className = 'rewards-progress';
      progress.max = reward.costRp;
      progress.value = Math.min(currentBalance, reward.costRp);
      progress.hidden = balance === undefined;
      progress.setAttribute('aria-label', t('rewards.availableProgress', {
        current: formatNumber(locale, currentBalance), cost: formatNumber(locale, reward.costRp),
      }));
      const redeemButton = makeButton(t('rewards.get'), 'rewards-get');
      redeemButton.disabled = balance === undefined || currentBalance < reward.costRp;
      redeemButton.addEventListener('click', () => openConfirmation(reward));
      appendChildren(card,
        makeElement('h3', 'rewards-card-title', reward.title),
        makeElement('p', 'rewards-card-description', reward.description),
        makeElement('span', 'rewards-demo-label', t('rewards.demoLabel')),
        makeElement('p', 'rewards-current', `${t('rewards.current')}: ${balance === undefined ? '—' : formatRp(locale, currentBalance)}`),
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
    voucherStatus.textContent = voucherState === 'loading'
      ? t('rewards.vouchersLoading')
      : voucherState === 'error' ? t('error.UNAVAILABLE') : '';
    voucherRetry.hidden = voucherState !== 'error';
    voucherMore.hidden = voucherState !== 'ready' || voucherCursor === null;
    voucherMore.disabled = false;
    voucherEmpty.hidden = voucherState !== 'ready' || vouchers.length > 0;
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
    redemptionStatus.textContent = '';
    renderConfirmation();
    if (!confirmation.open) confirmation.showModal();
    confirmButton.focus();
  }

  function renderConfirmation(): void {
    const reward = selectedReward;
    if (!reward) return;
    const currentBalance = balance ?? 0;
    confirmationTitle.textContent = reward.title;
    confirmationCurrent.textContent = `${t('rewards.current')}: ${formatRp(locale, currentBalance)}`;
    confirmationCost.textContent = `${t('rewards.cost')}: ${formatRp(locale, reward.costRp)}`;
    const remaining = balance !== undefined && currentBalance >= reward.costRp
      ? formatRp(locale, currentBalance - reward.costRp) : '—';
    confirmationRemaining.textContent = `${t('rewards.remaining')}: ${remaining}`;
    confirmationTerms.textContent = reward.demoTerms;
    confirmButton.disabled = balance === undefined || currentBalance < reward.costRp;
  }

  async function loadCatalog(): Promise<void> {
    catalogState = 'loading';
    renderCatalog();
    try {
      const result = await api.request({
        path: '/rewards/catalog', auth: 'none', responseSchema: DemoRewardCatalogSchema,
        signal: controller.signal,
      });
      if (!active) return;
      catalog = result.data.items;
      catalogState = 'ready';
      renderCatalog();
    } catch {
      if (!active || controller.signal.aborted) return;
      catalogState = 'error';
      renderCatalog();
    }
  }

  async function loadBalance(showRetryOnError = false): Promise<void> {
    try {
      const result = await api.request({
        path: '/me/impact', auth: 'required', responseSchema: ImpactSchema, signal: controller.signal,
      });
      if (!active) return;
      if (result.data.balanceVersion >= balanceVersion) {
        balance = result.data.totals.balanceRp;
        balanceVersion = result.data.balanceVersion;
        balanceValue.textContent = formatRp(locale, balance);
        renderCatalog();
        if (confirmation.open) renderConfirmation();
      }
      balanceStatus.textContent = '';
      balanceRetry.hidden = true;
    } catch (error) {
      if (!active || controller.signal.aborted) return;
      if (balance === undefined || showRetryOnError) {
        balanceStatus.textContent = t(error instanceof ApiClientError ? errorMessageKey(error.code) : 'error.generic');
        balanceRetry.hidden = false;
      }
    }
  }

  async function loadVouchers(cursor: string | null = null): Promise<void> {
    const generation = ++loadGeneration;
    voucherState = 'loading';
    voucherMore.disabled = true;
    renderVouchers();
    try {
      const path = cursor ? `/me/vouchers?cursor=${encodeURIComponent(cursor)}` : '/me/vouchers';
      const result = await api.request({
        path, auth: 'required', responseSchema: DemoRewardVoucherListSchema, signal: controller.signal,
      });
      if (!active || generation !== loadGeneration) return;
      const incoming = result.data.items;
      const merged = cursor ? [...vouchers, ...incoming] : [...incoming, ...vouchers];
      vouchers = [...new Map(merged.map((voucher) => [voucher.id, voucher])).values()]
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
          || left.id.localeCompare(right.id));
      voucherCursor = result.data.nextCursor;
      voucherState = 'ready';
      renderVouchers();
    } catch {
      if (!active || controller.signal.aborted || generation !== loadGeneration) return;
      voucherState = 'error';
      renderVouchers();
    }
  }

  async function redeem(): Promise<void> {
    const reward = selectedReward;
    if (!reward || balance === undefined || balance < reward.costRp) return;
    confirmButton.disabled = true;
    redemptionStatus.textContent = t('rewards.catalogLoading');
    let operation = pendingRedemptionOperations.get(reward.id);
    if (!operation) {
      operation = createOperationKeyScope();
      pendingRedemptionOperations.set(reward.id, operation);
    }
    try {
      const result = await api.request({
        path: `/rewards/${reward.id}/redeem`,
        method: 'POST',
        auth: 'required',
        body: { confirmedCostRp: reward.costRp },
        bodySchema: DemoRewardRedemptionRequestSchema,
        responseSchema: DemoRewardRedemptionReceiptSchema,
        operation,
        signal: controller.signal,
      });
      if (!active) return;
      operation.complete();
      pendingRedemptionOperations.delete(reward.id);
      if (result.data.balanceVersion >= balanceVersion) {
        balance = result.data.balance;
        balanceVersion = result.data.balanceVersion;
      }
      balanceValue.textContent = balance === undefined ? '—' : formatRp(locale, balance);
      balanceStatus.textContent = '';
      balanceRetry.hidden = true;
      vouchers = [result.data.voucher, ...vouchers.filter((voucher) => voucher.id !== result.data.voucher.id)];
      voucherState = 'ready';
      renderVouchers();
      renderCatalog();
      announcement.textContent = t('rewards.received', {
        points: result.data.rpDebited, balance: formatNumber(locale, balance ?? result.data.balance),
      });
      confirmation.close();
    } catch (error) {
      if (!active || controller.signal.aborted) return;
      const apiError = error instanceof ApiClientError ? error : undefined;
      redemptionStatus.textContent = t(apiError ? errorMessageKey(apiError.code) : 'error.generic');
      if (apiError?.code === 'PRICE_CHANGED') {
        pendingRedemptionOperations.get(reward.id)?.complete();
        pendingRedemptionOperations.delete(reward.id);
        await loadCatalog();
        if (!active) return;
        const refreshed = catalog.find((item) => item.id === reward.id);
        if (refreshed) {
          selectedReward = refreshed;
          redemptionStatus.textContent = t('rewards.priceChanged');
          renderConfirmation();
        }
      } else if (apiError?.code === 'INSUFFICIENT_RP') {
        pendingRedemptionOperations.get(reward.id)?.complete();
        pendingRedemptionOperations.delete(reward.id);
        await loadBalance(true);
        if (active) {
          redemptionStatus.textContent = t('rewards.insufficient');
          renderConfirmation();
        }
      } else if (!apiError?.retryable) {
        pendingRedemptionOperations.get(reward.id)?.complete();
        pendingRedemptionOperations.delete(reward.id);
      }
      confirmButton.disabled = balance === undefined || !selectedReward || balance < selectedReward.costRp;
    }
  }

  catalogRetry.addEventListener('click', () => { void loadCatalog(); });
  balanceRetry.addEventListener('click', () => { void loadBalance(true); });
  voucherRetry.addEventListener('click', () => { void loadVouchers(); });
  voucherMore.addEventListener('click', () => { if (voucherCursor) void loadVouchers(voucherCursor); });
  confirmButton.addEventListener('click', () => { void redeem(); });
  cancelButton.addEventListener('click', () => confirmation.close());
  confirmation.addEventListener('cancel', (event) => { event.preventDefault(); confirmation.close(); });
  confirmation.addEventListener('close', () => {
    selectedReward = undefined;
    redemptionStatus.textContent = '';
  });

  renderCatalog();
  renderVouchers();
  void loadCatalog();
  void loadBalance();
  void loadVouchers();

  return {
    element: page,
    dispose() {
      active = false;
      loadGeneration += 1;
      controller.abort();
      if (confirmation.open) confirmation.close();
    },
  };
}
