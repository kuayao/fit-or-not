-- 仅修正没有单品、也没有活动任务的未结束录入；保留原图、识别结果与已有衣物。
ALTER TABLE clothing_imports DROP CONSTRAINT clothing_imports_status_check;
ALTER TABLE clothing_imports ADD CONSTRAINT clothing_imports_status_check
  CHECK(status IN ('queued','processing','review','needs-attention','confirmed','cancelled'));
UPDATE clothing_imports r SET status='needs-attention',version=version+1
WHERE status IN ('queued','processing','review')
  AND NOT EXISTS(SELECT 1 FROM clothing_import_items i WHERE i.import_id=r.id AND i.clothing_id IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM image_jobs j WHERE j.import_id=r.id AND j.status IN ('queued','running'));
UPDATE image_jobs j SET status='failed',error_code='DETECTION_INSUFFICIENT_ITEMS',
  phase='未定位到至少两件衣物，未生成单品。请补充描述重新识别，或更换照片'
FROM clothing_imports r
WHERE j.import_id=r.id AND r.status='needs-attention' AND j.kind='locate' AND j.status='succeeded'
  AND jsonb_array_length(COALESCE(j.result->'detection'->'targets','[]'::jsonb))<2;
