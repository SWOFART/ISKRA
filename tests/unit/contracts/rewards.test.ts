import { describe, expect, it } from 'vitest';
import {
  DemoRewardCatalogSchema,
  DemoRewardRedemptionReceiptSchema,
  DemoRewardRedemptionRequestSchema,
  DemoRewardVoucherListSchema,
  DemoRewardVoucherSchema,
} from '../../../src/shared/contracts';

const voucher = {
  id: '7b4ae8a3-41de-49ee-b198-4d4986c61c8b',
  catalogId: '945a594e-472a-41ef-90dc-05d74c5062c2',
  title: 'Demo recognition',
  description: 'A fictional demo item.',
  costRpSnapshot: 20,
  displayCode: 'DEMO-7B4AE8A3-41DE-49EE-B198-4D4986C61C8B',
  status: 'RECEIVED',
  createdAt: '2026-10-29T08:00:00.000Z',
  isDemo: true,
  demoTerms: 'Demo only. No real-world value or fulfillment.',
};

describe('demo Rewards contracts', () => {
  it('requires explicit demo provenance and positive integer catalog prices', () => {
    const item = {
      id: voucher.catalogId,
      title: voucher.title,
      description: voucher.description,
      costRp: 20,
      isDemo: true,
      demoTerms: voucher.demoTerms,
    };
    expect(DemoRewardCatalogSchema.parse({ items: [item] })).toEqual({ items: [item] });
    expect(DemoRewardCatalogSchema.safeParse({ items: [{ ...item, isDemo: false }] }).success).toBe(false);
    expect(DemoRewardCatalogSchema.safeParse({ items: [{ ...item, costRp: 0 }] }).success).toBe(false);
    expect(DemoRewardCatalogSchema.safeParse({ items: [{ ...item, partnerUrl: 'https://example.invalid' }] }).success)
      .toBe(false);
  });

  it('accepts only bounded positive confirmed prices and received demo vouchers', () => {
    expect(DemoRewardRedemptionRequestSchema.parse({ confirmedCostRp: 20 })).toEqual({ confirmedCostRp: 20 });
    expect(DemoRewardRedemptionRequestSchema.safeParse({ confirmedCostRp: -20 }).success).toBe(false);
    expect(DemoRewardRedemptionRequestSchema.safeParse({ confirmedCostRp: 20, balance: 99 }).success).toBe(false);
    expect(DemoRewardVoucherSchema.parse(voucher)).toEqual(voucher);
    expect(DemoRewardVoucherSchema.safeParse({ ...voucher, status: 'REDEEMED' }).success).toBe(false);
    expect(DemoRewardVoucherSchema.safeParse({ ...voucher, isDemo: false }).success).toBe(false);
    expect(DemoRewardVoucherSchema.safeParse({ ...voucher, expiresAt: voucher.createdAt }).success).toBe(false);
    expect(DemoRewardVoucherSchema.safeParse({ ...voucher, displayCode: 'REAL-QR-CREDENTIAL' }).success).toBe(false);
  });

  it('keeps the debit equal to the immutable voucher cost snapshot', () => {
    const receipt = { voucher, balance: -3, rpDebited: 20 };
    expect(DemoRewardRedemptionReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(DemoRewardRedemptionReceiptSchema.safeParse({ ...receipt, rpDebited: 19 }).success).toBe(false);
    expect(DemoRewardVoucherListSchema.parse({ items: [voucher], nextCursor: null }).items).toHaveLength(1);
  });
});
