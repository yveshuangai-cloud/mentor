-- Durable LINE webhook inbox + payment credit idempotency.

CREATE TABLE IF NOT EXISTS line_webhook_events (
  event_id        TEXT PRIMARY KEY,
  message_id      TEXT,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','retry','processed','dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at       TIMESTAMPTZ,
  processed_at    TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS line_webhook_message_once
  ON line_webhook_events (message_id) WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS line_webhook_events_due
  ON line_webhook_events (next_attempt_at, created_at)
  WHERE status IN ('pending','retry','processing');

CREATE UNIQUE INDEX IF NOT EXISTS point_lots_one_per_payment
  ON point_lots (payment_id) WHERE payment_id IS NOT NULL;
