import { Router } from 'express';
import { z } from 'zod';
import type { Clothing } from '../../miniprogram/api/contracts.js';
import { clothingInputSchema, clothingPatchSchema, clothingBatchSchema, idSchema, colors, seasons } from '../../miniprogram/api/contracts.js';
import { pool, transaction } from './db.js';
import type { Database } from './db.js';
import { HttpError, notFound, versionConflict } from './errors.js';
import { idempotent } from './idempotency.js';
import { config } from './config.js';

export const clothingColumns = `c.id,c.name,c.set_id AS "setId",
  EXISTS(SELECT 1 FROM clothing_import_items i JOIN clothing_imports r ON r.id=i.import_id AND r.user_id=i.user_id WHERE i.user_id=c.user_id AND i.clothing_id=c.id AND r.status NOT IN ('confirmed','cancelled') AND r.mode='single' AND NOT r.save_as_set AND (SELECT count(*) FROM clothing_import_items m WHERE m.import_id=r.id AND m.clothing_id IS NOT NULL)=1) AS "singleImport",
  (SELECT i.import_id FROM clothing_import_items i JOIN clothing_imports r ON r.id=i.import_id AND r.user_id=i.user_id WHERE i.user_id=c.user_id AND i.clothing_id=c.id AND r.status NOT IN ('confirmed','cancelled')) AS "importId",
  (SELECT jsonb_build_object('id',s.id,'name',s.name,'coverAssetId',s.cover_asset_id,'version',s.version,
    'memberCount',(SELECT count(*) FROM clothes m WHERE m.user_id=c.user_id AND m.set_id=s.id),
    'members',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'categoryName',mc.name,'primaryAssetId',m.primary_asset_id,'status',m.status) ORDER BY m.created_at,m.id)
      FROM clothes m LEFT JOIN categories mc ON mc.user_id=m.user_id AND mc.id=m.category_id WHERE m.user_id=c.user_id AND m.set_id=s.id AND m.id<>c.id),'[]'))
    FROM clothing_sets s WHERE s.user_id=c.user_id AND s.id=c.set_id) AS "clothingSet",c.category_id AS "categoryId",NULLIF(concat_ws(' / ',parent_cat.name,cat.name),'') AS "categoryName",c.primary_asset_id AS "primaryAssetId",
  c.colors,c.seasons,c.brand_id AS "brandId",c.size_id AS "sizeId",c.material_id AS "materialId",
  COALESCE(brand.name,'') AS brand,COALESCE(size.name,'') AS "sizeLabel",COALESCE(material.name,'') AS material,c.price_cents::text AS "priceCents",c.purchased_on AS "purchasedOn",
  c.notes,c.favorite,c.status,c.version,c.created_at AS "createdAt",c.updated_at AS "updatedAt",
  c.item_type AS "itemType",c.color_description AS "colorDescription",c.pattern,c.visible_features AS "visibleFeatures",
  latest_job.status AS "processingStatus",latest_job.phase AS "processingPhase",latest_job.id AS "processingJobId",
  ARRAY(SELECT ct.tag_id FROM clothing_tags ct WHERE ct.user_id=c.user_id AND ct.clothing_id=c.id ORDER BY ct.tag_id) AS "tagIds",
  ARRAY(SELECT ca.asset_id FROM clothing_assets ca WHERE ca.user_id=c.user_id AND ca.clothing_id=c.id AND ca.role='detail' ORDER BY ca.sort_order) AS "detailAssetIds",
  (SELECT count(DISTINCT wr.worn_on)::integer FROM wear_items wi JOIN wear_records wr ON wr.id=wi.wear_record_id AND wr.user_id=wi.user_id WHERE wi.clothing_id=c.id AND wi.user_id=c.user_id) AS "wearCount",
  (SELECT max(wr.worn_on) FROM wear_items wi JOIN wear_records wr ON wr.id=wi.wear_record_id AND wr.user_id=wi.user_id WHERE wi.clothing_id=c.id AND wi.user_id=c.user_id) AS "lastWornOn"`;
export const clothingFrom = `FROM clothes c LEFT JOIN categories cat ON cat.id=c.category_id AND cat.user_id=c.user_id
  LEFT JOIN clothing_options brand ON brand.id=c.brand_id AND brand.user_id=c.user_id
  LEFT JOIN clothing_options size ON size.id=c.size_id AND size.user_id=c.user_id
  LEFT JOIN clothing_options material ON material.id=c.material_id AND material.user_id=c.user_id
  LEFT JOIN categories parent_cat ON parent_cat.id=cat.parent_id AND parent_cat.user_id=c.user_id
  LEFT JOIN LATERAL (SELECT j.id,j.status,j.phase FROM image_jobs j WHERE j.user_id=c.user_id AND j.clothing_id=c.id ORDER BY j.created_at DESC,j.id DESC LIMIT 1) latest_job ON true`;
export async function readClothing(db: Database, userId: string, id: string) {
  const result = await db.query<Clothing>(`SELECT ${clothingColumns} ${clothingFrom} WHERE c.user_id=$1 AND c.id=$2`, [userId, id]);
  if (!result.rows.length) notFound();
  return result.rows[0];
}
export const pageQuerySchema = z.object({ page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) });
export function today(timezone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export async function requireAssets(db: Database, userId: string, ids: string[], kinds: string[]) {
  const unique = [...new Set(ids)];
  const result = await db.query<{ id: string }>("SELECT id FROM media_assets WHERE user_id=$1 AND id=ANY($2::uuid[]) AND kind=ANY($3::text[]) AND status='ready' FOR SHARE", [userId, unique, kinds]);
  if (result.rows.length !== unique.length) throw new HttpError(404, 'RESOURCE_NOT_FOUND', '图片不存在、用途不符或不可访问');
}
export async function requireClothes(db: Database, userId: string, ids: string[], retainedIds: string[] = []) {
  const unique = [...new Set(ids)];
  const result = await db.query<{ id: string }>("SELECT id FROM clothes WHERE user_id=$1 AND id=ANY($2::uuid[]) AND (status='active' OR (status='archived' AND id=ANY($3::uuid[]))) FOR SHARE", [userId, unique, retainedIds]);
  if (result.rows.length !== unique.length) throw new HttpError(422, 'CLOTHING_UNAVAILABLE', '所选衣物不存在、已归档或不可访问');
}
export async function saveClothing(db: Database, userId: string, input: z.infer<typeof clothingInputSchema>, timezone: string, current?: Clothing, processingJobId?: string) {
  if (current) await requireClothingEditable(db, userId, current.id, processingJobId);
  if (current?.importId && input.status !== 'draft') throw new HttpError(409, 'IMPORT_CONFIRM_REQUIRED', '请在整组审核中确认入橱');
  if (input.status === 'active' && !input.categoryId) throw new HttpError(400, 'CATEGORY_REQUIRED', '请先选择分类');
  if (input.purchasedOn && input.purchasedOn > today(timezone)) throw new HttpError(400, 'FUTURE_DATE', '购买日期不能晚于今天');
  await requireAssets(db, userId, [input.primaryAssetId, ...input.detailAssetIds], ['original', 'cutout']);
  const category = input.categoryId ? await db.query<{ name: string; sizeKind: string }>('SELECT c.name,root.size_kind AS "sizeKind" FROM categories c JOIN categories root ON root.user_id=c.user_id AND root.id=COALESCE(c.parent_id,c.id) WHERE c.user_id=$1 AND c.id=$2 FOR SHARE OF c,root', [userId, input.categoryId]) : null;
  if (category && !category.rows.length) notFound();
  const tagIds = [...new Set(input.tagIds)];
  if (tagIds.length) {
    const result = await db.query('SELECT id FROM tags WHERE user_id=$1 AND id=ANY($2::uuid[]) FOR SHARE', [userId, tagIds]);
    if (result.rows.length !== tagIds.length) notFound();
  }
  const options = await db.query<{ id: string; kind: string }>('SELECT id,kind FROM clothing_options WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE', [userId, [input.brandId, input.sizeId, input.materialId].filter(Boolean)]);
  const sizeId = current && current.categoryId !== input.categoryId && input.sizeId === current.sizeId && !options.rows.some(item => item.id === input.sizeId && item.kind === category?.rows[0].sizeKind) ? null : input.sizeId;
  for (const [kind, id] of [['brand', input.brandId], [category?.rows[0].sizeKind, sizeId], ['material', input.materialId]] as const) {
    if (id && !options.rows.some(item => item.id === id && item.kind === kind)) throw new HttpError(422, 'CLOTHING_OPTION_INVALID', '所选品牌、尺码或面料不存在，请从维护列表重新选择');
  }
  const values = [userId, input.name || category?.rows[0].name || (input.status === 'draft' ? '' : '未命名衣物'), input.categoryId, input.primaryAssetId, input.status, input.colors, input.seasons, input.brandId, sizeId, input.materialId, input.priceCents, input.purchasedOn, input.notes, input.favorite, input.itemType, input.colorDescription, input.pattern, input.visibleFeatures];
  const saved = current
    ? await db.query<{ id: string }>(`UPDATE clothes SET name=$2,category_id=$3,primary_asset_id=$4,status=$5,colors=$6,seasons=$7,brand_id=$8,size_id=$9,material_id=$10,price_cents=$11,purchased_on=$12,notes=$13,favorite=$14,item_type=$15,color_description=$16,pattern=$17,visible_features=$18,version=version+1,updated_at=now() WHERE user_id=$1 AND id=$19 AND version=$20 RETURNING id`, [...values, current.id, current.version])
    : await db.query<{ id: string }>(`INSERT INTO clothes(user_id,name,category_id,primary_asset_id,status,colors,seasons,brand_id,size_id,material_id,price_cents,purchased_on,notes,favorite,item_type,color_description,pattern,visible_features) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`, values);
  if (!saved.rows.length) versionConflict();
  const id = saved.rows[0].id;
  await db.query('DELETE FROM clothing_tags WHERE user_id=$1 AND clothing_id=$2', [userId, id]);
  await db.query('INSERT INTO clothing_tags(user_id,clothing_id,tag_id) SELECT $1,$2,unnest($3::uuid[])', [userId, id, tagIds]);
  await db.query('DELETE FROM clothing_assets WHERE user_id=$1 AND clothing_id=$2', [userId, id]);
  await db.query("INSERT INTO clothing_assets(user_id,clothing_id,asset_id,role,sort_order) SELECT $1,$2,asset_id,CASE WHEN ordinal=1 THEN 'primary' ELSE 'detail' END,ordinal FROM unnest($3::uuid[]) WITH ORDINALITY AS t(asset_id,ordinal)", [userId, id, [...new Set([input.primaryAssetId, ...input.detailAssetIds])]]);
  if (current && current.primaryAssetId !== input.primaryAssetId) {
    const outfits = await db.query<{ id: string; version: number }>(`UPDATE outfits SET cover_asset_id=NULL,version=version+1,updated_at=now()
      WHERE user_id=$1 AND id IN (SELECT outfit_id FROM outfit_items WHERE user_id=$1 AND clothing_id=$2) RETURNING id,version`, [userId, id]);
    for (const outfit of outfits.rows) {
      await db.query("UPDATE image_jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE user_id=$1 AND outfit_id=$2 AND status IN ('queued','running')", [userId, outfit.id]);
      await db.query("INSERT INTO image_jobs(user_id,outfit_id,outfit_version,kind) VALUES($1,$2,$3,'outfit-cover')", [userId, outfit.id, outfit.version]);
    }
  }
  return readClothing(db, userId, id);
}
export async function requireClothingEditable(db: Database, userId: string, id: string, processingJobId?: string) {
  const active = await db.query("SELECT id FROM image_jobs WHERE user_id=$1 AND clothing_id=$2 AND status IN ('queued','running') AND ($3::uuid IS NULL OR id<>$3)", [userId, id, processingJobId || null]);
  if (active.rows.length) throw new HttpError(409, 'CLOTHING_PROCESSING', 'AI 正在处理这件衣物，完成后即可编辑');
}
export async function clothingReferences(db: Database, userId: string, id: string) {
  const result = await db.query<{ outfits: string[]; wearRecords: string[]; packingLists: string[] }>(`SELECT
    ARRAY(SELECT outfit_id FROM outfit_items WHERE user_id=$1 AND clothing_id=$2) AS outfits,
    ARRAY(SELECT wear_record_id FROM wear_items WHERE user_id=$1 AND clothing_id=$2) AS "wearRecords",
    ARRAY(SELECT packing_list_id FROM packing_items WHERE user_id=$1 AND clothing_id=$2) AS "packingLists"`, [userId, id]);
  return result.rows[0];
}
async function deleteClothing(db: Database, userId: string, id: string) {
  await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
  await requireClothingEditable(db, userId, id);
  const references = await clothingReferences(db, userId, id);
  if (references.outfits.length + references.wearRecords.length + references.packingLists.length) throw new HttpError(409, 'RESOURCE_REFERENCED', '衣物仍被搭配、穿搭记录或清单引用，可先归档', references);
  await db.query('DELETE FROM clothes WHERE user_id=$1 AND id=$2', [userId, id]);
}
export const clothesRouter = Router();
clothesRouter.get('/', async (req, res) => {
  const input = pageQuerySchema.extend({
    q: z.string().max(100).default(''), categoryId: idSchema.optional(),
    colors: z.string().transform(value => value.split(',')).pipe(z.array(z.enum(colors))).optional(),
    seasons: z.string().transform(value => value.split(',')).pipe(z.array(z.enum(seasons))).optional(),
    tagIds: z.string().transform(value => value.split(',')).pipe(z.array(idSchema).max(100)).optional(),
    occasionIds: z.string().transform(value => value.split(',')).pipe(z.array(idSchema).max(100)).optional(),
    favorite: z.enum(['true', 'false']).optional(), status: z.enum(['draft', 'active', 'archived', 'all', 'all-saved', 'wardrobe']).default('active'),
    sort: z.enum(['created', 'last-worn', 'wear-count', 'price']).default('created')
  }).strict().parse(req.query);
  const values = [res.locals.user.id, `%${input.q}%`, input.categoryId || null, input.colors || null, input.seasons || null, input.tagIds || null, input.favorite === undefined ? null : input.favorite === 'true', input.status, input.occasionIds || null];
  const where = `WHERE c.user_id=$1 AND (c.name ILIKE $2 OR brand.name ILIKE $2 OR c.notes ILIKE $2)
    AND ($3::uuid IS NULL OR c.category_id=$3 OR cat.parent_id=$3) AND ($4::text[] IS NULL OR c.colors && $4)
    AND ($5::text[] IS NULL OR c.seasons && $5 OR 'all'=ANY(c.seasons)) AND ($6::uuid[] IS NULL OR NOT EXISTS (SELECT 1 FROM unnest($6::uuid[]) t(id) WHERE NOT EXISTS (SELECT 1 FROM clothing_tags ct WHERE ct.user_id=c.user_id AND ct.clothing_id=c.id AND ct.tag_id=t.id)))
    AND ($7::boolean IS NULL OR c.favorite=$7) AND ($8='all' OR ($8='all-saved' AND c.status<>'draft') OR ($8='wardrobe' AND c.status<>'archived') OR c.status=$8)
    AND ($9::uuid[] IS NULL OR EXISTS (SELECT 1 FROM clothing_tags ct JOIN tags t ON t.id=ct.tag_id AND t.user_id=ct.user_id WHERE ct.user_id=c.user_id AND ct.clothing_id=c.id AND t.kind='occasion' AND ct.tag_id=ANY($9)))`;
  const sort = { created: 'c.created_at DESC', 'last-worn': '"lastWornOn" DESC NULLS LAST', 'wear-count': '"wearCount" DESC', price: 'c.price_cents DESC NULLS LAST' }[input.sort];
  const result = await pool.query<Clothing>(`SELECT ${clothingColumns} ${clothingFrom} ${where} ORDER BY ${sort},c.id DESC LIMIT $10 OFFSET $11`, [...values, input.pageSize, (input.page - 1) * input.pageSize]);
  const total = await pool.query<{ total: number }>(`SELECT count(*)::integer AS total FROM clothes c LEFT JOIN categories cat ON cat.id=c.category_id AND cat.user_id=c.user_id LEFT JOIN clothing_options brand ON brand.id=c.brand_id AND brand.user_id=c.user_id ${where}`, values);
  res.json({ data: result.rows, pagination: { page: input.page, pageSize: input.pageSize, total: total.rows[0].total } });
});
clothesRouter.post('/imports', async (req, res) => {
  const input = z.object({ inputAssetId: idSchema }).strict().parse(req.body);
  if (!config.NEW_API_KEY) throw new HttpError(503, 'SERVICE_NOT_CONFIGURED', '请先配置 New API，再上传自动解析');
  res.status(201).json({ data: await idempotent(res.locals.user.id, '/clothes/imports', req.get('Idempotency-Key'), input, async client => {
    const clothing = await saveClothing(client, res.locals.user.id, clothingInputSchema.parse({ name: '待识别衣物', primaryAssetId: input.inputAssetId, status: 'draft' }), res.locals.user.timezone);
    await client.query("INSERT INTO image_jobs(user_id,input_asset_id,clothing_id,kind) VALUES($1,$2,$3,'process')", [res.locals.user.id, input.inputAssetId, clothing.id]);
    return readClothing(client, res.locals.user.id, clothing.id);
  }) });
});
clothesRouter.post('/', async (req, res) => {
  const input = clothingInputSchema.parse(req.body);
  res.status(201).json({ data: await transaction(client => saveClothing(client, res.locals.user.id, input, res.locals.user.timezone)) });
});
clothesRouter.post('/batch', async (req, res) => {
  const input = clothingBatchSchema.parse(req.body);
  await transaction(async client => {
    const tags = input.action === 'replace-tags' || input.action === 'add-tags' || input.action === 'remove-tags'
      ? (await client.query<{ id: string; kind: 'occasion' | 'style' }>('SELECT id,kind FROM tags WHERE user_id=$1 FOR SHARE', [res.locals.user.id])).rows : [];
    if (input.action === 'replace-tags' || input.action === 'add-tags' || input.action === 'remove-tags') {
      if (input.parameters.tagIds.some(id => !tags.some(tag => tag.id === id))) notFound();
      if (input.action === 'replace-tags' && input.parameters.tagIds.some(id => !tags.some(tag => tag.id === id && tag.kind === input.parameters.kind))) throw new HttpError(422, 'TAG_KIND_INVALID', '请选择对应类型的标签');
    }
    for (const item of [...input.items].sort((a, b) => a.id.localeCompare(b.id))) {
      const lock = await client.query('SELECT id FROM clothes WHERE user_id=$1 AND id=$2 FOR UPDATE', [res.locals.user.id, item.id]);
      if (!lock.rows.length) notFound();
      const current = await readClothing(client, res.locals.user.id, item.id);
      if (current.version !== item.version) versionConflict();
      if (input.action === 'delete') {
        await deleteClothing(client, res.locals.user.id, item.id);
        continue;
      }
      await saveClothing(client, res.locals.user.id, {
        ...current,
        ...(input.action === 'update-attributes' ? input.parameters : {}),
        categoryId: input.action === 'change-category' ? input.parameters.categoryId : current.categoryId,
        status: input.action === 'archive' ? 'archived' : input.action === 'restore' ? 'active' : current.status,
        tagIds: input.action === 'add-tags' ? [...new Set([...current.tagIds, ...input.parameters.tagIds])]
          : input.action === 'remove-tags' ? current.tagIds.filter(id => !input.parameters.tagIds.includes(id))
          : input.action === 'replace-tags' ? [...current.tagIds.filter(id => !tags.some(tag => tag.id === id && tag.kind === input.parameters.kind)), ...new Set(input.parameters.tagIds)] : current.tagIds
      }, res.locals.user.timezone, current);
    }
  });
  res.json({ data: { affectedCount: input.items.length } });
});
clothesRouter.get('/:id', async (req, res) => res.json({ data: await readClothing(pool, res.locals.user.id, idSchema.parse(req.params.id)) }));
clothesRouter.patch('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = clothingPatchSchema.parse(req.body);
  const saved = await transaction(async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id]);
    await client.query('SELECT r.id FROM clothing_imports r JOIN clothing_import_items i ON i.import_id=r.id AND i.user_id=r.user_id WHERE i.user_id=$1 AND i.clothing_id=$2 FOR UPDATE OF r', [res.locals.user.id, id]);
    const lock = await client.query('SELECT id FROM clothes WHERE user_id=$1 AND id=$2 FOR UPDATE', [res.locals.user.id, id]);
    if (!lock.rows.length) notFound();
    const current = await readClothing(client, res.locals.user.id, id);
    if (current.version !== input.version) versionConflict();
    if (current.singleImport && input.status === 'active') {
      await client.query("UPDATE clothing_imports SET status='confirmed',confirmed_at=now(),version=version+1 WHERE user_id=$1 AND id=$2", [res.locals.user.id, current.importId]);
      await client.query('UPDATE clothing_import_items SET included=true WHERE user_id=$1 AND clothing_id=$2', [res.locals.user.id, id]);
    }
    const editable = current.singleImport && input.status === 'active' ? { ...current, importId: null, singleImport: false } : current;
    if (input.status && current.processingJobId) {
      await client.query("UPDATE image_jobs SET result=jsonb_set(result,'{subcategoryReviewed}','true'::jsonb) WHERE user_id=$1 AND id=$2 AND clothing_id=$3 AND status NOT IN ('queued','running') AND result->'suggestions' IS NOT NULL", [res.locals.user.id, current.processingJobId, id]);
    }
    if (!input.newSubcategory) return saveClothing(client, res.locals.user.id, { ...editable, ...input }, res.locals.user.timezone, editable);
    if (input.categoryId !== input.newSubcategory.parentId) throw new HttpError(422, 'CATEGORY_PARENT_INVALID', '请在所选一级分类下新增二级分类');
    const root = await client.query<{ sizeKind: string }>('SELECT size_kind AS "sizeKind" FROM categories WHERE user_id=$1 AND id=$2 AND parent_id IS NULL FOR SHARE', [res.locals.user.id, input.newSubcategory.parentId]);
    if (!root.rows.length) throw new HttpError(422, 'CATEGORY_PARENT_INVALID', '二级分类只能放在本人已有的大类下');
    const existing = await client.query<{ id: string; parentId: string | null }>('SELECT id,parent_id AS "parentId" FROM categories WHERE user_id=$1 AND name=$2 FOR SHARE', [res.locals.user.id, input.newSubcategory.name]);
    if (existing.rows.length && existing.rows[0].parentId !== input.newSubcategory.parentId) throw new HttpError(409, 'CATEGORY_NAME_CONFLICT', '已有其他分类使用这个名称，请修改名称或选择已有分类');
    if (!existing.rows.length) {
      const count = await client.query<{ count: number }>('SELECT count(*)::integer AS count FROM categories WHERE user_id=$1', [res.locals.user.id]);
      if (count.rows[0].count >= 100) throw new HttpError(422, 'TAXONOMY_LIMIT', '每人最多创建 100 项');
    }
    const category = existing.rows.length ? existing.rows[0] : (await client.query<{ id: string }>(
      'INSERT INTO categories(user_id,name,parent_id,size_kind,sort_order) SELECT $1,$2,$3,$4,COALESCE(max(sort_order)+1,0) FROM categories WHERE user_id=$1 RETURNING id',
      [res.locals.user.id, input.newSubcategory.name, input.newSubcategory.parentId, root.rows[0].sizeKind]
    )).rows[0];
    return saveClothing(client, res.locals.user.id, { ...editable, ...input, categoryId: category.id }, res.locals.user.timezone, editable);
  });
  res.json({ data: saved });
});
clothesRouter.get('/:id/references', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  await readClothing(pool, res.locals.user.id, id);
  res.json({ data: await clothingReferences(pool, res.locals.user.id, id) });
});
clothesRouter.delete('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  await transaction(async client => {
    const lock = await client.query('SELECT id FROM clothes WHERE user_id=$1 AND id=$2 FOR UPDATE', [res.locals.user.id, id]);
    if (!lock.rows.length) notFound();
    await deleteClothing(client, res.locals.user.id, id);
  });
  res.sendStatus(204);
});
