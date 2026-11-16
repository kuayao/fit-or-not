-- 按本次发布要求清空测试业务数据，保留用户整行资料、头像资源和迁移历史。
-- 为每位已有用户重建 11 个一级分类，不预置二级分类；由迁移器事务和执行记录保证仅执行一次。
DELETE FROM external_jobs;
DELETE FROM data_exports;
DELETE FROM idempotency_keys;
DELETE FROM image_jobs;
DELETE FROM packing_items;
DELETE FROM packing_lists;
DELETE FROM wear_items;
DELETE FROM wear_records;
DELETE FROM outfit_items;
DELETE FROM outfits;
DELETE FROM outfit_categories;
DELETE FROM clothing_assets;
DELETE FROM clothing_tags;
DELETE FROM clothes;
DELETE FROM clothing_options;
DELETE FROM tags;
DELETE FROM categories;
DELETE FROM sessions;
DELETE FROM registrations;
DELETE FROM invitations;

WITH RECURSIVE avatar_assets AS (
  SELECT a.id,a.user_id,a.parent_asset_id
  FROM media_assets a JOIN users u ON u.id=a.user_id AND u.avatar_asset_id=a.id
  UNION
  SELECT a.id,a.user_id,a.parent_asset_id
  FROM media_assets a JOIN avatar_assets kept ON a.user_id=kept.user_id
    AND (a.id=kept.parent_asset_id OR a.parent_asset_id=kept.id)
)
DELETE FROM media_assets a WHERE NOT EXISTS (SELECT 1 FROM avatar_assets kept WHERE kept.id=a.id);

INSERT INTO categories(user_id,name,sort_order,size_kind)
SELECT u.id,c.name,c.ordinality-1,
  CASE WHEN c.name='鞋靴' THEN 'shoe-size' ELSE 'clothing-size' END
FROM users u
CROSS JOIN unnest(ARRAY['上衣','外套','裤子','裙子','连衣裙','鞋靴','箱包','配饰','眼镜','帽子','其他'])
  WITH ORDINALITY AS c(name,ordinality);

