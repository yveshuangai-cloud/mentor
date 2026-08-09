CREATE TABLE IF NOT EXISTS voice_call_sessions (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
  session_id   UUID NOT NULL UNIQUE,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'connected'
               CHECK (status IN ('connected', 'ended', 'failed')),
  turn_count   INTEGER NOT NULL DEFAULT 0,
  close_reason TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_call_sessions_by_tenant_user
  ON voice_call_sessions (tenant_id, user_id, started_at DESC);
