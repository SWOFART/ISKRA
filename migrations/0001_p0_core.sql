-- ISKRA P0 relational foundation. Apply once in a transaction using the migration role.
-- Do not run this from Worker startup; the runtime role must not own the schema.

CREATE TYPE report_route AS ENUM ('GREEN', 'YELLOW', 'RED');
CREATE TYPE report_lifecycle AS ENUM (
  'AWAITING_EXISTENCE', 'VERIFIED', 'AWAITING_RESOLUTION', 'RESOLVED'
);
CREATE TYPE vote_stage AS ENUM ('EXISTENCE', 'RESOLUTION');
CREATE TYPE vote_choice AS ENUM ('YES', 'NO');
CREATE TYPE cleanup_status AS ENUM ('AWAITING_VERIFICATION', 'VERIFIED');
CREATE TYPE analysis_kind AS ENUM ('REPORT', 'CLEANUP');
CREATE TYPE analysis_status AS ENUM ('RUNNING', 'READY', 'FAILED');
CREATE TYPE photo_purpose AS ENUM ('REPORT', 'CLEANUP');
CREATE TYPE photo_state AS ENUM ('RESERVED', 'UPLOADED', 'ATTACHED');
CREATE TYPE ledger_kind AS ENUM ('REPORT_INITIAL', 'REPORT_FINAL', 'CLEANUP', 'VOTE');
CREATE TYPE notification_kind AS ENUM ('EXISTENCE_VERIFIED', 'REPORT_RESOLVED');

CREATE TABLE users (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128 AND btrim(id) <> ''),
  nickname varchar(80) NOT NULL CHECK (btrim(nickname) <> ''),
  avatar_key varchar(80) NOT NULL DEFAULT 'avatar-default' CHECK (btrim(avatar_key) <> ''),
  rp_balance integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_user_id text NOT NULL REFERENCES users(id),
  route report_route NOT NULL,
  status report_lifecycle NOT NULL DEFAULT 'AWAITING_EXISTENCE',
  description varchar(1000) NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 1000),
  original_ai_description varchar(1000),
  comment varchar(1000) NOT NULL DEFAULT '' CHECK (char_length(comment) <= 1000),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  measured_lat double precision NOT NULL CHECK (measured_lat BETWEEN -90 AND 90),
  measured_lng double precision NOT NULL CHECK (measured_lng BETWEEN -180 AND 180),
  accuracy_m double precision NOT NULL CHECK (accuracy_m BETWEEN 0 AND 50),
  captured_location_at timestamptz NOT NULL,
  city_id text NOT NULL DEFAULT 'heilbronn' CHECK (city_id = 'heilbronn'),
  analysis_kind analysis_kind NOT NULL DEFAULT 'REPORT' CHECK (analysis_kind = 'REPORT'),
  analysis_id uuid NOT NULL UNIQUE,
  reporter_total_rp integer NOT NULL DEFAULT 20 CHECK (reporter_total_rp = 20),
  initial_rp integer NOT NULL DEFAULT 5 CHECK (initial_rp = 5),
  cleaner_rp integer NOT NULL DEFAULT 40 CHECK (cleaner_rp = 40),
  existence_yes_count integer NOT NULL DEFAULT 0 CHECK (existence_yes_count >= 0),
  resolution_yes_count integer NOT NULL DEFAULT 0 CHECK (resolution_yes_count BETWEEN 0 AND 3),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  published_at timestamptz NOT NULL DEFAULT now(),
  existence_verified_at timestamptz,
  last_existence_confirmed_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false,
  CONSTRAINT reports_existence_lifecycle_ck CHECK (
    (status = 'AWAITING_EXISTENCE' AND existence_yes_count < 3 AND existence_verified_at IS NULL)
    OR (status <> 'AWAITING_EXISTENCE' AND existence_yes_count >= 3 AND existence_verified_at IS NOT NULL)
  ),
  CONSTRAINT reports_existence_recency_ck CHECK (
    (existence_yes_count = 0 AND last_existence_confirmed_at IS NULL)
    OR (existence_yes_count > 0 AND last_existence_confirmed_at IS NOT NULL)
  ),
  CONSTRAINT reports_existence_timestamps_ck CHECK (
    existence_verified_at IS NULL
    OR last_existence_confirmed_at >= existence_verified_at
  ),
  CONSTRAINT reports_resolution_lifecycle_ck CHECK (
    (status = 'RESOLVED' AND resolution_yes_count = 3 AND resolved_at IS NOT NULL)
    OR (status = 'AWAITING_RESOLUTION' AND resolution_yes_count BETWEEN 0 AND 2 AND resolved_at IS NULL)
    OR (status IN ('AWAITING_EXISTENCE', 'VERIFIED') AND resolution_yes_count = 0 AND resolved_at IS NULL)
  ),
  CONSTRAINT reports_cleanup_route_ck CHECK (
    status NOT IN ('AWAITING_RESOLUTION', 'RESOLVED') OR route = 'GREEN'
  )
);

CREATE TABLE ai_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id text NOT NULL REFERENCES users(id),
  kind analysis_kind NOT NULL,
  status analysis_status NOT NULL,
  report_id uuid REFERENCES reports(id),
  input_hash varchar(256) NOT NULL CHECK (btrim(input_hash) <> ''),
  photo_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(photo_ids) = 'array'),
  context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  result jsonb,
  model_id varchar(200),
  prompt_version varchar(100),
  expires_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false,
  CONSTRAINT ai_analyses_target_ck CHECK (
    (kind = 'REPORT' AND report_id IS NULL)
    OR (kind = 'CLEANUP' AND report_id IS NOT NULL)
  ),
  CONSTRAINT ai_analyses_result_ck CHECK (
    (status = 'READY' AND result IS NOT NULL AND expires_at IS NOT NULL)
    OR (status IN ('RUNNING', 'FAILED') AND result IS NULL)
  ),
  CONSTRAINT ai_analyses_expiry_ck CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT ai_analyses_consumed_ck CHECK (consumed_at IS NULL OR status = 'READY'),
  CONSTRAINT ai_analyses_owner_kind_uq UNIQUE (id, owner_user_id, kind),
  CONSTRAINT ai_analyses_lease_owner_uq UNIQUE (id, owner_user_id, kind, input_hash),
  CONSTRAINT ai_analyses_cleanup_target_uq UNIQUE (id, owner_user_id, report_id)
);

ALTER TABLE reports
  ADD CONSTRAINT reports_analysis_owner_kind_fk FOREIGN KEY (
    analysis_id, author_user_id, analysis_kind
  ) REFERENCES ai_analyses(id, owner_user_id, kind);

CREATE TABLE analysis_leases (
  owner_user_id text NOT NULL REFERENCES users(id),
  kind analysis_kind NOT NULL,
  input_hash varchar(256) NOT NULL CHECK (btrim(input_hash) <> ''),
  current_analysis_id uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, kind, input_hash),
  UNIQUE (current_analysis_id),
  CONSTRAINT analysis_leases_current_attempt_fk FOREIGN KEY (
    current_analysis_id, owner_user_id, kind, input_hash
  ) REFERENCES ai_analyses(id, owner_user_id, kind, input_hash)
);

CREATE TABLE cleanup_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL UNIQUE REFERENCES reports(id),
  cleaner_user_id text NOT NULL REFERENCES users(id),
  analysis_id uuid NOT NULL UNIQUE,
  status cleanup_status NOT NULL DEFAULT 'AWAITING_VERIFICATION',
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m double precision NOT NULL CHECK (accuracy_m BETWEEN 0 AND 50),
  captured_location_at timestamptz NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false,
  CONSTRAINT cleanup_submissions_status_ck CHECK (
    (status = 'AWAITING_VERIFICATION' AND verified_at IS NULL)
    OR (status = 'VERIFIED' AND verified_at IS NOT NULL)
  ),
  CONSTRAINT cleanup_submissions_analysis_fk FOREIGN KEY (
    analysis_id, cleaner_user_id, report_id
  ) REFERENCES ai_analyses(id, owner_user_id, report_id)
);

CREATE TABLE report_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id text NOT NULL REFERENCES users(id),
  report_id uuid REFERENCES reports(id),
  cleanup_id uuid REFERENCES cleanup_submissions(id),
  purpose photo_purpose NOT NULL,
  state photo_state NOT NULL DEFAULT 'RESERVED',
  object_key varchar(512) NOT NULL UNIQUE CHECK (btrim(object_key) <> ''),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 4),
  mime_type text NOT NULL CHECK (mime_type = 'image/jpeg'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 1048576),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  upload_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_photos_parent_state_ck CHECK (
    (state IN ('RESERVED', 'UPLOADED') AND report_id IS NULL AND cleanup_id IS NULL)
    OR (state = 'ATTACHED' AND (
      (purpose = 'REPORT' AND report_id IS NOT NULL AND cleanup_id IS NULL)
      OR (purpose = 'CLEANUP' AND report_id IS NULL AND cleanup_id IS NOT NULL)
    ))
  ),
  CONSTRAINT report_photos_report_ordinal_uq UNIQUE (report_id, ordinal),
  CONSTRAINT report_photos_cleanup_ordinal_uq UNIQUE (cleanup_id, ordinal)
);

CREATE TABLE votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES reports(id),
  stage vote_stage NOT NULL,
  voter_user_id text NOT NULL REFERENCES users(id),
  choice vote_choice NOT NULL,
  distance_m double precision NOT NULL CHECK (distance_m BETWEEN 0 AND 150),
  accuracy_m double precision NOT NULL CHECK (accuracy_m BETWEEN 0 AND 50),
  created_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false,
  CONSTRAINT votes_report_stage_voter_uq UNIQUE (report_id, stage, voter_user_id)
);

CREATE TABLE reward_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id),
  kind ledger_kind NOT NULL,
  delta integer NOT NULL CHECK (delta > 0),
  source_ref varchar(256) NOT NULL UNIQUE CHECK (btrim(source_ref) <> ''),
  report_id uuid REFERENCES reports(id),
  vote_id uuid UNIQUE REFERENCES votes(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id),
  report_id uuid NOT NULL REFERENCES reports(id),
  kind notification_kind NOT NULL,
  message varchar(500) NOT NULL CHECK (char_length(btrim(message)) BETWEEN 1 AND 500),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_user_report_kind_uq UNIQUE (user_id, report_id, kind)
);

CREATE TABLE idempotency_keys (
  user_id text NOT NULL REFERENCES users(id),
  operation varchar(100) NOT NULL CHECK (btrim(operation) <> ''),
  key varchar(200) NOT NULL CHECK (btrim(key) <> ''),
  request_hash varchar(256) NOT NULL CHECK (btrim(request_hash) <> ''),
  resource_id uuid,
  response_status smallint CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (user_id, operation, key),
  CONSTRAINT idempotency_expiry_ck CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX reports_city_status_route_idx ON reports (city_id, status, route);
CREATE INDEX reports_author_updated_idx ON reports (author_user_id, updated_at DESC);
CREATE INDEX reports_status_location_idx ON reports (status, lat, lng);
CREATE INDEX ai_analyses_input_history_idx ON ai_analyses (owner_user_id, kind, input_hash, created_at DESC);
CREATE INDEX ai_analyses_report_history_idx ON ai_analyses (report_id, created_at DESC) WHERE report_id IS NOT NULL;
CREATE INDEX cleanup_submissions_cleaner_history_idx ON cleanup_submissions (cleaner_user_id, submitted_at DESC);
CREATE INDEX votes_report_stage_choice_idx ON votes (report_id, stage, choice);
CREATE INDEX votes_voter_history_idx ON votes (voter_user_id, created_at DESC);
CREATE INDEX reward_ledger_user_history_idx ON reward_ledger (user_id, created_at DESC);
CREATE INDEX notifications_user_history_idx ON notifications (user_id, created_at DESC);
CREATE INDEX idempotency_expiry_idx ON idempotency_keys (expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON COLUMN reports.existence_verified_at IS
  'First server time the report crossed three existence YES votes; never overwritten.';
COMMENT ON COLUMN reports.last_existence_confirmed_at IS
  'Latest server-accepted existence YES time; may advance after threshold until RESOLVED.';
COMMENT ON COLUMN cleanup_submissions.lat IS
  'Private newly measured cleanup-result latitude; never include in public report DTOs.';
COMMENT ON TABLE analysis_leases IS
  'Mutable unique owner/kind/input slot points to the current attempt; ai_analyses history is intentionally non-unique by input hash.';
