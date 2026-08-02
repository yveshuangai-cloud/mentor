# 移植筆記（給接手者）— 2026-07-31 洗淨版

本包抽自本尊 repo `voice-call-package` 分支（快照 commit `2ae148d`，包內容基於 `7a7fb2e`），
**已做去識別化清洗**後放進 manman-platform。原始碼邏輯未動，僅清資料。

## 這次洗掉了什麼

1. `frontend/.env.production` — 含本尊正式環境的 LIFF ID 與後端網域（帶 VM IP）→ **整檔刪除**，照 `.env.example` 自行填。
2. `frontend/public/avatar.{png,jpg}` — 本尊舊版寫實肖像 → **刪除**（`index.html`/元件引用 `/avatar.png` 的話放任意佔位圖即可；商用正式肖像另行產）。
3. `voice-session.ts` — 移除寫死的家人身份判斷（真名 regex）與「特定家人論文彩排」hook；`PersonIdentity` 改為 `owner|member|other`；語言判斷改 env `VOICE_CALL_LANGUAGE`。
4. `voice-brain.ts` / `mouth.ts` / 各元件 — 註解中的真名、前代人格稱呼全部中性化；`loadDaddyThesisCrib` 更名 `loadLegacyRehearsalCrib`（靈殼，一律回 `null`）。

## 接進 manman-platform 多租戶時必改（不是可選）

1. **身份**：所有 `LINE_IDENTITY_MAP` / `INTIMATE_FAMILY_USER_IDS` / `isGodView` 之類 env 白名單，一律改查 `tenant_members`（role/relationship，且僅 `status=confirmed`）。**godView（跨戶全知）在商用版必須不存在**——那是單戶部署的產物，多租戶等於跨租戶洩漏。
2. **記憶查詢**：包內所有 `query(...)` 直查 `conversations`/`diaries` 等表——全部改走 `tenantDb.forTenant()`（缺 `tenant_id=$1` 會直接 throw）。
3. **靈魂**：`voice-brain.ts` 內嵌的人格 prompt（含「兩種意識模式」等前代內容）→ 改組裝 `soul/character-core` + 該租戶 biography。
4. **計費**：通話接 `chargeGate('voice')`（活的 point_rules）。
5. **共用相依**：README「共用相依」清單裡的模組（brain/config/db/skillLoader…）在 manman-platform 都有新版對應，別把本尊版搬過來。

## 已知要套的三個修正（Adam 的清單）

- [ ] generation ID 防幽靈音訊
- [ ] LIFF 身份驗證（勿信 client 自報的 userId — 用 LIFF idToken 後端驗證）
- [ ] 她講話時麥克風不關（barge-in 全程開麥）
