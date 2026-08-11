-- AIEQ is an isolated assessment engine. It does not write to learned_facts,
-- soul packs, character identity, or conversation memory.

CREATE TABLE IF NOT EXISTS aieq_sessions (
  id                       TEXT PRIMARY KEY,
  tenant_id                BIGINT REFERENCES tenants(id),
  user_id                  BIGINT NOT NULL REFERENCES users(id),
  instrument_version       TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'in_progress'
                           CHECK (status IN ('in_progress','paused','completed')),
  current_question_index   INTEGER NOT NULL DEFAULT 0 CHECK (current_question_index >= 0),
  result                   JSONB,
  personalization_consent  BOOLEAN NOT NULL DEFAULT FALSE,
  consent_granted_at       TIMESTAMPTZ,
  started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at             TIMESTAMPTZ,
  CHECK (
    (personalization_consent = FALSE AND consent_granted_at IS NULL)
    OR (personalization_consent = TRUE AND consent_granted_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS aieq_sessions_by_user
  ON aieq_sessions (tenant_id, user_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS aieq_one_open_session_per_user
  ON aieq_sessions (user_id) WHERE status IN ('in_progress','paused');

-- Append-only input log. event_id is supplied by the channel adapter and is the
-- idempotency boundary for duplicate LINE postbacks or webhook retries.
CREATE TABLE IF NOT EXISTS aieq_answer_events (
  event_id                   TEXT PRIMARY KEY,
  session_id                 TEXT NOT NULL REFERENCES aieq_sessions(id),
  source                     TEXT NOT NULL CHECK (source IN ('card','free_text','system')),
  kind                       TEXT NOT NULL
                             CHECK (kind IN ('answer','uncertain','skip','back','pause','resume')),
  question_id                TEXT,
  option_id                  TEXT,
  raw_text                   TEXT,
  interpretation_confidence  NUMERIC(4,3)
                             CHECK (interpretation_confidence BETWEEN 0 AND 1),
  payload                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at                TIMESTAMPTZ NOT NULL,
  received_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aieq_events_by_session
  ON aieq_answer_events (session_id, occurred_at, received_at);

-- Current projection for fast resume/scoring. Back-navigation changes this
-- projection but never deletes the append-only event evidence above.
CREATE TABLE IF NOT EXISTS aieq_answers (
  session_id                 TEXT NOT NULL REFERENCES aieq_sessions(id),
  question_id                TEXT NOT NULL,
  source_event_id            TEXT NOT NULL REFERENCES aieq_answer_events(event_id),
  option_id                  TEXT,
  interpretation_confidence  NUMERIC(4,3) NOT NULL DEFAULT 1
                             CHECK (interpretation_confidence BETWEEN 0 AND 1),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, question_id)
);

COMMENT ON TABLE aieq_sessions IS
  'Independent AIEQ assessment state; never treated as soul identity or permanent memory without consent.';
COMMENT ON COLUMN aieq_sessions.personalization_consent IS
  'Explicit opt-in allowing a separate integration layer to use the result for communication personalization.';

-- The confirmed profile is deliberately separate from both the raw result and
-- Mantou memory. A result only appears socially after explicit confirmation.
CREATE TABLE IF NOT EXISTS aieq_profiles (
  user_id             BIGINT PRIMARY KEY REFERENCES users(id),
  session_id          TEXT NOT NULL REFERENCES aieq_sessions(id),
  type_code           TEXT NOT NULL CHECK (type_code ~ '^[EISNTFJPX]{4}$'),
  animal_slug         TEXT NOT NULL,
  visibility          TEXT NOT NULL DEFAULT 'private'
                      CHECK (visibility IN ('private','friends')),
  confirmed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS aieq_friend_invites (
  token               TEXT PRIMARY KEY,
  inviter_user_id     BIGINT NOT NULL REFERENCES users(id),
  expires_at          TIMESTAMPTZ NOT NULL,
  claimed_by_user_id  BIGINT REFERENCES users(id),
  claimed_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (claimed_by_user_id IS NULL AND claimed_at IS NULL)
    OR (claimed_by_user_id IS NOT NULL AND claimed_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS aieq_friend_invites_by_inviter
  ON aieq_friend_invites (inviter_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS aieq_friendships (
  user_low_id         BIGINT NOT NULL REFERENCES users(id),
  user_high_id        BIGINT NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_low_id, user_high_id),
  CHECK (user_low_id < user_high_id)
);
CREATE INDEX IF NOT EXISTS aieq_friendships_by_high ON aieq_friendships (user_high_id);
