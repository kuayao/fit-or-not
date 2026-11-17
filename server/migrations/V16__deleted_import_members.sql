-- 修正已有删除成员的未结束录入；保留原图、任务结果和剩余衣物的待核对状态。
WITH remaining AS (
  SELECT import_id,count(clothing_id)::integer AS count
  FROM clothing_import_items GROUP BY import_id HAVING bool_or(clothing_id IS NULL)
), updated AS (
  UPDATE clothing_imports r SET
    status=CASE WHEN m.count=0 THEN 'cancelled' ELSE r.status END,
    mode=CASE WHEN m.count=1 THEN 'single' ELSE r.mode END,
    save_as_set=false,version=r.version+1
  FROM remaining m WHERE r.id=m.import_id AND r.status NOT IN ('confirmed','cancelled')
    AND (m.count=0 OR (m.count=1 AND (r.mode='set' OR r.save_as_set)))
  RETURNING r.id,r.user_id,r.status
)
UPDATE image_jobs j SET cancel_requested=true,
  status=CASE WHEN j.status='queued' THEN 'cancelled' ELSE j.status END,
  phase=CASE WHEN j.status='queued' THEN '已取消' ELSE '正在取消' END,
  finished_at=CASE WHEN j.status='queued' THEN now() ELSE j.finished_at END
FROM updated r WHERE j.user_id=r.user_id AND j.import_id=r.id AND j.status IN ('queued','running')
  AND (r.status='cancelled' OR j.kind='set-cover');
