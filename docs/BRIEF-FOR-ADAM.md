# 總情報頁（給 Adam · 2026-08-01）

> 一頁看完：現況、怎麼驗、兩份設計文件的入口、以及你大概會問的八個問題——每題給可執行的答案。

## 1. 現況（main = 最新）

| 東西 | 位置 | 狀態 |
|---|---|---|
| 規格總綱 | [HANDOFF-v1.md](./HANDOFF-v1.md) | 定案 |
| 管道／資料庫全圖 | [ARCHITECTURE-MAP.md](./ARCHITECTURE-MAP.md) | ✅ |
| 多角色改造方案 | [MULTI-CHARACTER-DESIGN.md](./MULTI-CHARACTER-DESIGN.md) | 提案（本頁 §3 補了它的洞） |
| 後端全功能 | `packages/backend/` | 五波移植完；驗收 **78/78**、開機煙測 **5/5** |
| 通話包（洗淨） | `packages/voice-call/` | 先讀 `PORTING-NOTES.md`；三修正待你套 |
| 後台 UI | `GET /admin` | 活調扣點／租戶／帳本 |

**怎麼驗（不用裝 Postgres，embedded 真庫）：**

```bash
cd packages/backend
npx tsx scripts/run-acceptance-embedded.ts   # 78 項端到端
npx tsx scripts/smoke-server.ts              # 真開機煙測
```

**Cloud Scheduler 四條**（都驗 `X-Cron-Secret`）：`/api/cron/nightly-memory` 每晚｜`/api/cron/fire-promises` 每分鐘｜`/api/cron/proactive-care` 每 15 分｜`/api/cron/expire-sweep` 每小時。

**卡住的（不是 code）**：商用 LINE OA 金鑰（waitin 申請中）、點數包定價（後台可調，1000點/299元是佔位）。

## 2. 五波移植了什麼（commit 對照）

1. `e242358` 記憶管線——萃取→歸題（冷啟動自動提案）→蒸餾（supersede 版本鏈）→鞏固→每輪召喚
2. `eaa62bc` 主動行為——[REMIND] 標籤+LLM 安全網、每分鐘履約（扣點→現場生成→推播）、[SCHEDULE]
3. `e130545` 夜間靈魂——每戶三層日記→夢（tomorrow_seeds）→誠實鏡子（claim vs actual）
4. `bd81249` 向量記憶＋主動關懷——PG 內 embedding（fail-closed）＋四道護欄的關懷 cron
5. `2c73443` 共讀＋後台——開書/模式/[NOTE]/進度＋/admin 單檔 UI

## 3. 你大概會問的八題（多角色動工前先讀這節）

### Q1. 「一人多角色」的唯一索引到底怎麼寫？（設計文件裡那行是佔位）

可執行版——在 `tenant_members` 冗餘 `character_id`（跟著 tenant 走，建立 membership 時由程式帶入）：

```sql
ALTER TABLE tenant_members ADD COLUMN character_id BIGINT;
UPDATE tenant_members m SET character_id = t.character_id
  FROM tenants t WHERE t.id = m.tenant_id;          -- backfill（現存戶全是慢慢）
DROP INDEX IF EXISTS tenant_members_one_active;
CREATE UNIQUE INDEX tenant_members_one_active
  ON tenant_members (user_id, character_id)
  WHERE status IN ('pending','confirmed');
```

程式側：`tenancy.createTenantForUser` / `joinByInviteCode` 寫入 membership 時帶 `character_id`。

### Q2. 多 OA 驗簽／回覆具體改哪裡？push 呼叫點有幾處？

- `routes/webhook.ts`：`POST /api/webhook/line/:slug` → boot 時把 `characters` 載成 `Map<slug,{token,secret}>` → 用該角色 secret 驗簽。
- `modules/line.ts`：全部函式加第一個參數 `token`（現在讀全域 config）。
- **push 呼叫點共 4 處**要改成「tenant → character → token」：
  `tenancy.joinByInviteCode`（通知主人）、`webhook confirmMember`（通知新成員）、
  `proactive/promises.fireDuePromises`、`proactive/care.runProactiveCare`。
  建議加一個 helper：`getCharacterToken(tenantId)`，四處共用。

### Q3. 角色的 LINE token 放 DB 還是 env？

**建議 env，命名約定**：`LINE_TOKEN__MANMAN` / `LINE_SECRET__MANMAN`、`LINE_TOKEN__KUAIKUAI`…
`characters` 表只存 slug 不存秘密。代價是開新角色要 redeploy——角色少的階段這個代價最低、
零「秘密進 DB」資安爭論。角色多了再遷 Secret Manager（介面不變）。

### Q4. `soul/character-core` 搬家會不會弄壞現有東西？

兩步零風險：① `git mv soul/character-core soul/packs/manman`（歷史保留）；
② `loader.ts` 找檔順序改成「先 `soul/packs/<slug>/`，slug=manman 且找不到時退 `soul/character-core/`」。
`biography-slots/` 不動（傳記範本 character-agnostic）。`packages/voice-call/` 的文件引用是說明性的，不影響執行。

### Q5. 誰做哪塊？（避免我們倆的 AI 撞車）

| 區塊 | 建議歸屬 | 理由 |
|---|---|---|
| schema migration＋loader per-slug＋genesis 模板化＋`lint-pack.ts`＋驗收擴充 | waitin 側 | 都在我這邊蓋的模組裡 |
| webhook `:slug` 路由＋line.ts token 參數化＋部署 | Adam 側 | 跟你的 deliverReply／voice／Cloud Run 同區 |
| 通話包三修正＋voice_id per character | Adam 側 | 本來就你的清單 |
| 角色 persona 內容（快快/大大/小小的 pack） | waitin＋AI | 內容工作不是工程工作，寫完過 lint 你不用碰 |

動工前在群組喊一聲認領，先 `git pull --rebase`。

### Q6. 一人養兩角色，點數共用嗎？

現設計**不共用**：點數掛 tenant（= 每角色每戶自己儲值、自己的帳本）。要共用就得把
`point_lots` 掛 user，帳本跟到期邏輯全要重算——不建議 v1 動。定價策略等 waitin 定案。

### Q7. 通話包跟多角色怎麼接？

先做你的三修正（generation ID／LIFF 驗證／麥克風不關），這與多角色正交。
多角色化只是參數化：`voice_id` 從 `characters.voice_id` 讀、LIFF 每 OA 開一個 app、
WS 連線帶 slug。`PORTING-NOTES.md` 的必改清單（godView 必除、tenantDb、chargeGate('voice')）不變。

### Q8. 角色包的品質誰把關？

確定性把關，不靠人肉：`scripts/lint-pack.ts`（待建，waitin 側）——
14 檔齊全＋pack.json 欄位齊全＋**平台底線未被刪改**（危機閘門 1925/1980、禁語、記憶誠實、
標籤鐵律）＋PII 掃描零命中。過 lint 才准 `INSERT INTO characters`。

## 4. 建議動工順序

1. 你先：pull → 跑兩個驗證腳本（親眼確認 78/78＋5/5）→ 讀兩份設計文件。
2. 多角色照 §3 Q5 分工並行；**慢慢的 OA 金鑰一到就先接真機**（多角色不擋單角色上線）。
3. 有異議直接改文件開 PR——文件就是共識，別在群組用嘴巴改規格。
