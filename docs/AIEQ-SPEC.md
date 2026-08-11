# AIEQ 第一階段產品與技術規格

版本：Pilot 0.1
狀態：待審原型，不部署正式環境

## 1. 產品裁決

**改了再做。** AIEQ 不是另一個饅頭人格，而是饅頭或其他通路可以呼叫的獨立測評引擎。

它要回答的核心問題是：

> 我的性格在 AI 時代會怎麼生存、合作、轉型與成長？

AIEQ 的正式定位文字固定為：

> AIEQ 是參考四組人格偏好的 AI 時代行為傾向測評，非心理診斷，也不是官方 MBTI® 測驗。

## 2. 第一階段範圍

本階段交付：

1. 產品與技術規格。
2. 可重播、具冪等性的測評狀態機。
3. 獨立資料結構與事件格式。
4. 四組人格偏好與六項 AIEQ 能力的分離計分、信心演算法。
5. 8 題核心行為情境試題，包含正向、反向與跨情境驗證。
6. 一張 LINE Flex 三選一卡原型。
7. 一份不分高低階級的結果報告原型。
8. 卡片與自然語言回答共用事件格式的自動測試。

本階段不做：

- 不讓 16 種幾何動物圖騰參與題目證據或能力計分。
- 不串接正式 LINE webhook。
- 不部署、不修改正式饅頭服務行為。
- 不將結果寫入 `learned_facts`、核心人格、soul pack 或永久記憶。
- 不宣稱官方 MBTI、心理診斷、人才篩選或能力命定。

## 3. 系統邊界

```text
LINE 卡片 ─┐
           ├─ 通路轉接器 ─ AnswerEvent ─ AIEQ 狀態機 ─ 計分器 ─ 結果報告
自然語言 ─┘                         │
                                    └─ aieq_* 獨立資料表

饅頭人格／記憶  ←─ 只有使用者明確同意後，由未來的個人化轉接層讀取摘要
```

AIEQ 核心模組不匯入饅頭的 brain、memory 或 soul 模組。通路只負責把輸入正規化成事件；狀態機不依賴 LINE。

## 4. 兩層計算

### 4.1 四組人格偏好

- E / I：互動取向／內在加工取向。
- S / N：具體經驗／模式可能性取向。
- T / F：原則分析／人際價值取向。
- J / P：結構收斂／彈性探索取向。

這四組只描述偏好，不能推論某一型在 AI 時代必然較強或較弱。

### 4.2 六項 AIEQ 可發展能力

- AI 協作。
- 轉型速度。
- 模糊容忍。
- 主動性。
- 驗證能力。
- 持續學習。

能力分數與人格偏好分開累積證據。同一人格代碼可以有完全不同的 AIEQ 能力輪廓。

## 5. 題目設計護欄

- 只問近期、具體、可想像的行為情境，不問抽象自我評價。
- 每個人格維度至少有兩個不同場景；重要 AIEQ 能力至少有三個證據點。
- `validation` 標示 `direct`、`reverse` 或 `cross_check`，選項順序不固定方向。
- 三個選項都必須是現實中合理的策略，不使用明顯的「好答案」。
- 「不確定／跳過」不強迫配分，只降低覆蓋率與結果信心。
- 自由文字只有在唯一匹配選項時才配分；無法可靠理解時保留原文但不猜分。

## 6. 統一答案事件

所有輸入使用同一個 `AnswerEvent`：

```json
{
  "eventId": "line:webhook-event-id",
  "sessionId": "aieq_session_id",
  "source": "card | free_text | system",
  "kind": "answer | uncertain | skip | back | pause | resume",
  "occurredAt": "2026-08-09T10:00:00.000Z",
  "questionId": "q01_new_tool",
  "optionId": "a",
  "rawText": "我會先做個小實驗",
  "interpretationConfidence": 0.85
}
```

`eventId` 是冪等鍵。重複的 LINE 點擊或 webhook 重送只記一次、只轉移一次。原始事件採 append-only；目前答案另存為 projection，讓回上一題及中斷續答不破壞稽核軌跡。

## 7. 狀態機

狀態只有 `in_progress`、`paused`、`completed`：

- `answer`、`uncertain`、`skip`：寫入目前題目的答案並前進。
- `back`：撤銷最近一個有效答案的 projection，回到該題；事件歷程保留。
- `pause`：標記中斷，不接受新答案。
- `resume`：從原題繼續。
- 最後一題完成後進入 `completed`。
- 已處理過的 `eventId` 回傳成功但不再改變狀態。
- session、題號或選項不符時拒絕事件，不寫入事件歷程。

資料庫實作應在單一 transaction 中依序：插入事件（`ON CONFLICT DO NOTHING`）、鎖定 session、更新 answer projection、更新 session。若事件已存在，直接回傳目前 session。

## 8. 分數與信心

每個選項可對多個維度提供 `-1..1` 的有號證據；正負只代表兩端方向，不代表好壞。

對每一維度：

```text
balance = Σ(signal × interpretation_confidence)
          / Σ(|signal| × interpretation_confidence)

display_score = 50 + 50 × balance
```

- 人格偏好依 `balance` 的方向顯示字母，並顯示 `abs(balance)` 的偏好強度。
- AIEQ 能力顯示 0～100，但不得跨人格做高低階級命名。
- `coverage` 比較已觀察權重與題庫可用權重。
- `directional_consistency = 0.5 + 0.5 × abs(balance)`。
- `confidence = coverage × interpretation_certainty × directional_consistency`。
- 總信心為十個維度信心的平均。

信心低時，報告應寫「目前證據不足或跨情境表現不同」，不能把接近中點硬說成確定類型。

## 9. 記憶與同意

`aieq_sessions`、`aieq_answer_events`、`aieq_answers` 獨立保存。預設 `personalization_consent = false`，AIEQ 不對永久記憶做任何寫入。

未來若使用者在看完結果後明確選擇「允許饅頭參考」，才記錄同意時間。即使同意，也應只提供最少必要的摘要與撤回機制，不把原始答案複製成永久 facts。

## 10. 幾何動物視覺層

圖騰不出現在題目證據或計分程式中。結果確認後，才依四組偏好映射成 16 種粉紅／灰色幾何動物圖騰；每一種結果說明都必須同時包含：

- 在 AI 時代的自然優勢。
- 容易忽略的盲點。
- 可行的成長路線。

圖騰不可暗示稀有度、戰力、階級、錄取與淘汰。完整規範見 `docs/aieq/AIEQ-GEOMETRIC-ANIMAL-VISUAL-SYSTEM.md`。

## 11. 驗收條件

- 相同 `eventId` 送兩次，題號只前進一次。
- 卡片與自由文字選到同一選項時，產生相同有效答案與分數。
- 不確定、跳過、回上一題、中斷續答都有測試。
- MBTI 偏好證據變化不會直接改寫六項 AIEQ 能力，反之亦然。
- Flex postback 含 session、question、option，且每題只有三個正式選項。
- 所有報告含固定免責聲明與信心程度。
- 程式碼沒有寫入 `learned_facts` 或 soul/character 的路徑。
