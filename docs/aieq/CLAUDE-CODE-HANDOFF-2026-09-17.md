# AI Personality（AI 人格誌）專案交接文件

更新日期：2026-09-17  
交接對象：Claude Code 及後續工程／產品人員  
倉庫：`yveshuangai-cloud/mentor`  
工作分支：`codex/aieq-mbti`  
目前 HEAD：`493e27b feat: add local demo sharing and friend branch`

> **2026-09-18 更新**：題庫已升級為 AI Personality 1.1，共 **8 題**（新增第 8 題 `q08_ai_options`，J／P 第二個證據點）。本文凡寫「7 題」「J／P 只有一題」之處皆為交接當下的狀態，現況見 `WORK-PLAN-2026-09-17.md`。
>
> 請先讀完本文件再修改。此分支目前有尚未提交的 UI、題目文案、PWA 與結果頁變更；不要 reset、checkout 或覆蓋。

## 1. 一句話現況

AI Personality 已是可在本機完整遊玩的 7 題手機優先原型，具備題目、計分、16 型動物結果、結果封面、分享預覽、本機模擬分享／朋友圈、重新測驗、LINE LIFF 身分驗證、邀請與資料刪除後端；下一個真正里程碑是整理本輪未提交變更、跑完整測試、部署 HTTPS staging，並用真實 LINE OA／LIFF 做兩人手機端到端驗收。

## 2. 產品名稱與不可混淆事項

- 對外產品名：**AI Personality｜AI 人格誌**。
- 「誌」是雜誌的誌。
- `AIEQ` 是歷史名稱，程式路徑、資料表與部分舊文件仍沿用。
- 目前正式遊戲是 **7 題**，不是 8 題。
- 倉庫中部分舊規格仍寫 8 題；以 `packages/backend/src/modules/aieq/questions.ts` 與測試為現況真值。
- 這不是官方 MBTI®，不是心理診斷，也不表示能力高低或固定命運。
- 動物是結果敘事與辨識系統，不能反向參與計分。

## 3. 已確認的產品決策

### 3.1 核心流程

1. 從 LINE OA 或 LIFF 進入。
2. 首頁按「開始探索」。
3. 回答 7 個 AI 日常情境，每題 A／B／C，也可選不確定或上一題。
4. 完成後顯示 16 型之一與對應動物。
5. 結果頁有「人格誌／封面／分享預覽」三個分頁。
6. 使用者另外確認結果；確認不等於公開或同意個人化。
7. 可透過 LINE Share Target Picker 分享邀請。
8. 朋友接受邀請、完成並確認結果後，才建立雙向朋友圈關係。

### 3.2 隱私與資料邊界

- 結果確認、朋友圈可見、饅頭個人化同意必須彼此獨立。
- 不取得 LINE 好友名單。
- 不信任前端提交的 LINE user ID；後端驗證 LIFF ID token。
- AIEQ 資料預設不寫入饅頭的 `learned_facts`、soul pack、角色身份或一般聊天記憶。
- 提供刪除本人全部 AIEQ 測評、結果、邀請與朋友關係的能力。

### 3.3 視覺方向

- 黑色主底。
- 螢光粉紅：主要結果代碼、重點和主按鈕。
- 螢光綠：眉題、焦點框線、選中狀態與品牌識別。
- 瑞士現代主義／雜誌編輯感。
- 動物必須去背並融入完整場景，不能出現突兀的白色正方形底。
- 手機優先，大字、強對比、大觸控區域。
- 結果頁的人格名稱（例如「貓頭鷹・策略建築師」）是主標；`INTJ` 等代碼是小標。

## 4. 本輪已完成但尚未提交的變更

執行 `git status --short` 應看到：

```text
 M packages/backend/public/aieq.html
 M packages/backend/src/index.ts
 M packages/backend/src/modules/aieq/catalog.ts
 M packages/backend/src/modules/aieq/questions.ts
?? packages/backend/public/aieq-manifest.webmanifest
?? packages/backend/public/aieq-sw.js
```

### `packages/backend/public/aieq.html`

- 首頁、答題、結果、封面、分享預覽與朋友圈的手機大字版面。
- 首頁副標題增加黑底、綠色邊線及圖片間距，避免與底圖重疊。
- A／B／C 選項主標與副標放大；觸控區域加高。
- 選項改為主句＋不重複的補充說明。
- 點選選項後：選中項亮綠、其他項淡出、短促水平震動、下一題滑入。
- 支援 `navigator.vibrate(35)`；裝置不支援時自動忽略。
- 尊重 `prefers-reduced-motion`。
- 新增右上角「重新玩一次」；本機 demo 直接清除，正式環境要求確認。
- 結果的四條進度列改成 SVG 四軸雷達圖。
- 「清晰／邊界」改成「很明顯偏 X／比較偏 X／兩邊都像，稍微偏 X」。
- 結果評語標籤改為「你的厲害之處／容易卡住的地方／給你的小建議」。
- 人格代碼降為小標，動物名稱與人格稱號升為大標。
- 沒有真實 LINE 身分時保留本機模擬分享與三位模擬朋友。
- LIFF 正式環境與 `LOCAL DEMO` 分支維持分離。
- 加入 PWA meta、manifest link 和 HTTPS 下註冊 service worker。

### `packages/backend/src/modules/aieq/questions.ts`

- 7 題共 21 個選項改成第一人稱、大白話、容易直覺作答的文案。
- 主標與副標不再重複。
- B 與 C 改成互斥、具體的行為，不再只是程度差異。
- **所有 option id、題目順序、dimension 與 evidence 權重均未改變。**
- `option()` helper 現在分開接收 `shortLabel` 與 `label`。

### `packages/backend/src/modules/aieq/catalog.ts`

- INTJ／貓頭鷹三段解讀改成有溫度的大白話。
- 其餘 15 型尚未全面口語化；這是待辦。

### `packages/backend/src/index.ts`

- 新增 `/aieq-manifest.webmanifest` 路由。
- 新增 `/aieq-sw.js` 路由與 `service-worker-allowed: /`。

### 新增 PWA 檔案

- `packages/backend/public/aieq-manifest.webmanifest`
- `packages/backend/public/aieq-sw.js`

目前三個端點已做過 smoke check，均回 HTTP 200：

```text
/aieq
/aieq-manifest.webmanifest
/aieq-sw.js
```

## 5. 已提交的重要里程碑

```text
493e27b feat: add local demo sharing and friend branch
bb99bb3 fix: support answer events on local network HTTP
c52ac55 feat: integrate immersive AI Personality scenes
fae244b feat: ship seven-question AI Personality LIFF
a0cfef0 docs: summarize recent AI Personality decisions and deliverables
04e50e3 assets: archive AI Personality share cards and latest planning deliverables
```

`bb99bb3` 很重要：區網 HTTP 不保證支援 `crypto.randomUUID()`，前端已有 fallback UUID，請勿回退。

## 6. 技術架構

### 6.1 後端與前端

- Node.js 20+、TypeScript、Fastify、PostgreSQL。
- 前端為單檔 LIFF：`packages/backend/public/aieq.html`。
- 本機 demo 使用 embedded PostgreSQL：`packages/backend/scripts/aieq-local.ts`。
- PWA 只在 HTTPS 註冊 service worker；本機 HTTP 區網不會註冊，這是瀏覽器安全限制。

### 6.2 核心模組

| 檔案 | 職責 |
|---|---|
| `packages/backend/src/modules/aieq/questions.ts` | 7 題題庫、選項文案與 evidence 權重 |
| `packages/backend/src/modules/aieq/scoring.ts` | 四組偏好與 AIEQ 能力計分 |
| `packages/backend/src/modules/aieq/stateMachine.ts` | 答題事件與狀態轉換 |
| `packages/backend/src/modules/aieq/repository.ts` | session、profile、邀請、朋友關係持久化 |
| `packages/backend/src/modules/aieq/auth.ts` | LIFF ID token 驗證 |
| `packages/backend/src/modules/aieq/catalog.ts` | 16 型動物、稱號、圖片與評語 |
| `packages/backend/src/modules/aieq/channel.ts` | LINE 文字／postback 通路轉接 |
| `packages/backend/src/modules/aieq/flex.ts` | LINE Flex 訊息 |
| `packages/backend/src/modules/aieq/report.ts` | 結果報告資料 |
| `packages/backend/src/routes/aieq.ts` | `/api/aieq/*` API |
| `packages/backend/public/aieq.html` | LIFF／本機遊戲前端 |

### 6.3 API

除 `/api/aieq/config` 外，正式環境均要求：

```http
Authorization: Bearer <LIFF ID token>
```

主要路由：

```text
GET    /api/aieq/config
GET    /api/aieq/entry
POST   /api/aieq/sessions
GET    /api/aieq/sessions/:id
POST   /api/aieq/sessions/:id/events
POST   /api/aieq/sessions/:id/confirm
GET    /api/aieq/me
DELETE /api/aieq/me/data
GET    /api/aieq/friends
POST   /api/aieq/friend-invites
POST   /api/aieq/friend-invites/:token/claim
```

### 6.4 資料庫

- `packages/backend/src/db/migrations/013_aieq_engine.sql`
- `packages/backend/src/db/migrations/014_aieq_pending_friend_invites.sql`

## 7. 計分與產品護欄

### 不可隨 UI 文案任意修改

- Question ID。
- Option ID。
- Option evidence 權重。
- 題目順序。
- 四軸定義與正負方向。
- `eventId` 冪等邊界。
- 結果確認、朋友圈可見、個人化同意的分離。

### 目前 7 題覆蓋

- EI：第 1、6 題。
- SN：第 2、3 題。
- TF：第 4、5 題。
- JP：第 7 題，只有一個證據點，因此 UI 必須持續標示「僅供參考／低證據量」。

雷達圖呈現的是「本次作答偏好出現得多明顯」，不是能力值、排名或好壞。

## 8. 視覺資產位置

### 首頁與結果場景

```text
assets/ai-personality/scenes/start/start-exploration-v1.png
assets/ai-personality/scenes/results/<type>-<animal>-v1.png
```

### 16 型動物素材

```text
assets/aieq/animals/swiss-modernist/
```

### 分享卡

```text
output/design/ai-personality-share-cards-16/
```

### 企劃與交付物

```text
output/documents/AIEQ_16型動物人格設定手冊_企劃共創版.docx
output/pdf/AI人格誌_方案簡報_AIEQ瑞士風格版.pdf
docs/aieq/deliverables/
```

正式視覺參考優先讀：

1. `docs/aieq/AI-PERSONALITY-CONVERSATION-SUMMARY-2026-09-11.md`
2. `docs/aieq/AIEQ-ART-DIRECTION-CANDIDATES.md`
3. `docs/aieq/AIEQ-GEOMETRIC-ANIMAL-VISUAL-SYSTEM.md`

注意：早期 `AIEQ-ANIMAL-VISUAL-SYSTEM.md` 與 `AIEQ-GEOMETRIC-VISUAL-SYSTEM.md` 已被後續方向取代，不要以舊版白底或純幾何稿覆蓋現在場景圖。

## 9. 本機啟動

### 正常環境

```bash
npm install
npm run dev:aieq -w packages/backend
```

預設：

```text
http://localhost:3777/aieq
```

本機腳本會：

- 建立暫存 embedded PostgreSQL。
- 套用 migrations。
- 設定 `NODE_ENV=development`。
- 設定 `AIEQ_DEMO_MODE=true`。
- 以 `local-demo` token 模擬身分。
- 結束程序後刪除暫存測試資料。

### 手機同網路測試

1. 找出 Mac 當下 Wi-Fi IP，例如：

   ```bash
   ipconfig getifaddr en0
   ```

2. 手機與 Mac 必須在同一 Wi-Fi。
3. 手機開啟：`http://<CURRENT_LAN_IP>:3777/aieq`。

區網 IP 會因切換 Wi-Fi 改變。若手機畫面空白或無法連線，先確認 IP；曾用過的 `10.120.64.36` 已失效，之後也不能假設 `10.10.5.33` 永遠有效。

### 本地 demo 行為

- 右上角「重新玩一次」會刪除本機 demo 資料並回首頁。
- 分享按鈕只顯示模擬成功，不會真的傳 LINE。
- 朋友圈顯示小雨／Alex／Mina 三位模擬好友。
- 未登入 LINE 時沒有真實頭像；封面顯示示意狀態。

## 10. 測試與驗證

建議在有正常 Node/npm 的 shell 執行：

```bash
npm run typecheck -w packages/backend
npm run test -w packages/backend
npm run test:aieq:integration -w packages/backend
npm run build -w packages/backend
```

相關測試：

```text
packages/backend/test/aieq.test.ts
packages/backend/scripts/aieq-integration.ts
```

本輪環境曾遇到 `npm: command not found`，改直接跑 Vitest 時又因未提供 `DATABASE_URL` 在 config import 階段失敗；因此**不能宣稱本輪所有自動測試已通過**。已完成的檢查只有：

- 前端內嵌 JavaScript `node --check` 通過。
- `git diff --check` 通過。
- `/aieq`、manifest、service worker 路由 HTTP 200。
- 先前版本已手動跑過 7 題並取得結果。

接手後第一件事應在完整開發環境重新跑上述四個命令。

## 11. LINE／LIFF staging 所需設定

必要環境變數：

```text
DATABASE_URL
PUBLIC_BASE_URL
LINE_CHANNEL_TOKEN
LINE_CHANNEL_SECRET
LINE_LOGIN_CHANNEL_ID
LIFF_ID
```

選用（2026-09-18 起）：`LINE_OA_BASIC_ID`（加好友卡）、`AIEQ_ONLY_WEBHOOK=true`（AI 人格誌專用 webhook）、`AIEQ_ADMIN_LINE_USER_IDS`（可看漏斗統計的 LINE 使用者）、`AIEQ_TEAM_FEEDBACK=true`（**僅測試環境**：團隊回報小標籤，寫入 `aieq_team_feedback`「團隊反饋」表；正式環境不得設定）。

必要規則：

- Messaging API channel 與 LINE Login channel 必須在同一個 Provider。
- LIFF endpoint 必須是 HTTPS：`https://<PUBLIC_BASE_URL>/aieq`。
- LIFF scopes：`openid`、`profile`。
- LIFF app size：Full。
- 開啟 Share Target Picker，並完成 LINE 所需協議。
- Developing 狀態下，第二位測試者必須被加為 Tester。
- 不要覆蓋既有 AI Survival Index 的 LIFF app；如果沒有專屬 AI Personality LIFF app，建立獨立 app。
- 正式入口使用 `https://liff.line.me/<LIFF_ID>`，不要使用舊 `line://app/`。

完整操作見：`docs/aieq/LINE-LIFF-STAGING-GUIDE.md`。

## 12. 目前尚未完成／需確認

### P0：接手後立即處理

1. 保留未提交變更，逐檔 review。
2. 跑 typecheck、unit test、integration test、build。
3. 修正任何因 `option()` signature 改變造成的型別或測試失敗。
4. 手機跑完整「首頁 → 7 題 → 結果 → 雷達圖 → 確認 → 封面 → 分享預覽 → 重新玩」。
5. 測試選項動效是否清楚，且不會因 260ms 延遲造成重複送出。
6. 檢查 320px、375px、390px、430px 寬度及 iPhone safe area。
7. 確認 PWA manifest icon 是否符合瀏覽器要求；目前暫用貓頭鷹素材，應製作正式方形 app icon。
8. 確認 service worker 快取策略不會讓新版 HTML 長期停留；上線前建議增加版本更新策略或縮小快取範圍。

### P1：內容與結果品質

1. 將其餘 15 型的 `strength`、`blindSpot`、`growthRoute` 全面改寫成與 INTJ 同樣溫暖、白話的解讀。
2. 對 21 個新選項做一次真人可理解性測試，確保三個答案互斥且沒有明顯誘導。
3. 驗證雷達圖標籤與四軸資料順序不會因物件列舉順序改變；較穩妥的做法是明確用 `['EI','SN','TF','JP']` 排序。
4. 確認雷達圖在小螢幕不裁切，且無障礙替代文字足夠。
5. 決定是否要在結果頁顯示更完整的「為什麼得到這個結果」。

### P1：LINE staging

1. 確認專屬 AI Personality LINE Login Channel／LIFF App。
2. 部署 HTTPS staging。
3. 配置環境變數。
4. 驗證 OA 指令、webhook、LIFF Login 與結果卡。
5. 用兩個真人 LINE 帳號跑邀請 pending → 雙方確認 → 成為朋友。
6. 手機跑一次「OA → 7 題 → 結果 → 封面 → 分享」。

### P2：程式維護性

1. `aieq.html` 已變得很大，建議在不影響部署的前提下拆成 CSS／JS 模組或加入前端 build step。
2. 增加 UI regression／Playwright 測試：答題、回上一題、重複點擊、重新玩、結果 tab、demo share。
3. 對 PWA routes 加測試。
4. 更新所有仍寫 8 題的舊文件；保留歷史背景但清楚標為 obsolete。
5. 評估本機 demo 使用固定 `local-demo` 使用者時，多台裝置同時測試會共享狀態的問題。

## 13. 建議的下一個「爬山開發」里程碑

### 山腳：凍結本輪成果

- 自動測試全綠。
- commit 未提交變更，建議訊息：

  ```text
  feat: upgrade AI Personality mobile results and PWA flow
  ```

### 第一個營地：單機手機驗收

- 一台手機完整玩 3 次。
- 每次都能重設。
- 每題點擊有明顯回饋。
- 16 型至少抽查 4 型圖片與解讀。

### 第二個營地：HTTPS staging

- Railway／既有部署環境可連線。
- `/health`、`/aieq`、manifest、service worker、API 正常。
- LIFF Login 可取得真實頭像。

### 山頂：LINE OA 雙人實測

- A 從 OA 開始並完成。
- A 分享邀請給 B。
- B 完成並確認。
- 雙方朋友圈正確顯示。
- 刪除其中一方資料後，關係與資料同步消失。

## 14. 真人驗收清單

### 畫面

- [ ] 首頁副標不與圖片重疊。
- [ ] 文字在手機不用縮放即可閱讀。
- [ ] A／B／C 主標和副標層級清楚。
- [ ] 結果動物沒有白色方框。
- [ ] 人格名稱大於四字母代碼。
- [ ] 雷達圖不裁切、不誤導為能力分數。
- [ ] 封面有真實 LINE 頭像。

### 操作

- [ ] 點選後立即看見亮起、淡出、震動／位移。
- [ ] 快速連點不會跳兩題。
- [ ] 上一題可回去。
- [ ] 中斷後可續答。
- [ ] 重新玩一次行為符合 demo／正式環境差異。
- [ ] 結果確認不會自動公開。
- [ ] Share Target Picker 正常。

### 資料與安全

- [ ] 後端驗證 LIFF ID token。
- [ ] OA 與 LIFF user ID 來自同一 Provider。
- [ ] 重複 event ID 不會重複計分。
- [ ] pending invite 不會提前建立 friendship。
- [ ] 刪除資料涵蓋 session、profile、invite、friendship。
- [ ] AIEQ 測試資料不進入饅頭記憶。

## 15. 已知風險

1. **舊文件漂移**：多份文件仍描述 8 題、舊視覺或不提供重測，容易誤導。
2. **單檔前端膨脹**：CSS／JS 都在 `aieq.html`，修改容易互相覆蓋。
3. **PWA 快取**：network-first 仍可能在離線時提供舊 shell，版本策略需補強。
4. **固定 demo identity**：多人同時使用同一個 demo 後端可能互相覆蓋進度。
5. **真實 LIFF 尚未在本輪驗證**：本機模擬成功不等於 LINE Target Picker、頭像與 invite 真實成功。
6. **只有 INTJ 文案已口語化**：其餘結果的語氣仍偏產品／顧問術語。
7. **JP 證據不足**：只有一題，不能把雷達圖視覺做得像高精度心理測量。
8. **PWA icon 暫代**：目前不是正式 app icon，maskable 裁切需驗證。

## 16. 重要參考文件閱讀順序

1. 本文件。
2. `docs/aieq/AI-PERSONALITY-CONVERSATION-SUMMARY-2026-09-11.md`。
3. `docs/aieq/AIEQ-LEAN-FLOW.md`。
4. `docs/aieq/AIEQ-IMPLEMENTATION.md`（留意部分 8 題描述已過時）。
5. `docs/aieq/LINE-LIFF-STAGING-GUIDE.md`。
6. `docs/aieq/AIEQ-CLASSIFICATION-LOGIC-AND-QUESTION-BANK.md`（計分背景；以程式為真值）。
7. `docs/AIEQ-SPEC.md`。

## 17. 給 Claude Code 的第一段建議提示詞

```text
請先閱讀 docs/aieq/CLAUDE-CODE-HANDOFF-2026-09-17.md，接著檢查 git status 與所有未提交 diff。不要 reset、checkout 或覆蓋現有變更。先在 Node 20+ 的完整環境執行 backend typecheck、unit tests、AIEQ integration tests 與 build，修正失敗但不要更動 7 題 option id、evidence 權重、計分公式、隱私授權邊界或正式視覺方向。之後以 375px 與 390px 手機 viewport 驗收首頁、7 題答題、選中動效、結果雷達圖、封面、分享預覽及重新玩一次。完成後彙報變更、測試證據、仍存在的 LINE／LIFF staging 阻塞，再提出可提交的 commit 計畫。
```

## 18. 最終交接結論

目前不是從零開始，也不是只剩視覺稿。核心後端、7 題遊戲、計分、持久化、LIFF 驗證、朋友圈與刪除流程都已存在；本機版本已可完整遊玩。本輪最新成果集中在手機字體、第一人稱題目、選項回饋、結果雷達圖、白話解讀、重玩與 PWA。真正尚未完成的是：將未提交變更測試並凍結、部署 HTTPS staging、接上專屬 LIFF，以及用兩位真人 LINE 帳號完成最後驗收。
