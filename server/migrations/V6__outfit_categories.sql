-- 新增用户独立维护的搭配分类；已有搭配保留原有资料，分类为空。
CREATE TABLE outfit_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name=btrim(name) AND length(name) BETWEEN 1 AND 12),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,id), UNIQUE(user_id,name)
);
CREATE INDEX outfit_categories_list ON outfit_categories(user_id,created_at,id);

ALTER TABLE outfits ADD COLUMN category_id uuid,
  ADD CONSTRAINT outfits_category_owner FOREIGN KEY(user_id,category_id) REFERENCES outfit_categories(user_id,id);
CREATE INDEX outfits_category_list ON outfits(user_id,category_id,created_at DESC,id DESC);
