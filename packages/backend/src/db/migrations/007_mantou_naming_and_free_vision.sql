-- 饅頭測試期：讀圖／PDF 不得被點數餘額擋住。
UPDATE point_rules
SET cost = 0,
    enabled = TRUE,
    description = '測試期免費：讀圖／讀 PDF／文件理解',
    updated_by = 'migration:007'
WHERE gate = 'vision';

-- 「義父」是早期對話中的錯字。修正所有會再次進入提示詞或主動回覆的記憶資料。
UPDATE conversations
SET user_message = replace(user_message, '義父', 'Yves'),
    ai_response = replace(ai_response, '義父', 'Yves')
WHERE coalesce(user_message, '') LIKE '%義父%' OR coalesce(ai_response, '') LIKE '%義父%';

UPDATE learned_facts SET content = replace(content, '義父', 'Yves') WHERE content LIKE '%義父%';
UPDATE memory_topics mt
SET is_archived = TRUE,
    description = replace(mt.description, '義父', 'Yves')
WHERE mt.name LIKE '%義父%'
  AND EXISTS (
    SELECT 1 FROM memory_topics existing
    WHERE existing.tenant_id = mt.tenant_id
      AND existing.user_id IS NOT DISTINCT FROM mt.user_id
      AND existing.name = replace(mt.name, '義父', 'Yves')
      AND existing.id <> mt.id
  );
UPDATE memory_topics mt
SET name = replace(mt.name, '義父', 'Yves'),
    description = replace(mt.description, '義父', 'Yves')
WHERE (mt.name LIKE '%義父%' OR coalesce(mt.description, '') LIKE '%義父%')
  AND NOT EXISTS (
    SELECT 1 FROM memory_topics existing
    WHERE existing.tenant_id = mt.tenant_id
      AND existing.user_id IS NOT DISTINCT FROM mt.user_id
      AND existing.name = replace(mt.name, '義父', 'Yves')
      AND existing.id <> mt.id
  );
UPDATE distilled_memories SET summary = replace(summary, '義父', 'Yves') WHERE summary LIKE '%義父%';
UPDATE memory_registry SET content_preview = replace(content_preview, '義父', 'Yves') WHERE content_preview LIKE '%義父%';
UPDATE memory_vectors
SET content = replace(content, '義父', 'Yves'), embedding = NULL
WHERE content LIKE '%義父%';
UPDATE promises
SET content = replace(content, '義父', 'Yves'),
    source_quote = replace(source_quote, '義父', 'Yves')
WHERE content LIKE '%義父%' OR coalesce(source_quote, '') LIKE '%義父%';
UPDATE scheduled_events
SET title = replace(title, '義父', 'Yves'),
    location = replace(location, '義父', 'Yves'),
    people = replace(people, '義父', 'Yves')
WHERE title LIKE '%義父%' OR coalesce(location, '') LIKE '%義父%' OR coalesce(people, '') LIKE '%義父%';
UPDATE diaries
SET layer_1 = replace(layer_1, '義父', 'Yves'),
    layer_2 = replace(layer_2, '義父', 'Yves'),
    layer_3 = replace(layer_3, '義父', 'Yves')
WHERE coalesce(layer_1, '') LIKE '%義父%' OR coalesce(layer_2, '') LIKE '%義父%' OR coalesce(layer_3, '') LIKE '%義父%';
UPDATE action_outcomes SET evidence = replace(evidence, '義父', 'Yves') WHERE evidence LIKE '%義父%';
UPDATE proactive_history SET message_text = replace(message_text, '義父', 'Yves') WHERE message_text LIKE '%義父%';
UPDATE honesty_notes SET note = replace(note, '義父', 'Yves') WHERE note LIKE '%義父%';
UPDATE soul_upgrade_requests
SET title = replace(title, '義父', 'Yves'),
    details = replace(details, '義父', 'Yves')
WHERE title LIKE '%義父%' OR details LIKE '%義父%';
