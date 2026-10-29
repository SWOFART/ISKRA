-- Demo-only Rewards catalog, vouchers and atomic redemption support.
-- This migration adds no real partner, QR, expiry, payout or fulfillment promise.

ALTER TYPE ledger_kind ADD VALUE 'REDEMPTION';
ALTER TYPE ledger_kind ADD VALUE 'REVERSAL';

ALTER TABLE reward_ledger
  DROP CONSTRAINT reward_ledger_delta_check,
  ADD COLUMN voucher_id uuid,
  ADD CONSTRAINT reward_ledger_delta_sign_ck CHECK (
    CASE WHEN kind::text IN ('REDEMPTION', 'REVERSAL') THEN delta < 0 ELSE delta > 0 END
  );

CREATE TABLE reward_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar(120) NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  description varchar(500) NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
  image_key varchar(256),
  cost_rp integer NOT NULL CHECK (cost_rp > 0),
  active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT true CHECK (is_demo),
  demo_terms varchar(500) NOT NULL DEFAULT
    'Demo only. No real-world value, partner, QR code, expiry, payout, or fulfillment.',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reward_catalog_demo_terms_ck CHECK (
    demo_terms = 'Demo only. No real-world value, partner, QR code, expiry, payout, or fulfillment.'
  )
);

CREATE INDEX reward_catalog_active_cost_idx ON reward_catalog (cost_rp, id) WHERE active;

-- Sample prices use already selected 5/15/40 RP earning amounts. These are
-- fictional demo entries only; the fixed terms explicitly promise no goods or services.
INSERT INTO reward_catalog (id, title, description, cost_rp, active, is_demo)
VALUES
  ('11111111-1111-4111-8111-000000000005', 'Demo reward · 5 RP',
   'Illustrative demo voucher; no goods or services are provided.', 5, true, true),
  ('11111111-1111-4111-8111-000000000015', 'Demo reward · 15 RP',
   'Illustrative demo voucher; no goods or services are provided.', 15, true, true),
  ('11111111-1111-4111-8111-000000000040', 'Demo reward · 40 RP',
   'Illustrative demo voucher; no goods or services are provided.', 40, true, true);

CREATE TABLE user_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id),
  catalog_id uuid NOT NULL REFERENCES reward_catalog(id) ON DELETE RESTRICT,
  cost_rp_snapshot integer NOT NULL CHECK (cost_rp_snapshot > 0),
  redemption_key uuid NOT NULL,
  display_code varchar(41) NOT NULL UNIQUE
    CHECK (display_code ~ '^DEMO-[0-9A-F]{8}-[0-9A-F]{4}-[1-8][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$'),
  status varchar(16) NOT NULL DEFAULT 'RECEIVED' CHECK (status = 'RECEIVED'),
  is_demo boolean NOT NULL DEFAULT true CHECK (is_demo),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_vouchers_owner_redemption_key_uq UNIQUE (user_id, redemption_key),
  CONSTRAINT user_vouchers_id_owner_uq UNIQUE (id, user_id)
);

CREATE INDEX user_vouchers_owner_history_idx
  ON user_vouchers (user_id, created_at DESC, id DESC);

ALTER TABLE reward_ledger
  ADD CONSTRAINT reward_ledger_voucher_fk
    FOREIGN KEY (voucher_id, user_id) REFERENCES user_vouchers (id, user_id),
  ADD CONSTRAINT reward_ledger_voucher_uq UNIQUE (voucher_id),
  ADD CONSTRAINT reward_ledger_voucher_kind_ck CHECK (
    (kind::text = 'REDEMPTION' AND voucher_id IS NOT NULL AND is_demo)
    OR (kind::text <> 'REDEMPTION' AND voucher_id IS NULL)
  );
