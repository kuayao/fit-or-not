-- 新增录入与套装结构；历史衣物、任务及图片原样保留，历史衣物默认无套装。
CREATE TABLE clothing_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 60), cover_asset_id uuid,
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,id), FOREIGN KEY(user_id,cover_asset_id) REFERENCES media_assets(user_id,id)
);
ALTER TABLE clothes ADD COLUMN set_id uuid,
  ADD CONSTRAINT clothes_set_owner FOREIGN KEY(user_id,set_id) REFERENCES clothing_sets(user_id,id) ON DELETE SET NULL(set_id);
CREATE INDEX clothes_set_members ON clothes(user_id,set_id,id) WHERE set_id IS NOT NULL;
CREATE INDEX clothing_sets_list ON clothing_sets(user_id,created_at DESC,id DESC);
CREATE TABLE clothing_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  input_asset_id uuid NOT NULL, mode text NOT NULL CHECK(mode IN ('single','set')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','review','confirmed','cancelled')),
  name text NOT NULL DEFAULT '', save_as_set boolean NOT NULL DEFAULT false, cover_asset_id uuid,
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz,
  UNIQUE(user_id,id), FOREIGN KEY(user_id,input_asset_id) REFERENCES media_assets(user_id,id),
  FOREIGN KEY(user_id,cover_asset_id) REFERENCES media_assets(user_id,id)
);
CREATE INDEX clothing_imports_list ON clothing_imports(user_id,created_at DESC,id DESC);
CREATE TABLE clothing_import_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  import_id uuid NOT NULL, clothing_id uuid, target_key text NOT NULL, target jsonb,
  included boolean NOT NULL DEFAULT true, UNIQUE(user_id,id), UNIQUE(import_id,target_key), UNIQUE(clothing_id),
  FOREIGN KEY(user_id,import_id) REFERENCES clothing_imports(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,clothing_id) REFERENCES clothes(user_id,id) ON DELETE SET NULL(clothing_id)
);
ALTER TABLE image_jobs ADD COLUMN import_id uuid, ADD COLUMN import_item_id uuid,
  ADD CONSTRAINT image_jobs_import_owner FOREIGN KEY(user_id,import_id) REFERENCES clothing_imports(user_id,id) ON DELETE CASCADE,
  ADD CONSTRAINT image_jobs_import_item_owner FOREIGN KEY(user_id,import_item_id) REFERENCES clothing_import_items(user_id,id) ON DELETE CASCADE;
ALTER TABLE image_jobs DROP CONSTRAINT image_jobs_kind_check;
ALTER TABLE image_jobs ADD CONSTRAINT image_jobs_kind_check CHECK(kind IN ('process','cutout','classify','outfit-cover','locate'));
DROP INDEX image_jobs_active_input;
CREATE UNIQUE INDEX image_jobs_active_input ON image_jobs(user_id,input_asset_id,kind)
  WHERE status IN ('queued','running') AND input_asset_id IS NOT NULL AND import_item_id IS NULL;
CREATE UNIQUE INDEX image_jobs_active_member ON image_jobs(user_id,import_item_id,kind)
  WHERE status IN ('queued','running') AND import_item_id IS NOT NULL;
CREATE INDEX image_jobs_import ON image_jobs(user_id,import_id,created_at,id);
CREATE FUNCTION prune_clothing_set() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.set_id IS NOT NULL AND (SELECT count(*) FROM clothes WHERE user_id=OLD.user_id AND set_id=OLD.set_id)<2 THEN
    DELETE FROM clothing_sets WHERE user_id=OLD.user_id AND id=OLD.set_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER clothing_set_membership AFTER UPDATE OF set_id OR DELETE ON clothes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prune_clothing_set();
