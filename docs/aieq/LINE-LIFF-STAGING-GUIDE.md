# AIEQ 測試 OA、LINE Login 與 LIFF 手機驗收指南

目的：建立一套與正式饅頭隔離的 LINE 測試環境，讓兩個真人 LINE 帳號走完「邀請 → pending → 完成測評 → 確認結果 → 正式成為 AIEQ 朋友」。

> 不要把這個分支直接部署到正式饅頭服務，也不要把測試 token 寫進 Git。

## 完成後你會拿到的五個值

| 環境變數 | 從哪裡取得 |
|---|---|
| `PUBLIC_BASE_URL` | 測試後端部署完成後取得的 HTTPS 網址 |
| `LINE_CHANNEL_TOKEN` | 測試 OA 的 Messaging API channel access token |
| `LINE_CHANNEL_SECRET` | 測試 OA 的 Messaging API channel Basic settings |
| `LINE_LOGIN_CHANNEL_ID` | LINE Login channel 的 Basic settings → Channel ID |
| `LIFF_ID` | LINE Login channel → LIFF → 建立 LIFF app 後取得 |

環境變數名稱可參考 `packages/backend/.env.example`。實際值只放 Secret Manager 或測試服務環境變數。

## 第 0 步：先準備

你需要：

- 可登入 LINE Official Account Manager 與 LINE Developers Console 的 Business ID。
- 一個主要測試 LINE 帳號。
- 一位可信任朋友或第二個 LINE 帳號，用來測雙人邀請。
- 一個獨立的測試資料庫。
- 一個可公開存取的 HTTPS 測試網址；Cloud Run 的 staging service 即可。

LINE Login channel 若保持 `Developing`，只有該 channel 的 Admin 或 Tester 可以登入。因此第二位測試者也要有自己的 Business ID、連結自己的 LINE 帳號，並被加入 Tester。

## 第 1 步：決定 Provider

1. 登入 [LINE Developers Console](https://developers.line.biz/console/)。
2. 建立一個正式可辨識的 Provider，例如 `AIEQ` 或公司名稱；不要取 `temp`。
3. 記住這個 Provider。

最重要的規則：測試 OA 的 Messaging API channel 與 AIEQ 的 LINE Login channel 必須放在**同一個 Provider**。LINE user ID 是 Provider 層級的；放在不同 Provider，OA webhook 與 LIFF Login 看到的會像兩個不同的人，而且 channel 建立後不能搬家。

## 第 2 步：建立測試 LINE Official Account

目前不能直接在 Developers Console 新建 Messaging API channel；要先建立 OA。

1. 登入 [LINE Official Account Manager](https://manager.line.biz/)。
2. 建立一個新的測試 OA，例如 `AIEQ 測試站`。
3. 在 OA Manager 開啟：`設定 → Messaging API → 啟用 Messaging API`。
4. 系統要求選 Provider 時，選第 1 步的同一個 Provider。這一步選錯後不能搬移。
5. 回 Developers Console，進入該 Provider，確認出現一個 Messaging API channel。

## 第 3 步：取得 Messaging API 憑證

在測試 OA 的 Messaging API channel：

1. `Basic settings → Channel secret`，複製為 `LINE_CHANNEL_SECRET`。
2. `Messaging API → Channel access token`，發行測試 token，複製為 `LINE_CHANNEL_TOKEN`。
3. `Messaging API → QR code`，用主要測試 LINE 帳號加入這個測試 OA。
4. 到 OA Manager 關閉預設的 Greeting message 與 Auto-response，避免同一則訊息同時被 OA 內建回覆和 AIEQ webhook 回覆。

不要把 token 傳進對話、文件或 Git。之後只放 Secret Manager。

## 第 4 步：建立 LINE Login channel

1. 回到同一個 Provider。
2. 選 `Create a new channel → LINE Login`。
3. App type 選 `Web app`。
4. 名稱可用 `AIEQ 測試登入`；channel 名稱不要包含 `LINE` 字樣。
5. Region 選服務所在區域，例如 Taiwan。
6. 建立後先保持 `Developing`，不要發布。
7. 到 `Basic settings` 複製 `Channel ID`，這就是 `LINE_LOGIN_CHANNEL_ID`；不是 Channel secret。

## 第 5 步：加入第二位真人 Tester

如果只有你一人驗收，可以先跳過；朋友圈驗收前必須完成。

1. 第二位測試者建立／登入自己的 Business ID，並連結他手機上的 LINE 帳號。
2. 你在 LINE Login channel 的 `Roles` 頁面邀請他的 Business ID email。
3. Role 選 `Tester`。
4. 對方接受邀請。

注意：`Developing` 狀態下，Member 不能測，Admin 與 Tester 才可以。

## 第 6 步：先部署隔離的 HTTPS staging

LIFF Endpoint URL 必須是 HTTPS，所以不能直接填 `localhost`。

1. 從 `codex/aieq-mbti` 建立獨立 staging service，例如 `mentor-aieq-staging`。
2. 使用獨立 staging database；不要指向正式饅頭資料庫。
3. 暫時先注入：
   - `DATABASE_URL`
   - `DB_SSL`
   - `JWT_SECRET`
   - `CRON_SECRET`
   - 第 3 步取得的 `LINE_CHANNEL_TOKEN`
   - 第 3 步取得的 `LINE_CHANNEL_SECRET`
   - 第 4 步取得的 `LINE_LOGIN_CHANNEL_ID`
4. `LIFF_ID` 可先放 `not-configured`，部署一次。
5. 取得服務 HTTPS 網址，例如 `https://mentor-aieq-staging-xxxxx.a.run.app`。
6. 將它設為 `PUBLIC_BASE_URL`，重新部署或更新服務環境變數。
7. 用瀏覽器確認：
   - `GET <PUBLIC_BASE_URL>/health` 回傳 `ok: true`。
   - `<PUBLIC_BASE_URL>/aieq` 能載入頁面；此時顯示 LIFF 尚未設定是正常的。

## 第 7 步：建立 LIFF app

在第 4 步的 LINE Login channel：

1. 打開 `LIFF` 頁籤，新增 LIFF app。
2. Size 選 `Full`。
3. Endpoint URL 填：`<PUBLIC_BASE_URL>/aieq`。
4. Scopes 勾選 `openid` 與 `profile`。
5. 不需要 email scope。
6. 建立後複製 LIFF ID，設為 staging 的 `LIFF_ID`。
7. 再次部署／更新環境變數。
8. 在 LIFF 頁籤開啟 `shareTargetPicker`，閱讀並同意 Agreement Regarding Use of Information 後按 Enable。

正式打開應使用 LINE 配發的網址：`https://liff.line.me/<LIFF_ID>`，不要使用已淘汰的 `line://app/` 格式。

## 第 8 步：設定 Messaging API webhook

回到測試 OA 的 Messaging API channel：

1. Webhook URL 填：`<PUBLIC_BASE_URL>/api/webhook/line`。
2. 按 `Verify`，應看到 Success。
3. 打開 `Use webhook`。
4. 再確認 OA Manager 的 Greeting message、Auto-response 已關閉。

後端會驗證 `x-line-signature`，並先把事件寫入 durable webhook inbox，再非同步處理。

## 第 9 步：單人手機驗收

用主要測試帳號：

1. 打開測試 OA 聊天室。
2. 輸入 `開始 AIEQ`。
3. 確認收到三選一 Flex 卡。
4. 測試一次卡片選擇、一次自由文字回答。
5. 輸入 `暫停`，關閉 LINE，再輸入 `繼續 AIEQ`。
6. 測試 `回上一題`。
7. 完成 8 題，確認收到動物結果卡。
8. 點卡片開啟 LIFF。
9. 按「確認並綁定這個結果」。
10. 再次開啟 LIFF，應直接看到既有結果，不能回到第一題。

驗收重點：沒有確認前不能出現在朋友圈；確認結果本身不等於同意個人化，也不會寫入饅頭核心記憶。

## 第 10 步：雙人 pending 邀請驗收

帳號 A 已完成並確認結果後：

1. A 在 LIFF 朋友圈按「邀請一位朋友」。
2. Share Target Picker 選帳號 B。
3. A 看不到系統回報分享給了哪位好友，這是正常的隱私行為。
4. B 點邀請連結，完成 LINE Login。
5. B 按「接受邀請」。
6. 此時資料狀態應為 `claimed/pending`，A 與 B 都不應因這個動作立刻多出一位朋友。
7. B 完成 8 題。
8. B 確認自己的結果。
9. 確認交易會把邀請改成 `accepted`，並建立 friendship。
10. 若 A、B 都選「朋友可見」，雙方朋友圈都看到彼此的動物與四碼。
11. 任一方不選朋友可見時，連結仍存在，但對方的朋友圈不顯示其類型。

再做三個負向測試：

- 重複點同一張答案卡，不得前進兩題。
- 把同一邀請連結交給第三人，第三人不得認領。
- 在朋友圈按「刪除我的全部 AIEQ 資料」，結果、邀請和 connection 都應消失。

## 第 11 步：驗收完成的判定

必須全部成立才算 staging 通過：

- OA webhook Verify 成功。
- 卡片與自由文字答案結果一致。
- 中斷續答與舊卡冪等正常。
- LIFF ID Token 後端驗證成功。
- 邀請認領後保持 pending。
- 被邀請者確認結果後才建立 connection。
- 分享可見與個人化同意能分開選。
- 完整刪除功能有效。
- 正式饅頭服務與正式資料庫沒有任何修改。

通過後再決定是否建立正式 LINE Login／LIFF 設定；不要把 staging channel 從 `Developing` 切成 `Published`。Published 一旦設定，不能改回 Developing。
