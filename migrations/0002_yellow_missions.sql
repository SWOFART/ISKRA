-- Conditional P1 mission schema. Runtime effects remain limited to creation, joining and announcements.
-- Report-route integrity is enforced by the composite FK; VERIFIED status is checked under lock by the service.
ALTER TABLE reports
  ADD CONSTRAINT reports_id_route_uq UNIQUE (id, route);

CREATE TABLE missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL UNIQUE,
  report_route report_route NOT NULL DEFAULT 'YELLOW',
  organizer_user_id text NOT NULL REFERENCES users(id),
  starts_at timestamptz NOT NULL,
  meeting_lat double precision NOT NULL CHECK (meeting_lat BETWEEN -90 AND 90),
  meeting_lng double precision NOT NULL CHECK (meeting_lng BETWEEN -180 AND 180),
  meeting_label varchar(160) NOT NULL CHECK (char_length(btrim(meeting_label)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status = 'OPEN'),
  announcement varchar(500) NOT NULL DEFAULT '' CHECK (char_length(announcement) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false,
  CONSTRAINT missions_report_route_yellow_ck CHECK (report_route = 'YELLOW'),
  CONSTRAINT missions_report_route_fk FOREIGN KEY (report_id, report_route)
    REFERENCES reports(id, route)
);

CREATE TABLE mission_participants (
  mission_id uuid NOT NULL REFERENCES missions(id),
  user_id text NOT NULL REFERENCES users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id, user_id)
);

CREATE INDEX missions_status_start_idx ON missions (status, starts_at);
CREATE INDEX mission_participants_user_joined_idx ON mission_participants (user_id, joined_at DESC);
