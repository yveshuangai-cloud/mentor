-- Claiming an invite only records intent. A friendship is created later, in
-- the same transaction that confirms the recipient's assessment result.

ALTER TABLE aieq_friend_invites
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'issued';

UPDATE aieq_friend_invites
SET status = CASE WHEN claimed_by_user_id IS NULL THEN 'issued' ELSE 'accepted' END
WHERE status = 'issued';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'aieq_friend_invites_status_check'
  ) THEN
    ALTER TABLE aieq_friend_invites
      ADD CONSTRAINT aieq_friend_invites_status_check
      CHECK (status IN ('issued','claimed','accepted','expired'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS aieq_pending_invites_by_recipient
  ON aieq_friend_invites (claimed_by_user_id, status)
  WHERE status = 'claimed';
