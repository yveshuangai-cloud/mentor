# AI Personality｜AI 人格誌 架構檢視（2026-09-18）

範圍：`packages/backend/src/modules/aieq/*`、`routes/aieq.ts`、`routes/webhook.ts` 的 AIEQ 分支、migration 013–015、`public/aieq.html`。
方法：讀 schema 與程式，量規模（後端 AIEQ 相關約 2,380 行；前端單檔 35 KB＝CSS 14 KB＋JS 18 KB、32 個函式）、對照測試（91 個單元＋integration＋權重模擬）與線上行為。

## 總評

**合理、健康，完整度約七成五。** 核心（資料模型、計分、狀態機、產品護欄）是紮實的，適合協會測試與活動規模；不足的是「題庫版本化」「營運衛生」「前端可維護性」三塊，都有明確解法，沒有需要推倒重來的地方。

## 做得對的地方

1. **答題用事件溯源。** `aieq_answer_events` 以 `event_id` 為主鍵，天然去重；`aieq_answers` 是由事件推導的現況；狀態轉換在交易內以 `FOR UPDATE` 鎖定。重送、連點、LINE 重試都不會重複計分，integration 測試有驗證。
2. **產品護欄寫進 schema。** 結果（`aieq_sessions.result`）與「確認後的社交身分」（`aieq_profiles`）是兩張表；可見範圍以 `CHECK` 限制三級；朋友關係以 `(low, high)` 正規化成唯一一列；邀請有到期與狀態。「確認≠公開≠個人化」不是靠前端記得，而是靠資料結構。
3. **一人只能有一個進行中 session** 由部分唯一索引保證，不靠程式碼自律。
4. **存取範圍正確。** 每個 session 讀寫都帶 `user_id`；身分由伺服器向 LINE 驗證 ID token；demo 身分在 production 硬性關閉並有測試。
5. **刪除完整。** `deleteAieqData` 涵蓋 profiles、invites、friendships、answers、events、sessions 六張表；`users` 是平台層資料，保留是對的。
6. **計分是純函式**，可窮舉模擬；契約與偏誤都有測試把關，改權重會被擋下。
7. **模組切分清楚**：questions／scoring／stateMachine／repository／routes／flex／channel／auth 各司其職，最大檔 370 行。
8. **前端雖是單檔，紀律在**：7 處 `innerHTML` 寫入對應 35 次 `safe()` 轉義，狀態集中在一個全域物件。

## 需要改的地方（依風險排序）

### 1. 結果有兩個真相來源，且題庫沒有版本分流（高）

`aieq_sessions.result` 在完成時寫入 JSONB，但顯示時一律用 `scoreAssessment(session)` 以**現行題庫**重算，存下來的值只在 `getProfile` 被帶出、沒人用。`instrument_version` 有存、沒有任何邏輯讀它。後果：題庫或權重一改，所有歷史結果同時變動；Eve 哥的八題定稿時會直接踩到。

建議：建立以 `instrumentVersion` 為鍵的題庫登錄表，`present()` 與 `channel` 依 session 版本取題庫計分；新 session 才用最新版。或退一步：完成後的 session 直接回傳儲存的 `result`，只有進行中的才即時計分。中等工作量，**必須排在下一次題庫變動之前**。

### 2. ID token 快取沒有淘汰機制（中）

`auth.ts` 的 `Map` 以 ID token 為鍵；LINE 的 token 約每小時輪換，每次新 token 都新增一筆、過期也不移除。單機記憶體會隨登入次數線性成長。活動規模不會炸，但是漏洞。修法很小：寫入時順手清掉過期項並設上限。

### 3. 沒有任何限流（中）

`POST /friend-invites`、`/sessions/:id/events`、`/api/csp-report` 都可無限呼叫。邀請每次新增一列且七天有效，可被灌爆。建議：同一使用者七天內重用未過期的邀請、事件端點每分鐘限次、CSP 回報限流。低工作量。

### 4. 沒有營運指標（中，對活動特別重要）

只有 Fastify 請求紀錄。開始／答完／確認／分享／受邀接受／成為朋友的漏斗，目前只能翻 log。建議加一個以 token 保護的統計端點或每日 SQL 查詢；資料都在（sessions.status、profiles、invites.status、friendships），只是沒有出口。低工作量，協會測試期間就有用。

### 5. 前端單檔即將到達可維護上限（中）

35 KB、32 個函式、CSS 與 JS 都內嵌，沒有建置也沒有單元測試；雷達幾何、傾向文字、加好友規則、暱稱截斷都是可測的純邏輯卻沒測。建議：拆成 `aieq.css`／`aieq.js` 靜態檔（不需要 build step，Fastify static 已在）；純邏輯抽成小模組用 vitest 測；流程用 Playwright。中等工作量，可分次做。

### 6. Webhook 是饅頭的 684 行處理器插入 AIEQ 分支（中）

`AIEQ_ONLY_WEBHOOK` 是務實的止血，但 AI 人格誌的訊息處理仍寄生在饅頭的租戶、啟元、LLM 流程裡。建議：獨立成 `aieq` 自己的 webhook plugin，依部署角色掛載；饅頭與人格誌各自演進互不影響。中等工作量。

### 7. 小型技術債（低）

- `aieq_answer_events.payload` 與 `aieq_sessions.result` 目前都是寫了沒用的欄位；第 1 項決定後擇一清理。
- migration 編號跳過 011、012；無害，但新進者會疑惑，補一行說明即可。
- 邀請不會自動標為 `expired`（只在查詢時比對 `expires_at`），事件表無上限；加一個定期清理的 cron 路由（平台已有 cron 路由的模式）。
- integration 測試不在 `npm test` 裡，Docker 建置只跑單元；可把 integration 納入建置或 CI。
- `tenant_id` 在 AIEQ 專用部署永遠是 NULL；多租戶語意未定義，先明文寫下「AIEQ 不分租戶」。
- `users` 表由饅頭與 AIEQ 共用，AIEQ 登入會更新 `display_name`／`picture_url`；可接受，但要在文件標明這是跨產品耦合點。

## 不需要改的

- 沒有 `ON DELETE CASCADE`：刪除由程式明確處理，比隱式串聯更可控。
- 連線池上限 10：Railway 單實例足夠。
- 安全標頭與 CSP：已上線（CSP 為 report-only，待團隊測試後轉強制）。

## 進度（2026-09-18 晚間）

- 第 2、3、4 項已完成並上線 staging（commit `a94dbe1`、`9e91e78`）：ID token 快取上限 5,000 並淘汰過期；建立 session／答題事件／可見範圍／邀請／接受邀請依使用者限流，CSP 回報依 IP 限流（Fastify 開啟 `trustProxy` 才能在 Railway 後面取得真實客戶端 IP）；重複分享重用同一條有效邀請連結；`GET /api/aieq/stats` 提供漏斗（僅計數），平台 `x-admin-token` 或 `AIEQ_ADMIN_LINE_USER_IDS` 名單內的 LINE 使用者可讀，後者在朋友圈頁看得到「活動統計」卡。
- 待辦：第 1 項題庫版本分流、第 5 項前端拆檔與測試、第 6 項 AIEQ 獨立 webhook。

## 建議順序

1. 限流＋token 快取淘汰（一次小 PR，半天內）。
2. 漏斗統計端點（協會測試期間即可用）。
3. 題庫版本分流（Eve 哥八題到位前完成）。
4. 前端拆檔＋純邏輯測試，再 Playwright。
5. AIEQ 獨立 webhook plugin。
