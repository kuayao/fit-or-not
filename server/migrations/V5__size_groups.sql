-- 分类保存稳定的尺码分组，改名不影响筛选；二级分类继承一级分类。
ALTER TABLE categories ADD COLUMN size_kind text NOT NULL DEFAULT 'clothing-size'
  CHECK (size_kind IN ('clothing-size','shoe-size'));
UPDATE categories SET size_kind='shoe-size' WHERE parent_id IS NULL AND name='鞋子';
UPDATE categories c SET size_kind=p.size_kind FROM categories p WHERE c.parent_id=p.id AND c.user_id=p.user_id;

ALTER TABLE clothing_options DROP CONSTRAINT clothing_options_kind_check;
ALTER TABLE clothing_options ADD CONSTRAINT clothing_options_kind_check CHECK (kind IN ('brand','size','clothing-size','shoe-size','material'));

-- 根据已有衣物分类拆分旧尺码；同时用于服装与鞋子的尺码各保留一项并更新关联。
CREATE TEMP TABLE size_groups ON COMMIT DROP AS
SELECT o.id AS old_id,o.user_id,o.name,o.sort_order,
  COALESCE(p.size_kind,c.size_kind,'clothing-size') AS kind
FROM clothing_options o JOIN clothes item ON item.user_id=o.user_id AND item.size_id=o.id
LEFT JOIN categories c ON c.user_id=item.user_id AND c.id=item.category_id
LEFT JOIN categories p ON p.user_id=c.user_id AND p.id=c.parent_id
WHERE o.kind='size'
UNION
SELECT o.id,o.user_id,o.name,o.sort_order,
  CASE WHEN o.name ~ '^[0-9]+([.][0-9]+)?$' THEN 'shoe-size' ELSE 'clothing-size' END
FROM clothing_options o WHERE o.kind='size' AND NOT EXISTS (SELECT 1 FROM clothes c WHERE c.user_id=o.user_id AND c.size_id=o.id);

UPDATE clothing_options o SET kind=g.kind FROM (
  SELECT DISTINCT ON (old_id) old_id,kind FROM size_groups ORDER BY old_id,kind
) g WHERE o.id=g.old_id;
INSERT INTO clothing_options(user_id,kind,name,sort_order)
SELECT g.user_id,g.kind,g.name,g.sort_order FROM size_groups g
ON CONFLICT(user_id,kind,name) DO NOTHING;
UPDATE clothes item SET size_id=o.id,version=item.version+1,updated_at=now()
FROM categories c LEFT JOIN categories p ON p.user_id=c.user_id AND p.id=c.parent_id,
  size_groups g JOIN clothing_options o ON o.user_id=g.user_id AND o.kind=g.kind AND o.name=g.name
WHERE item.user_id=c.user_id AND item.category_id=c.id AND item.user_id=g.user_id AND item.size_id=g.old_id
  AND g.kind=COALESCE(p.size_kind,c.size_kind,'clothing-size') AND item.size_id<>o.id;

ALTER TABLE clothing_options DROP CONSTRAINT clothing_options_kind_check;
ALTER TABLE clothing_options ADD CONSTRAINT clothing_options_kind_check CHECK (kind IN ('brand','clothing-size','shoe-size','material'));
