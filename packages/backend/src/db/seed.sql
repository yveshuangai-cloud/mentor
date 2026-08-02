-- 預設扣點規則（交接書 §7 的提案值；上線後由後台調，這裡只是初始值）
INSERT INTO point_rules (gate, cost, enabled, description, updated_by) VALUES
  ('text',       1,  TRUE, '純文字回覆（LLM 動腦）',        'seed'),
  ('voice',      5,  TRUE, '克隆聲語音（TTS 真金）',        'seed'),
  ('image',      20, TRUE, '生圖／手寫卡片（最貴）',        'seed'),
  ('web_search', 2,  TRUE, '聯網查資料/新聞（加值，疊加於 text）', 'seed'),
  ('proactive',  1,  TRUE, '主動關懷推播',                  'seed'),
  ('vision',     2,  TRUE, '讀圖／讀 PDF（多模態直連 API）',  'seed')
ON CONFLICT (gate) DO NOTHING;

-- 平台預設設定
INSERT INTO system_settings (key, value) VALUES
  ('point_package_default', '{"points": 1000, "expire_days": 90}'),
  ('proactive_outreach_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
