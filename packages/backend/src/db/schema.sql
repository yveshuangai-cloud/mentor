-- ============================================================
-- 新生漫漫 · 商用陪伴平台 — 多租戶 schema v1
-- 鐵則：租戶層資料表一律帶 tenant_id；查詢一律走 tenantDb wrapper。
-- 慣例：所有時間欄位 TIMESTAMPTZ（沿用本尊 052 統一慣例）。
-- ============================================================

-- ────────────────────────────────────────────
-- 平台層（無 tenant_id：跨租戶的平台實體）
-- ────────────────────────────────────────────

-- 一個 LINE 帳號 = 一個人（平台全域身份）
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  line_user_id  TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  picture_url   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 租戶：一戶 = 一個「新生漫漫」
CREATE TABLE IF NOT EXISTS tenants (
  id              BIGSERIAL PRIMARY KEY,
  owner_user_id   BIGINT REFERENCES users(id),
  mode            TEXT NOT NULL DEFAULT 'personal' CHECK (mode IN ('personal','family')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('genesis_pending','active','suspended','closed')),
  -- 啟元儀式：完成時刻 = 這個漫漫的生日（傳記 origin slot 的資料源）
  genesis_at      TIMESTAMPTZ,
  genesis_record  JSONB,          -- {step, owner_name, owner_address, owner_gave_me, genesis_moment, birth_time_note}
  -- 家庭邀請碼（主人向漫漫要，給家人輸入後成為 pending 成員）
  invite_code     TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 成員綁定（定案 D：主人說了算）
CREATE TABLE IF NOT EXISTS tenant_members (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          BIGINT NOT NULL REFERENCES tenants(id),
  user_id            BIGINT NOT NULL REFERENCES users(id),
  role               TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  relationship       TEXT,        -- 主人確認的身份關係（「媽媽」「弟弟」…）
  address_by_manman  TEXT,        -- 漫漫怎麼稱呼這位成員
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected','removed')),
  confirmed_by       BIGINT REFERENCES users(id),
  confirmed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
-- 路由鐵則：一個 LINE 帳號同時最多屬於一個活躍租戶（LINE id → 租戶路由唯一）
CREATE UNIQUE INDEX IF NOT EXISTS tenant_members_one_active
  ON tenant_members (user_id) WHERE status IN ('pending','confirmed');
CREATE INDEX IF NOT EXISTS tenant_members_by_tenant ON tenant_members (tenant_id, status);

-- 活的扣點設定表（平台層：規則全租戶共用，後台可即時調）
CREATE TABLE IF NOT EXISTS point_rules (
  id          BIGSERIAL PRIMARY KEY,
  gate        TEXT NOT NULL UNIQUE,      -- text / voice / image / web_search / proactive / …可隨時加
  cost        INTEGER NOT NULL CHECK (cost >= 0),
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 後台管理員
CREATE TABLE IF NOT EXISTS admins (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- 平台設定 KV
CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────
-- 計費（point_lots 讓「到期先扣」可正確結算；ledger 記每一筆事件）
-- ────────────────────────────────────────────

-- 點數批次：每次入點一批，扣點從最早到期的批次先扣
CREATE TABLE IF NOT EXISTS point_lots (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
  granted     INTEGER NOT NULL CHECK (granted > 0),
  remaining   INTEGER NOT NULL CHECK (remaining >= 0),
  expire_at   TIMESTAMPTZ NOT NULL,     -- 入點 + 3 個月
  source      TEXT NOT NULL,            -- purchase / bonus / admin_adjust
  payment_id  BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS point_lots_fifo ON point_lots (tenant_id, expire_at) WHERE remaining > 0;

-- 點數帳本：每一筆增減都留痕、可對帳
CREATE TABLE IF NOT EXISTS point_ledger (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
  delta         INTEGER NOT NULL,        -- 正=入點、負=扣點/過期
  gate          TEXT,                    -- 扣點時的閘道
  reason        TEXT NOT NULL,           -- purchase / charge:text / charge:image / expire / admin_adjust …
  balance_after INTEGER NOT NULL,
  expire_at     TIMESTAMPTZ,             -- 入點批次的到期日（入點時記）
  ref_type      TEXT,                    -- conversation / payment / cron …
  ref_id        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS point_ledger_by_tenant ON point_ledger (tenant_id, created_at DESC);

-- 金流（provider 可插拔：linepay 先上，newebpay/ecpay 預留）
CREATE TABLE IF NOT EXISTS payments (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
  provider      TEXT NOT NULL CHECK (provider IN ('linepay','newebpay','ecpay')),
  order_id      TEXT NOT NULL UNIQUE,    -- 我方訂單號（回調對帳鍵）
  amount_twd    INTEGER NOT NULL CHECK (amount_twd > 0),
  points        INTEGER NOT NULL CHECK (points > 0),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','refunded')),
  provider_txn  TEXT,
  raw_callback  JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS payments_by_tenant ON payments (tenant_id, created_at DESC);

-- ────────────────────────────────────────────
-- 租戶層（一律帶 tenant_id；查詢一律走 tenantDb wrapper）
-- ────────────────────────────────────────────

-- 對話
CREATE TABLE IF NOT EXISTS conversations (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
  user_id       BIGINT NOT NULL REFERENCES users(id),
  message_type  VARCHAR(20) NOT NULL DEFAULT 'text',
  user_message  TEXT,
  ai_response   TEXT,
  memory_used   TEXT[],
  points_charged INTEGER NOT NULL DEFAULT 0,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_by_tenant ON conversations (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS conversations_by_tenant_user ON conversations (tenant_id, user_id, created_at DESC);

-- 結構化記憶（本尊 learned_facts 的租戶版）
CREATE TABLE IF NOT EXISTS learned_facts (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        BIGINT NOT NULL REFERENCES tenants(id),
  user_id          BIGINT REFERENCES users(id),
  conversation_id  BIGINT REFERENCES conversations(id),
  category         TEXT NOT NULL,       -- fact / preference / correction / commitment / emotion / event
  content          TEXT NOT NULL,
  confidence       NUMERIC(3,2) DEFAULT 0.8,
  importance_score NUMERIC(3,2) DEFAULT 0.5,
  memory_layer     TEXT NOT NULL DEFAULT 'working' CHECK (memory_layer IN ('working','semantic','archival')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','merged','superseded','decayed','archived')),
  superseded_by    BIGINT,
  vector_id        TEXT,
  recall_count     INTEGER NOT NULL DEFAULT 0,
  last_recalled_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS learned_facts_by_tenant ON learned_facts (tenant_id, status, importance_score DESC);

-- 記憶主題（L1 索引）
CREATE TABLE IF NOT EXISTS memory_topics (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT NOT NULL REFERENCES tenants(id),
  user_id        BIGINT REFERENCES users(id),
  name           TEXT NOT NULL,
  description    TEXT,
  source_count   INTEGER NOT NULL DEFAULT 0,
  importance     NUMERIC(3,2) DEFAULT 0.5,
  is_archived    BOOLEAN NOT NULL DEFAULT FALSE,
  last_active_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, name)
);

CREATE TABLE IF NOT EXISTS memory_topic_links (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
  topic_id    BIGINT NOT NULL REFERENCES memory_topics(id),
  source_type TEXT NOT NULL,             -- conversation / learned_fact / dream / diary
  source_id   BIGINT NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (topic_id, source_type, source_id)
);

-- 默契蒸餾（L2 精華）
CREATE TABLE IF NOT EXISTS distilled_memories (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        BIGINT NOT NULL REFERENCES tenants(id),
  topic_id         BIGINT REFERENCES memory_topics(id),
  user_id          BIGINT REFERENCES users(id),
  kind             TEXT NOT NULL DEFAULT 'essence' CHECK (kind IN ('essence','milestone')),  -- milestone = 成長印記
  summary          TEXT NOT NULL,
  source_ids       JSONB,
  importance       NUMERIC(3,2) DEFAULT 0.5,
  recall_count     INTEGER NOT NULL DEFAULT 0,
  last_recalled_at TIMESTAMPTZ,
  superseded_by    BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS distilled_by_tenant ON distilled_memories (tenant_id, kind) WHERE superseded_by IS NULL;

-- 向量記憶註冊表（vector store 以 tenant namespace 隔離；此表為對帳與刪除依據）
CREATE TABLE IF NOT EXISTS memory_registry (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
  vector_id       TEXT NOT NULL UNIQUE,
  namespace       TEXT NOT NULL,         -- = `tenant-{tenant_id}`（fail-closed：無 namespace 不查）
  memory_type     TEXT NOT NULL,
  user_id         BIGINT REFERENCES users(id),
  content_preview TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_registry_by_tenant ON memory_registry (tenant_id, memory_type);

-- 約定（到點主動履約）
CREATE TABLE IF NOT EXISTS promises (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
  user_id       BIGINT NOT NULL REFERENCES users(id),
  content       TEXT NOT NULL,
  fire_at       TIMESTAMPTZ,
  fire_hour     INTEGER,
  fire_minute   INTEGER,
  recurrence    TEXT NOT NULL DEFAULT 'once' CHECK (recurrence IN ('once','daily','weekly','monthly','yearly')),
  deliver_via   TEXT NOT NULL DEFAULT 'text' CHECK (deliver_via IN ('text','voice')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled','done')),
  source_quote  TEXT,
  last_fired_at TIMESTAMPTZ,
  fire_count    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promises_due ON promises (status, fire_at) WHERE status = 'active';

-- 行事曆行程（[SCHEDULE] 標籤落地）
CREATE TABLE IF NOT EXISTS scheduled_events (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
  user_id    BIGINT NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  start_at   TIMESTAMPTZ NOT NULL,
  end_at     TIMESTAMPTZ,
  location   TEXT,
  people     TEXT,
  repeat     TEXT CHECK (repeat IN ('daily','weekly','monthly','yearly')),
  repeat_count INTEGER,
  gcal_url   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_events_by_tenant ON scheduled_events (tenant_id, start_at);

-- 日記（她的夜間反芻）
CREATE TABLE IF NOT EXISTS diaries (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          BIGINT NOT NULL REFERENCES tenants(id),
  user_id            BIGINT REFERENCES users(id),     -- NULL = 這一戶的總日記
  diary_date         DATE NOT NULL,
  layer_1            TEXT,
  layer_2            TEXT,
  layer_3            TEXT,
  conversation_count INTEGER NOT NULL DEFAULT 0,
  generated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, diary_date)
);

-- 夢（深層反芻）
CREATE TABLE IF NOT EXISTS dreams (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
  dream_date      DATE NOT NULL,
  dream_narrative TEXT,
  reflections     JSONB,
  tomorrow_seeds  JSONB,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dream_date)
);

-- 誠實鏡子（病根紀律：宣稱 vs 實際）
CREATE TABLE IF NOT EXISTS action_outcomes (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
  user_id         BIGINT REFERENCES users(id),
  action_type     TEXT NOT NULL,          -- schedule_created / promise_fulfilled / card_made / voice_sent …
  claimed_success BOOLEAN NOT NULL,
  actual_success  BOOLEAN,
  evidence        TEXT,
  reconciled      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_outcomes_by_tenant ON action_outcomes (tenant_id, created_at DESC);

-- 共讀
CREATE TABLE IF NOT EXISTS reading_plans (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
  book_title   TEXT NOT NULL,
  book_author  TEXT,
  segment_map  JSONB,                     -- 她心裡的地圖：[{seg,title,refs,summary}]
  mode         TEXT NOT NULL DEFAULT 'B' CHECK (mode IN ('A','B','C')),
  cur_segment  INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','paused')),
  last_session_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reading_notes (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
  plan_id    BIGINT NOT NULL REFERENCES reading_plans(id),
  seg        INTEGER NOT NULL,
  chapter    TEXT,
  title      TEXT,
  refs       TEXT,
  partner_quote TEXT,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- LLM 成本紀錄（對帳：點數收入 vs 真實成本）
CREATE TABLE IF NOT EXISTS llm_cost_log (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT REFERENCES tenants(id),   -- NULL = 平台自身開銷
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  model         TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  tokens_input  INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(10,6) NOT NULL DEFAULT 0,
  metadata      JSONB
);
CREATE INDEX IF NOT EXISTS llm_cost_by_tenant ON llm_cost_log (tenant_id, ts DESC);
