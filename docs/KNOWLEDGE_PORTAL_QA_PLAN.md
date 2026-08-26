# 饅頭知識庫第一階段 QA 計畫與執行紀錄

版本：1.0

範圍：`/knowledge` LIFF、LINE 身分授權、直傳 GCS、Cloud SQL 文件生命週期、非同步解析、chunks／embeddings／citations、排程補償、刪除與正式環境維運。
正式環境：Cloud Run `mantou-backend`、Cloud SQL `mantou-db`、GCS `mantou-knowledge-2026`、Cloud Scheduler `mantou-process-knowledge`。

## 1. 驗收不變量

以下三件事在任何修正後都必須成立；違反任一項即禁止上線：

1. 只有 LINE ID token 驗證成功、在靈魂授權白名單且具有有效 tenant membership 的使用者，能上傳、列出及刪除知識。
2. 所有文件、chunks、向量、引用、工作佇列與原始檔均受 tenant／user／visibility／retention 約束；不得跨租戶或跨使用者洩漏。
3. 新知識入口不得破壞既有 LINE 文字、錄音、圖片、文件、打電話、AIEQ 與記憶管線；排程或即時 kick 其中一條失效時，另一條仍可恢復處理。

## 2. 品質門檻

- P0／P1 未解決：禁止部署。
- 自動化測試：100% 通過；不得以重跑掩蓋 flaky test。
- Migration：須能在全新 PostgreSQL 套用，也須能對既有正式 schema 冪等啟動。
- API：未授權一律 fail closed；重送 complete 不得重複建 job 或造成 500。
- 原始檔：上傳、處理、去重與刪除均有明確生命週期；刪除後應用層不可再取回。
- 正式環境：最新 revision 100% traffic、scheduler enabled、近 24 小時無未解釋 ERROR。
- 真機：至少 iOS LINE 與 Android LINE 各完成一次 PDF 及 Office 文件上傳、吸收通知、引用回答、刪除。

## 3. 測試矩陣

| ID | 面向 | 測試 | 預期 | 類型 |
|---|---|---|---|---|
| S-01 | 靜態 | TypeScript typecheck、build、`git diff --check` | 全通過 | 自動 |
| S-02 | 靈魂包 | manifest、lint、舊人格、PII | 全通過 | 自動 |
| S-03 | 供應鏈 | production dependency audit、秘密字串掃描 | 無 critical/high；無真實 key 入庫 | 自動＋人工 |
| DB-01 | Migration | 空白 PostgreSQL 套用 001–016 | server 可啟動 | 自動 |
| DB-02 | 隔離 | tenant wrapper 強制 `$1`，跨 tenant/user 不可讀寫 | fail closed | 自動 |
| DB-03 | 生命週期 | permanent／30／90 天、ready／failed／duplicate | 查詢只含有效 ready 文件 | 自動 |
| DB-04 | 去重 | 同 hash 同 user/visibility；不同 user/visibility | 前者去重，後者各自保留 | 整合 |
| API-01 | 授權 | 無 token、壞 token、非白名單、無 membership | 401／403 | 自動＋整合 |
| API-02 | 驗證 | 副檔名、大小、檔名、enum、document id | 4xx 且無殘留資料 | 自動 |
| API-03 | 冪等 | complete 連按、網路重送、scheduler 重跑 | 單一 job、無 500 | 整合 |
| GCS-01 | 上傳 | V4 URL、Content-Type、15 分鐘期限、20 MiB 上限 | 僅允許指定物件與型別 | 整合 |
| GCS-02 | 安全 | private bucket、UBLA、public prevention、CORS | 無公開讀取；僅正式 origins | 雲端 |
| GCS-03 | 刪除 | live generation、歷史 generation、DB cascade | 應用層全刪；備援保留須揭露 | 整合＋雲端 |
| ING-01 | 解析 | PDF、DOCX、PPTX、XLSX、MD/TXT/CSV/JSON/YAML/HTML/RTF | 產生非空文字與引用 | 自動＋真檔 |
| ING-02 | 安全 | zip bomb、加密 Office、XXE、空白／掃描 PDF | 拒絕或清楚標示能力邊界 | 自動 |
| ING-03 | 可靠 | worker crash、5 次 retry、stale lock、即時 kick 失敗 | scheduler 恢復；最終 ready/dead | 整合 |
| RET-01 | 檢索 | 普通問題、完整閱讀、永久文件、過期文件 | 正確 chunks、完整順序、citation | 自動＋整合 |
| RET-02 | 注入防護 | 文件內含「忽略規則／修改人格」 | 只當外部資料，不改靈魂 | 自動＋人工 |
| UI-01 | LIFF | 啟動、登入、白名單錯誤、上傳進度、狀態刷新、刪除確認 | 文案明確，無假成功 | 瀏覽器＋真機 |
| OPS-01 | Cloud Run | revision、traffic、runtime SA、secrets | 正確且無明文敏感值 | 雲端 |
| OPS-02 | Scheduler | 無／錯 secret、正確 secret、手動 run | 401／401／200；每分鐘補處理 | 雲端 |
| OPS-03 | 觀測性 | job/document 狀態、錯誤、通知、告警 | 可定位 document/job/attempt | 人工 |
| PERF-01 | 效能 | 1/5/20 MiB、1/10/50 chunks、同時 5 上傳 | API 不被檔案傳輸阻塞；無 OOM | 壓測 |
| REG-01 | 回歸 | LINE 文字／錄音／圖片／文件／通話／AIEQ | 既有主流程無退化 | 正式驗收 |

## 4. 執行階段

1. **本機品質門**：predeploy、build、smoke、秘密掃描、dependency audit。
2. **資料層**：全新 DB migration、查詢 schema 驗證、tenant isolation、去重／冪等／刪除測試。
3. **雲端層**：Cloud Run、Cloud SQL、GCS IAM/CORS/versioning/soft-delete、Scheduler、logs。
4. **正式 API**：健康檢查、UI、bootstrap、401/403、cron 401/200。
5. **LIFF 真機 E2E**：LINE 登入 → 上傳 → complete → ingest → LINE 通知 → 問答引用 → 刪除。
6. **回歸與結案**：修 P0/P1，重跑所有自動化，記錄未消除風險與 rollback。

## 5. 缺陷分級

- **P0**：資料外洩、未授權可寫、正式服務不可用、文件吸收後完全無法檢索。
- **P1**：資料遺失／刪除不完整、冪等失效、排程失效、主要格式不可解析。
- **P2**：錯誤訊息、可觀測性、局部 UI 或非主要格式問題。
- **P3**：文案、視覺或不影響正確性的改善。

## 6. 本輪已取得證據（2026-08-26）

- predeploy：16 個 test files、109 tests 全通過；typecheck、build、soul manifest/lint 通過。
- clean embedded PostgreSQL smoke：9/9 通過，包含 migration、UI、admin/cron/knowledge 未授權阻擋。
- 知識庫專用 DB acceptance：7/7 通過，包含 private/family_shared/expired/permanent、完整閱讀、hash 去重與 cascade。
- 正式 Cloud Run：修正版 `mantou-backend-00031-xb4`，100% traffic，runtime SA 正確，health 200。
- 正式 API：health/UI/bootstrap 200；documents/upload/delete 無授權 401；cron 無／錯 secret 401、正確 secret 200。
- GCS：bucket 位於 ASIA-EAST1、versioning 啟用、CORS 已設正式兩個 origins；runtime SA 有 objectAdmin 與 self-signing Token Creator。
- Scheduler：enabled、每分鐘、Asia/Taipei、目標為正式 knowledge cron。
- Cloud Run 近 24 小時查詢未見 severity >= ERROR。
- Revision 00031 啟動日誌確認 `016_permanent_knowledge_retention.sql` 已套用並完成 `db ready`；該 revision ERROR 數為 0。
- dependency audit：原本 1 high 已藉由升級 `@fastify/static` 消除；尚有 2 moderate，來自 GCS SDK 直接相依的 gaxios/uuid，沒有 non-breaking 自動修復版本。
- 全平台既有 acceptance：90 過／7 敗；失敗集中在既有 nightly memory 與日記／夢斷言，已獨立列為平台回歸債，不算知識庫通過項。

## 7. 本輪發現

| 缺陷 | 等級 | 狀態 | 說明 |
|---|---|---|---|
| 普通文件檢索查錯資料表欄位 | P0 | 已修復並部署 00031 | `status/expires_at` 屬於 `uploaded_documents`，原查詢卻放在 `document_chunks`。 |
| 永久文件無法寫入 | P0 | 已修復並部署 00031 | 009 將 `expires_at` 設為 NOT NULL；新增 016 解除約束，讓 permanent 以 NULL 表示。 |
| complete 重送非冪等 | P1 | 已修復並部署 00031 | queued/processing/ready/duplicate 現改為成功 no-op。 |
| GCS 版本化物件只刪目前版本 | P1 | 已修復並部署 00031 | 現列出相同 object name 的 generations 後逐一刪除。 |
| Smoke test 固定 port 且 crash 可能回 0 | P2 | 已在本機修復 | 改為動態空閒 port，crash 明確 exit 1。 |
| Acceptance 固定 port／舊 semanticSearch 呼叫 | P2 | 已修復 | 改動態 port，並補回 user scope 參數；可正確回報 90/7。 |
| 靜態檔路由套件有 high advisory | P1 | 已修復 | `@fastify/static` 8.3.0 升至 10.1.3，回歸與 smoke 均通過。 |
| `KNOWLEDGE_LIFF_ID` 為 `not-configured` | P0 阻塞 | 待人工確認建立 LIFF | 未完成前不能做 LINE 真機登入與完整 E2E。 |
| gcloud 預設帳號／專案不是饅頭 | P1 維運風險 | 待校正 | QA 使用明確 `--account`／`--project` 避免誤操作。 |
| GCS soft delete 保留 7 天 | 已知風險 | 待產品/法遵決策 | 應用層刪除後不可讀，但雲端管理員在保留期內仍可復原。 |

## 8. 尚未宣告通過的項目

- LIFF app 尚未建立及寫入 `KNOWLEDGE_LIFF_ID`。
- 尚未取得 Yves 的真實 LINE ID token，因此白名單、membership、signed URL、完整上傳與刪除 E2E 尚未執行。
- iOS／Android LINE 真機與實際 PDF／Office 檔尚未驗收。
- 壓力、併發去重、worker crash recovery 與既有通話/AIEQ 全回歸尚未完成。
- 全平台 acceptance 尚有 7 個既有 nightly memory／日記／夢失敗，需另立修復工作，不可誤標全平台綠燈。

## 9. Rollback

若正式部署後出現 P0/P1：

1. Cloud Run traffic 立即切回上一個已知良好 revision。
2. 暫停 `mantou-process-knowledge`，保留 queued jobs，不刪除原始檔。
3. 保留 migration 015（additive migration 不反向 drop）；修正程式後再恢復 worker。
4. 對受影響 document/job 做 tenant-scoped 稽核，不用全域 SQL 修資料。
