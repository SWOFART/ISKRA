-- Resident-owned Red report drafts and manually verified authority contacts.
-- This migration seeds no contact data; do not add a contact without a reviewed source.

ALTER TABLE reports
  ADD CONSTRAINT reports_id_author_user_uq UNIQUE (id, author_user_id);

CREATE TABLE red_verified_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id text NOT NULL CHECK (city_id = 'heilbronn'),
  locale varchar(2) NOT NULL CHECK (locale IN ('en', 'de')),
  label varchar(120) NOT NULL CHECK (btrim(label) <> ''),
  channel varchar(20) NOT NULL CHECK (channel IN ('EMAIL', 'PHONE', 'WEBSITE', 'POSTAL_ADDRESS')),
  value varchar(500) NOT NULL CHECK (btrim(value) <> ''),
  source_label varchar(200) NOT NULL CHECK (btrim(source_label) <> ''),
  source_url varchar(2048) NOT NULL CHECK (source_url ~ '^https://[^[:space:]]+$'),
  verified_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT red_verified_contacts_city_locale_channel_value_uq
    UNIQUE (city_id, locale, channel, value)
);

CREATE INDEX red_verified_contacts_active_city_idx
  ON red_verified_contacts (city_id, locale, label, id)
  WHERE active;

CREATE TABLE red_personal_drafts (
  report_id uuid NOT NULL,
  owner_user_id text NOT NULL,
  locale varchar(2) NOT NULL CHECK (locale IN ('en', 'de')),
  draft_text varchar(4000) NOT NULL CHECK (char_length(btrim(draft_text)) BETWEEN 1 AND 4000),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, owner_user_id),
  CONSTRAINT red_personal_drafts_report_author_fk
    FOREIGN KEY (report_id, owner_user_id)
    REFERENCES reports (id, author_user_id)
    ON DELETE CASCADE
);

CREATE INDEX red_personal_drafts_owner_updated_idx
  ON red_personal_drafts (owner_user_id, updated_at DESC, report_id);
