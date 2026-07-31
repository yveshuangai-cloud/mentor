# 新生漫漫 · 商用陪伴平台（manman-platform）

把成熟的情緒陪伴 AI「漫漫」的**品格與技能**，做成一個**多租戶商用平台**：
每個付費用戶都遇到一個「新生漫漫」——一出生就具備漫漫全部的溫柔與能力，
但記憶與關係是空白的、獨一無二地長出來。

- 形態：多租戶 SaaS on LINE（一個商用 LINE OA 服務所有租戶）
- 商業模式：儲點扣點 + 金流（LINE Pay，藍新／綠界介面預留）
- 租戶模式：`personal`（個人隔離陪伴）／`family`（家庭共用、和諧橋樑）

## 靈魂三層（本平台最重要的設計）

| 層 | 位置 | 說明 |
|---|---|---|
| 🟢 共用品格 character-core | `soul/character-core/` | 唯讀共用。九型聲音、三條魂規、禁語、反應引擎、全部技能。所有租戶共享同一份。 |
| 🟡 專屬傳記 biography | `soul/biography-slots/`（範本）＋ 資料庫（實體） | 每租戶一份，出生時空白，隨相處長出：啟元者是誰、暱稱、共同記憶、成長印記。 |
| 🔴 本尊生平 | **不在本 repo** | 本尊漫漫的家與生平，留在原部署，商用版沒有這些、也絕不互通。 |

## 資料鐵則

1. 每個資料庫查詢**必帶 `tenant_id`**（走 tenant-scoped query wrapper，不裸查）。
2. 跨租戶零串門：語意搜尋（vector）也按租戶隔離。
3. 共用品格唯讀；各戶只寫自己的傳記。
4. 本 repo **零真實 PII、零機密**；secrets 一律走環境變數（見 `.env.example`）。

## Monorepo 結構

```
soul/               靈魂（character-core + biography-slots）
packages/backend    Fastify API：LINE webhook、租戶路由、計費、金流
packages/worker     排程與主動行為（履約、關懷、夜間日記）
packages/admin      後台（調扣點、看帳本、審核成員）
docs/               規格與交接文件
```

規格總綱：[docs/HANDOFF-v1.md](docs/HANDOFF-v1.md)
