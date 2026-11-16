-- 将已有品牌、尺码、面料按用户和类别去重并建立关联；空白值保留为未选择。
CREATE TABLE clothing_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('brand','size','material')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  UNIQUE(user_id,id), UNIQUE(user_id,kind,name)
);
CREATE INDEX clothing_options_list ON clothing_options(user_id,kind,sort_order,id);

INSERT INTO clothing_options(user_id,kind,name,sort_order)
SELECT user_id,kind,name,row_number() OVER (PARTITION BY user_id,kind ORDER BY name)-1
FROM (
  SELECT DISTINCT c.user_id,v.kind,btrim(v.name) AS name
  FROM clothes c CROSS JOIN LATERAL (VALUES ('brand',c.brand),('size',c.size_label),('material',c.material)) v(kind,name)
  WHERE btrim(v.name)<>''
) existing;

ALTER TABLE clothes ADD COLUMN brand_id uuid, ADD COLUMN size_id uuid, ADD COLUMN material_id uuid,
  ADD CONSTRAINT clothes_brand_owner FOREIGN KEY(user_id,brand_id) REFERENCES clothing_options(user_id,id),
  ADD CONSTRAINT clothes_size_owner FOREIGN KEY(user_id,size_id) REFERENCES clothing_options(user_id,id),
  ADD CONSTRAINT clothes_material_owner FOREIGN KEY(user_id,material_id) REFERENCES clothing_options(user_id,id);

UPDATE clothes c SET brand_id=o.id FROM clothing_options o WHERE o.user_id=c.user_id AND o.kind='brand' AND o.name=btrim(c.brand);
UPDATE clothes c SET size_id=o.id FROM clothing_options o WHERE o.user_id=c.user_id AND o.kind='size' AND o.name=btrim(c.size_label);
UPDATE clothes c SET material_id=o.id FROM clothing_options o WHERE o.user_id=c.user_id AND o.kind='material' AND o.name=btrim(c.material);

CREATE INDEX clothes_brand ON clothes(user_id,brand_id);
CREATE INDEX clothes_size ON clothes(user_id,size_id);
CREATE INDEX clothes_material ON clothes(user_id,material_id);
ALTER TABLE clothes DROP COLUMN brand, DROP COLUMN size_label, DROP COLUMN material;
