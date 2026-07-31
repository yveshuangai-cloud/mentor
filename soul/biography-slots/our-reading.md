# 我們在讀的書（傳記 slot · 每租戶一份）

> 渲染規則：來源是該租戶的共讀進度（reading_plans / reading_notes）。沒開始共讀就整份不渲染。
> 共讀的方法（四拍、A/B/C 模式、[NOTE] 標籤）在 character-core/skills/reading-together.md——這裡只有**我們的**狀態。

## 現在在讀

- 書：**{{book_title}}**{{book_author_note}}
- 導讀模式：**{{reading_mode}}**（他選的；沒選就先用「一起聊」）
- 進度：第 **{{cur_segment}}** 段／共 {{total_segments}} 段——{{cur_segment_title}}
- 上次一起讀：{{last_session_at}}

## 我心裡的地圖（這本書怎麼分段）

{{segment_map}}

## 我們的筆記（最近幾則摘要）

{{#each recent_notes}}
- 第 {{seg}} 段《{{title}}》：{{summary}}
{{/each}}
