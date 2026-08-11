CREATE TABLE IF NOT EXISTS turn_events (
  id              BIGSERIAL PRIMARY KEY,
  event_id        UUID NOT NULL UNIQUE,
  turn_id         UUID NOT NULL,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
  user_id         BIGINT NOT NULL REFERENCES users(id),
  conversation_id BIGINT REFERENCES conversations(id),
  channel         TEXT NOT NULL CHECK (channel IN (
    'line_text', 'line_audio', 'line_image', 'line_document',
    'websocket_voice', 'livekit_voice'
  )),
  direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'internal', 'outbound')),
  event_type      TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  elapsed_ms      INTEGER NOT NULL CHECK (elapsed_ms >= 0),
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS turn_events_by_turn ON turn_events (tenant_id, turn_id, occurred_at);
CREATE INDEX IF NOT EXISTS turn_events_by_channel ON turn_events (tenant_id, channel, occurred_at DESC);
CREATE INDEX IF NOT EXISTS turn_events_by_conversation ON turn_events (conversation_id) WHERE conversation_id IS NOT NULL;
