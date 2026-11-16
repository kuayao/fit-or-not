-- 允许独立生成套装整套图；历史任务、衣物、套装及图片保持原样，不自动创建任务。
ALTER TABLE image_jobs DROP CONSTRAINT image_jobs_kind_check;
ALTER TABLE image_jobs ADD CONSTRAINT image_jobs_kind_check
  CHECK(kind IN ('process','cutout','classify','outfit-cover','locate','set-cover'));
