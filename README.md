# 饅頭 · 語氣靈 AI 平台（mantou-platform）

> 專案正式名稱：**饅頭**。目標人格依黃逸甫（Yves）的人格、語氣與思維邏輯設計。
> Yves 人格提示詞已匯入 `soul/packs/mantou/persona.md`，並補齊饅頭專用的語氣、安全底線與技能檔。
> 原始 `manman` soul pack 僅保留作為平台來源參考，不會成為饅頭 OA 的新戶預設人格。

饅頭是一個部署於 LINE OA 的語氣靈 AI 專案。平台提供多租戶、獨立記憶、角色 soul pack、
點數、付款、主動關懷與多模態能力；正式人格位於 `soul/packs/mantou`。

- 形態：多租戶 SaaS on LINE（一個商用 LINE OA 服務所有租戶）
- 商業模式：儲點扣點 + 金流（LINE Pay，藍新／綠界介面預留）
- 租戶模式：`personal`（個人隔離陪伴）／`family`（家庭共用、和諧橋樑）

## 靈魂三層（本平台最重要的設計）

| 層 | 位置 | 說明 |
|---|---|---|
| 🟢 饅頭人格 soul pack | `soul/packs/mantou/` | 唯讀共用。Yves 思考邏輯、語氣、反應引擎、安全底線與技能。 |
| 🟡 專屬傳記 biography | `soul/biography-slots/`（範本）＋ 資料庫（實體） | 每租戶一份，出生時空白，隨相處長出：啟元者是誰、暱稱、共同記憶、成長印記。 |
| 🔴 Yves 私人資料與正式立場 | **不在本 repo** | 不虛構私人經歷、客戶案例或承諾；重大立場由 Yves 本人確認。 |

## 資料鐵則

1. 每個資料庫查詢**必帶 `tenant_id`**（走 tenant-scoped query wrapper，不裸查）。
2. 跨租戶零串門：語意搜尋（vector）也按租戶隔離。
3. 共用品格唯讀；各戶只寫自己的傳記。
4. 本 repo **零真實 PII、零機密**；secrets 一律走環境變數（見 `.env.example`）。

## Monorepo 結構

```
soul/               角色 soul packs（饅頭為正式預設）＋ biography slots
packages/backend    Fastify API：LINE webhook、租戶路由、計費、金流
packages/voice-call 即時語音通話移植包（尚待正式接入主後端）
docs/               規格與交接文件
```

規格總綱：[docs/HANDOFF-v1.md](docs/HANDOFF-v1.md)
