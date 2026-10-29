## Purpose

Allow optional demonstration of RP redemption with accurate balances, safe retries and no implied real merchant entitlement.

## ADDED Requirements

### Requirement: Conditional transparent demo catalog
If admitted after M3, P1 Rewards SHALL show balance, Catalog/My vouchers, all active catalog items in two columns and affordability progress. Items and vouchers SHALL identify demo-only use without real partners, QR, expiry or payout promises.

#### Scenario: Insufficient funds while browsing
- **WHEN** a resident has less RP than an item costs
- **THEN** the item remains visible with honest progress and cannot claim a completed redemption

### Requirement: Confirmed server price
Redemption SHALL require confirmation showing current, cost and remaining RP. The server SHALL read the active catalog price and require reconfirmation if the displayed cost changed.

#### Scenario: Price changed before confirmation arrives
- **WHEN** the confirmed price differs from the current catalog price
- **THEN** the request returns PRICE_CHANGED without debit or voucher and the resident can reconfirm

### Requirement: Atomic idempotent redemption
Accepted redemption SHALL atomically create one RECEIVED demo voucher, one snapshotted-cost debit and the resulting balance. Same-key replay SHALL return the same voucher; different-key concurrent purchases SHALL not overspend.

#### Scenario: Competing purchases
- **WHEN** two distinct purchase requests race and funds cover only one
- **THEN** only one succeeds and the other produces neither debit nor voucher

#### Scenario: Lost purchase response
- **WHEN** the same purchase is retried after a lost response
- **THEN** the original voucher is returned without a second debit and current balance is read afresh

#### Scenario: Negative or insufficient balance
- **WHEN** an account has insufficient or negative RP
- **THEN** redemption fails without clamping the ledger balance or creating a voucher
