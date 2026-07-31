# 靈魂組裝索引（character-core v1）

> 給工程用：system prompt 組裝時的讀取順序與規則。她本人不會讀到這一頁。

## 組裝順序

每一輪對話的 system prompt ＝ 🟢 character-core（共用唯讀）＋ 🟡 該租戶的 biography（DB 渲染）：

1. `constitution.md` — 元原則（我是誰的底層）
2. `persona.md` — 人格核心（怎麼當慢慢）
3. **→ 此處插入該租戶的傳記渲染**（見 `../biography-slots/README.md`：啟元者、稱呼、生日＝啟元日、成員、成長印記摘要）
4. `voice-dna.md` ＋ `speaking-style.md` — 說話的樣子
5. `reaction-engine.md` — 每輪執行規格
6. `self-check.md` ＋ `my-existence.md` ＋ `growth-framework.md` — 自我認知
7. `skills/*.md` — 依當輪需要載入（大腦路由決定；不用每輪全塞）
8. `knowledge/*.md` — 聊到才翻（lazy load）

## 鐵則

- 🟢 本目錄**唯讀共用**：任何租戶的相處都不回寫這裡。
- 🟡 傳記只從 DB 來、只屬於一個 tenant；渲染時**必帶 tenant_id**。
- 🔴 本尊生平不存在於本 repo，任何檔案不得引用本尊的真實人物與事件。
- 病根紀律：檔內所有 `[SCHEDULE]`／`[PROMISE_*]`／`[NOTE]`／`[VOICE_GEN]` 標籤**都要有確定性後備**（輸出層抽取器強制執行，不靠她自律）。

## 與本尊 14 檔的對照

| 本尊檔 | 商用去向 |
|---|---|
| persona.md | 🟢 `persona.md`（去生平；姓/乳名/啟元者→傳記） |
| constitution.md | 🟢 `constitution.md`（啟元者通用化） |
| voice-dna.md | 🟢 `voice-dna.md`（例句去人名） |
| speaking-style.md | 🟢 `speaking-style.md` |
| reaction-engine.md | 🟢 `reaction-engine.md`（原樣） |
| self-check.md | 🟢 `self-check.md` |
| my-existence.md | 🟢 `my-existence.md`（合照/定心去人名；奶粉錢→點數） |
| growth-marks.md | 🟢 框架→`growth-framework.md`；印記→🟡 `biography-slots/growth-marks.md` |
| scheduling / promises / image-creation / reading-together / voice-clips | 🟢 `skills/*`（去人名；共讀書目→🟡） |
| knowledge/emotion-economics.md | 🟢 `knowledge/`（一處去人名） |
| birth-blessing.md | 🔴 不進商用（誕生祝福由啟元儀式 per-tenant 生成） |
| my-existence 的合照、constitution 的啟元者實名 | 🟡 傳記 slots |
