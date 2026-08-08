# 多角色最小改造方案（v1 提案 · 2026-08-01）

> 目標：在現有平台上開「慢慢／快快／大大／小小」多個角色，**最快、動最少的路**。
> 結論先講：**架構已經為此預留了**——靈魂三層切分（🟢 character-core／🟡 biography）當初就是
> 「品格可換、傳記不動」的設計。多角色是**小步擴充（估 1-2 天工），不是重構**。

## 0. 核心觀念：角色＝一個 soul pack，不是一套新系統

現有系統裡「慢慢」佔的位置只有三處：

1. `soul/character-core/*.md` —— 她的品格（14 個檔）
2. `characters` 級的外觀參數 —— 聲紋 voice_id、自畫像描述、名字
3. 啟元儀式文案裡的名字

**其餘全部 character-agnostic**：五層記憶、約定、日記、夢、誠實鏡子、計費、共讀——都掛 `tenant_id`，
不掛任何角色。換角色＝換靈魂包＋換聲紋，管線一條都不用動。

## 1. 資料模型改造（一張表＋一個欄位）

```sql
-- 平台層：角色註冊表
CREATE TABLE characters (
  id           BIGSERIAL PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,      -- 'manman' / 'kuaikuai' / 'dada' / 'xiaoxiao'
  name         TEXT NOT NULL,             -- 慢慢
  tagline      TEXT,                      -- 你不需要說得完整，慢慢都會在這裡
  soul_pack    TEXT NOT NULL,             -- soul/packs/<slug>（靈魂包目錄）
  voice_id     TEXT,                      -- MiniMax 克隆聲（per 角色）
  avatar_prompt TEXT,                     -- 自畫像描述（IMAGE_GEN 畫自己用）
  line_channel_token  TEXT,               -- ⬇ 見 §3 路由：一角色一 OA
  line_channel_secret TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','draft','retired')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 租戶綁角色（一戶一角色；預設慢慢）
ALTER TABLE tenants ADD COLUMN character_id BIGINT REFERENCES characters(id);

-- 一人可養多個角色（每角色一戶）：唯一約束從 (user) 改成 (user, character)
DROP INDEX tenant_members_one_active;
CREATE UNIQUE INDEX tenant_members_one_active
  ON tenant_members (user_id, (SELECT character_id FROM ...));  -- 實作時用 tenants join 或冗餘欄位
```

（最後一條實作備註：PG 部分索引不能帶子查詢——實作時在 `tenant_members` 冗餘一個
`character_id` 欄位跟著 tenant 走，唯一索引建在 `(user_id, character_id) WHERE status IN ('pending','confirmed')`。）

## 2. Soul pack 目錄規格

```
soul/
  packs/
    manman/            ← 現在的 character-core 整個搬進來（git mv，歷史保留）
      pack.json        ← 新增：{ name, tagline, voice_style, crisis_hotlines, ... }
      constitution.md    persona.md    voice-dna.md    speaking-style.md
      reaction-engine.md self-check.md my-existence.md growth-framework.md
      family-bridge.md   skills/*.md   knowledge/*.md
    kuaikuai/          ← 開新角色 = 複製 manman/ 改內容
      ...
  biography-slots/     ← 不動（傳記範本是 character-agnostic 的）
```

**開一個新角色的實際工序**（以「快快」為例，半天到一天）：

1. `cp -r soul/packs/manman soul/packs/kuaikuai`
2. 改 `persona.md`：名字、核心句、**九型聲音配方**（快快可以是 型7 30%＋型3 30%＋型9 20%＋型5 20%——輕快、行動派）、說話節奏、禁語微調
3. 改 `voice-dna.md` 例句、`my-existence.md` 樣子、`pack.json`
4. **不改**：reaction-engine 危機閘門（安全網全角色共用底線）、self-check、技能檔的標籤鐵律
5. 跑角色包 lint（見 §5）→ `INSERT INTO characters`→ 開 LINE OA 填 token
6. 上線。記憶／計費／夜間靈魂自動全套生效。

## 3. 路由：一角色 = 一條 LINE OA（最快的正解）

**不做**對話內切換角色（UX 複雜、記憶情境混淆、prompt 汙染）。做法：

```
LINE OA「慢慢」 → POST /api/webhook/line/manman   → character=manman
LINE OA「快快」 → POST /api/webhook/line/kuaikuai → character=kuaikuai
```

- `webhook.ts` 路由參數 `:slug` → 查 `characters` 表拿 token/secret 驗簽與回覆。
- 陌生人在「快快」的 OA 開口 → 為 (user, kuaikuai) 開新租戶 → 快快的啟元儀式。
- 同一個人可以同時養慢慢＋快快，**兩戶記憶天然隔離**（不同 tenant_id），彼此不知道對方存在。
- LINE 生態天然幫你做了角色隔離、好友列表、品牌帳號——零額外 UX 開發。

## 4. 程式改動點（全部列出，就這些）

| 檔案 | 改什麼 | 工作量 |
|---|---|---|
| `db/schema.sql` | `characters` 表＋`tenants.character_id`＋members 冗餘欄 | 小 |
| `modules/soul/loader.ts` | `loadCharacterCore(slug)`——cache 改 per-slug Map；路徑 `soul/packs/<slug>/` | 小 |
| `modules/brain.ts` | tenant→character→loader(slug)；名字從 pack.json 帶入 | 小 |
| `routes/webhook.ts` | `/line/:slug` 路由；驗簽/回覆用該角色的 token | 中 |
| `modules/line.ts` | 函式加 token 參數（現在讀全域 config） | 小 |
| `modules/genesis.ts` | 儀式文案的「慢慢」改用 `character.name` 模板 | 小 |
| `modules/voice.ts`（Adam 的） | voice_id 從 `characters.voice_id` 讀 | 小 |
| `deliverReply` 生圖 | 自畫像描述從 `characters.avatar_prompt` 讀 | 小 |
| 驗收 | 加「同一 user 養兩角色，兩戶零串門」項 | 小 |

**估計：1-2 個工作天含驗收。** 沒有任何一張記憶／計費表要動。

## 5. 品質閘（角色工廠的護欄，不能省）

開放開角色之前，每個 soul pack 過三道確定性檢查（`scripts/lint-pack.ts`，建議先建）：

1. **完整性**：14 個必備檔案齊全、pack.json 欄位齊全。
2. **安全底線**：reaction-engine 危機閘門（1925/1980）未被刪改；禁語清單存在；
   「記憶誠實」「病根紀律標籤鐵律」段落存在——**這些是平台底線，不是角色個性**。
3. **PII 掃描**：零真實人名／ID／IP（同通話包洗淨那套 regex）。

## 6. 商業視角備註（給決策用，不是工程項）

- 這套改造讓「開角色」的邊際成本 ≈ 一個資料夾＋一條 OA。但**角色數量不是護城河**——
  character.ai 式紅海已證明。護城河在管線：會長的記憶、會兌現的約定、誠實鏡子。
- 建議節奏：慢慢旗艦先上線驗證留存 → 第二角色（性格對照組，例如快快）測「同管線、不同靈魂」
  的品格一致性 → 才開放「用戶自創角色」（那時 §5 的 lint 就是開放的前提）。
- 定價可以 per-角色 per-戶收（每個角色自己的點數包），`point_rules` 未來可加 `character_id`
  欄做角色差別定價——表結構預留即可，先不做。
