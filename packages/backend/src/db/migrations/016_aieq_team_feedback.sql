-- 團隊反饋 (team feedback). During the test period, team members press the
-- 「團隊回報小標籤」 on key screens of the LIFF. Rows are only written when
-- AIEQ_TEAM_FEEDBACK=true; production never sets the flag, so the table stays
-- empty there. The reporter's LINE identity is kept on purpose: the event team
-- wants to know who said what. Deleting a player's quiz data does not touch
-- this table, because the rows are the team's notes, not the player's result.
CREATE TABLE IF NOT EXISTS aieq_team_feedback (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT REFERENCES users(id) ON DELETE SET NULL,
  line_user_id       TEXT NOT NULL,
  display_name       TEXT,
  picture_url        TEXT,
  -- Which screen: intro | question:<question id> | result:story | result:radar | result:cover | result:share | friends
  spot               TEXT NOT NULL,
  verdict            TEXT NOT NULL CHECK (verdict IN ('good','issue','other')),
  comment            TEXT,
  type_code          TEXT,
  session_id         TEXT,
  instrument_version TEXT,
  user_agent         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aieq_team_feedback_spot_idx ON aieq_team_feedback (spot, created_at DESC);
CREATE INDEX IF NOT EXISTS aieq_team_feedback_reporter_idx ON aieq_team_feedback (line_user_id, created_at DESC);
COMMENT ON TABLE aieq_team_feedback IS '團隊反饋：測試期間團隊成員在各關鍵畫面按「團隊回報小標籤」留下的意見（good=規劃得很好, issue=規劃有問題, other=其他意見）。';
