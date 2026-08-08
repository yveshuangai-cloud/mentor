-- 多角色改造（BRIEF-FOR-ADAM §3 Q1 的可執行版）。冪等：新庫跑=種角色；舊庫跑=補欄+backfill+換索引。

-- 1. 種預設角色（放 migration 不放 seed：backfill 依賴它，順序必須先於本檔後半）
INSERT INTO characters (slug, name, tagline, soul_pack)
VALUES ('manman', '慢慢', '你不需要說得完整，慢慢都會在這裡。', 'soul/packs/manman')
ON CONFLICT (slug) DO NOTHING;

-- 2. 舊戶 backfill：character_id NULL → 慢慢
UPDATE tenants SET character_id = (SELECT id FROM characters WHERE slug = 'manman')
WHERE character_id IS NULL;

UPDATE tenant_members m SET character_id = t.character_id
FROM tenants t WHERE t.id = m.tenant_id AND m.character_id IS NULL;

-- 3. 唯一索引：舊版（單 user）→ 新版（user × character）
DROP INDEX IF EXISTS tenant_members_one_active;
CREATE UNIQUE INDEX IF NOT EXISTS tenant_members_one_active_per_character
  ON tenant_members (user_id, character_id) WHERE status IN ('pending','confirmed');
