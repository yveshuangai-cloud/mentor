-- LINE 靈魂校準權限：只認原始 LINE User ID 白名單同步出的布林值，
-- 不認 display_name、OA Manager chat id 或使用者自行宣稱的身份。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS can_shape_soul BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN users.can_shape_soul IS
  'May provide persistent persona/soul corrections; synchronized from Secret Manager LINE ID allowlist.';
