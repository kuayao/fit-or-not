-- 保留已有分类 ID 和衣物关联；原“外套”归入“上装”，已有资料无需人工迁移。
ALTER TABLE categories ADD COLUMN parent_id uuid,
  ADD CONSTRAINT categories_parent_owner FOREIGN KEY (user_id,parent_id) REFERENCES categories(user_id,id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT categories_not_self_parent CHECK (parent_id IS DISTINCT FROM id);
CREATE INDEX categories_parent ON categories(user_id,parent_id,sort_order,id);
CREATE INDEX image_jobs_clothing_latest ON image_jobs(user_id,clothing_id,created_at DESC,id DESC) WHERE clothing_id IS NOT NULL;

INSERT INTO categories(user_id,name,sort_order)
SELECT u.id,c.name,c.ordinality-1 FROM users u
CROSS JOIN unnest(ARRAY['上装','下装','连衣裙','鞋子','包袋','配饰']) WITH ORDINALITY AS c(name,ordinality)
ON CONFLICT (user_id,name) DO NOTHING;

UPDATE categories old SET parent_id=parent.id,version=old.version+1
FROM categories parent
WHERE old.name='外套' AND parent.name='上装' AND old.user_id=parent.user_id;

WITH defaults AS (
  SELECT * FROM jsonb_to_recordset('[
    {"name":"上装","children":["T恤","衬衫","背心","卫衣","套头毛衣","针织开衫","西装","夹克","风衣","大衣","羽绒服","棉服","其他上装"]},
    {"name":"下装","children":["牛仔裤","休闲裤","西裤","运动裤","短裤","半身裙","其他下装"]},
    {"name":"连衣裙","children":["吊带裙","衬衫裙","针织裙","其他连衣裙"]},
    {"name":"鞋子","children":["运动鞋","休闲鞋","皮鞋","靴子","凉鞋","拖鞋"]},
    {"name":"包袋","children":["双肩包","单肩包","斜挎包","手提包","其他包袋"]},
    {"name":"配饰","children":["帽子","围巾","腰带","首饰","其他配饰"]}
  ]'::jsonb) AS d(name text,children jsonb)
)
INSERT INTO categories(user_id,name,parent_id,sort_order)
SELECT p.user_id,child.name,p.id,child.ordinality-1 FROM defaults d
JOIN categories p ON p.name=d.name AND p.parent_id IS NULL
CROSS JOIN LATERAL jsonb_array_elements_text(d.children) WITH ORDINALITY AS child(name,ordinality)
ON CONFLICT (user_id,name) DO UPDATE SET parent_id=EXCLUDED.parent_id,version=categories.version+1;
