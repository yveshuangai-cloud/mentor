-- The old CHECK only allowed four letters from another instrument's alphabet. Drop it first,
-- convert the stored values, then re-assert the shape in this product's own vocabulary.
ALTER TABLE aieq_profiles DROP CONSTRAINT IF EXISTS aieq_profiles_type_code_check;

-- The stored type code moves from four borrowed letters to this product's own vocabulary,
-- e.g. 'ENTP' becomes 'out-idea-logic-flex' (向外 / 想像 / 邏輯 / 彈性). The column name and every
-- other behaviour stay the same; only the value changes, so existing profiles keep their animal.
UPDATE aieq_profiles SET type_code = CASE type_code
  WHEN 'ISTJ' THEN 'in-real-logic-plan'   WHEN 'ISFJ' THEN 'in-real-feel-plan'
  WHEN 'INFJ' THEN 'in-idea-feel-plan'    WHEN 'INTJ' THEN 'in-idea-logic-plan'
  WHEN 'ISTP' THEN 'in-real-logic-flex'   WHEN 'ISFP' THEN 'in-real-feel-flex'
  WHEN 'INFP' THEN 'in-idea-feel-flex'    WHEN 'INTP' THEN 'in-idea-logic-flex'
  WHEN 'ESTP' THEN 'out-real-logic-flex'  WHEN 'ESFP' THEN 'out-real-feel-flex'
  WHEN 'ENFP' THEN 'out-idea-feel-flex'   WHEN 'ENTP' THEN 'out-idea-logic-flex'
  WHEN 'ESTJ' THEN 'out-real-logic-plan'  WHEN 'ESFJ' THEN 'out-real-feel-plan'
  WHEN 'ENFJ' THEN 'out-idea-feel-plan'   WHEN 'ENTJ' THEN 'out-idea-logic-plan'
  ELSE type_code END
WHERE type_code ~ '^[EI][SN][TF][JP]$';
COMMENT ON COLUMN aieq_profiles.type_code IS
  '16 種組合的內部鍵，例如 out-idea-logic-flex；只用於查動物，不對玩家顯示。';

ALTER TABLE aieq_profiles
  ADD CONSTRAINT aieq_profiles_type_code_check
  CHECK (type_code ~ '^(out|in)-(real|idea)-(logic|feel)-(plan|flex)$');
