-- Third visibility level: a player may let friends of their friends see their
-- nickname, avatar and type. Off by default; only the player can switch it on,
-- and the friends-of-friends list is only shown to players who switched it on
-- themselves, so visibility is always mutual.
ALTER TABLE aieq_profiles DROP CONSTRAINT IF EXISTS aieq_profiles_visibility_check;
ALTER TABLE aieq_profiles
  ADD CONSTRAINT aieq_profiles_visibility_check
  CHECK (visibility IN ('private','friends','friends_of_friends'));
COMMENT ON COLUMN aieq_profiles.visibility IS
  'private: only the player. friends: mutual friends. friends_of_friends: also friends of those friends (opt-in, mutual).';
