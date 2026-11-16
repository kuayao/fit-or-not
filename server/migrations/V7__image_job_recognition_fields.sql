-- 补齐历史识别结果的分类字段，保留已有结果、图片及衣物资料；无法确定分类时使用 null。
UPDATE image_jobs j
SET result = jsonb_set(j.result, '{suggestions}', jsonb_build_object(
  'rootCategoryId', (
    SELECT COALESCE(c.parent_id, c.id)
    FROM categories c
    WHERE c.user_id = j.user_id AND c.id::text = j.result->'suggestions'->>'categoryId'
  ),
  'subcategoryName', NULL
) || (j.result->'suggestions'))
WHERE jsonb_typeof(j.result->'suggestions') = 'object'
  AND (NOT (j.result->'suggestions' ? 'rootCategoryId')
    OR NOT (j.result->'suggestions' ? 'subcategoryName'));
