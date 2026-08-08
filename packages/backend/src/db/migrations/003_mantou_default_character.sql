-- 饅頭專用 OA：新增正式角色；原 manman pack 保留為平台來源參考，不再是新戶預設。
INSERT INTO characters (slug, name, tagline, soul_pack, status)
VALUES ('mantou', '饅頭', '先把真正的問題看清楚，再找一條能落地的路。', 'soul/packs/mantou', 'active')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  tagline = EXCLUDED.tagline,
  soul_pack = EXCLUDED.soul_pack,
  status = 'active';

UPDATE characters SET status = 'draft' WHERE slug = 'manman';
