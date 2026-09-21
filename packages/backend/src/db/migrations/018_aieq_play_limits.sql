-- Persistent anti-abuse counter. Replay removes assessment/social data, but this
-- small counter survives so the same LINE user cannot bypass the three-play cap.
CREATE TABLE IF NOT EXISTS aieq_play_limits (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id),
  play_count  INTEGER NOT NULL DEFAULT 0 CHECK (play_count BETWEEN 0 AND 3),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Existing players have already used at least one play. Historical replay data
-- was deleted by the old flow, so one is the only defensible backfill.
INSERT INTO aieq_play_limits (user_id, play_count)
SELECT DISTINCT user_id, 1 FROM aieq_sessions
ON CONFLICT (user_id) DO NOTHING;

COMMENT ON TABLE aieq_play_limits IS
  'Lifetime AI Personality play count per LINE user; retained across replay deletion, capped at three.';
