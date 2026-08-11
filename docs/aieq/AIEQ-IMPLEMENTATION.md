# AIEQ 端到端實作與爬山開發紀錄

狀態：分支功能完成，尚未設定 LINE Console、尚未部署正式環境。
分支：`codex/aieq-mbti`

## 山頂：可驗收成果

使用者可以從 LINE OA 說「開始 AIEQ」，以 Flex 卡或自然文字完成 8 題測評；中斷後可續答。完成後得到四組人格偏好、六項獨立 AIEQ 能力、信心程度與動物視覺。使用者進入 LIFF 只需確認一次結果；朋友圈可見只在按下邀請時開啟，饅頭個人化則留到真正需要時另行詢問。朋友透過限時邀請連結建立雙向關係後，才能在朋友圈看見彼此公開的類型。

## 營地與完成狀態

1. **測量站：完成。** 8 題行為情境，含 direct、reverse、cross-check；MBTI 偏好與六項 AIEQ 能力分開計算。
2. **事件站：完成。** 卡片、自由文字、不確定、跳過、上一題、暫停、續答共用 `AnswerEvent`；`event_id` 防止 LINE 重送與重複點擊。
3. **持久化站：完成。** PostgreSQL append-only 事件、答案 projection、session row lock、單一進行中 session 限制。
4. **LINE 站：完成。** 明確口令才啟動，不扣點、不進一般對話記憶；舊卡片會回到目前進度。
5. **LIFF 站：完成。** 後端把原始 ID Token 送至 LINE `/oauth2/v2.1/verify`；不信任前端提交的 user id 或 profile。
6. **社交站：完成。** LINE Target Picker 只負責分享限時邀請；系統不取得 LINE 好友名單。被邀請者認領後先進入 pending，只有完成並確認結果才在同一交易建立 AIEQ friendship。
7. **隱私站：完成。** 結果確認、朋友圈可見與饅頭個人化同意彼此獨立；提供完整 AIEQ 資料刪除。
8. **視覺站：完成。** 16 型瑞士現代主義動物 PNG；四碼由 UI 疊字，不交給圖片模型生成。

入口採 profile-first：已有確認結果就回結果、未完成就續答、從未開始才顯示開始頁。開啟 LIFF 或再次輸入 AIEQ 不會自動建立新 session。完整規則見 `docs/aieq/AIEQ-LEAN-FLOW.md`。

## 執行路徑

```text
LINE text/postback
  -> signed webhook + durable inbox
  -> AIEQ channel adapter
  -> idempotent answer event transaction
  -> session projection + scoring
  -> result Flex
  -> LIFF ID-token verification
  -> explicit profile confirmation
  -> consented friendship graph
```

## API

除 `/config` 外，LIFF API 一律要求 `Authorization: Bearer <LIFF ID token>`。

- `GET /api/aieq/config`
- `POST /api/aieq/sessions`
- `GET /api/aieq/sessions/:id`
- `POST /api/aieq/sessions/:id/events`
- `POST /api/aieq/sessions/:id/confirm`
- `GET /api/aieq/me`
- `DELETE /api/aieq/me/data`
- `GET /api/aieq/friends`
- `POST /api/aieq/friend-invites`
- `POST /api/aieq/friend-invites/:token/claim`

## LINE Console 上線前設定

需要建立或確認同一 provider 下的 Messaging API channel 與 LINE Login channel：

1. LIFF Endpoint URL 設為 `https://<PUBLIC_BASE_URL>/aieq`。
2. LIFF scopes 開啟 `openid` 與 `profile`。
3. 啟用 Share Target Picker。
4. Messaging API webhook 設為 `https://<PUBLIC_BASE_URL>/api/webhook/line`。
5. 注入 `LINE_CHANNEL_TOKEN`、`LINE_CHANNEL_SECRET`、`LINE_LOGIN_CHANNEL_ID`、`LIFF_ID`、`PUBLIC_BASE_URL`。
6. 套用 migration，先在測試 OA 驗收，再決定是否部署正式服務。

逐畫面操作與雙人驗收流程見 `docs/aieq/LINE-LIFF-STAGING-GUIDE.md`。

## 驗證命令

```powershell
$env:DATABASE_URL='postgresql://test:test@127.0.0.1:5432/test'
npm.cmd test -w packages/backend
npm.cmd run typecheck -w packages/backend
npm.cmd run build -w packages/backend
npm.cmd run test:aieq:integration -w packages/backend
```

最後一項會啟動一次性本機 PostgreSQL，完整驗證 migration、session 冪等、計分、結果確認、朋友邀請與資料刪除。

## 邊界

- AIEQ 不寫入 `learned_facts`、soul pack 或角色身份。
- `personalization_consent` 只是授權邊界；目前沒有任何背景同步器把結果寫入饅頭記憶。
- 動物不參與計分，也不表示高低階級。
- 這是參考四組人格偏好的 AI 時代行為傾向測評，非心理診斷，也不是官方 MBTI® 測驗。
