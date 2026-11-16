import { Router } from 'express';
import { z } from 'zod';
import { idSchema, userInputSchema, clothingOptionKindSchema, clothingOptionInputSchema, sizeKindSchema } from '../../miniprogram/api/contracts.js';
import { pool, transaction } from './db.js';
import { getUser } from './auth.js';
import { requireAssets, clothingColumns, clothingFrom, pageQuerySchema } from './clothes.js';
import type { Clothing } from '../../miniprogram/api/contracts.js';
import { idempotent } from './idempotency.js';
import { HttpError, notFound, versionConflict } from './errors.js';

export const accountRouter = Router();
accountRouter.get('/me', async (_req, res) => res.json({ data: res.locals.user }));
accountRouter.patch('/me', async (req, res) => {
  const input = userInputSchema.parse(req.body);
  res.json({ data: await transaction(async client => {
    if (input.avatarAssetId) await requireAssets(client, res.locals.user.id, [input.avatarAssetId], ['original']);
    const result = await client.query(`UPDATE users SET nickname=COALESCE($3,nickname),city_code=COALESCE($4,city_code),
      avatar_asset_id=CASE WHEN $5 THEN $6::uuid ELSE avatar_asset_id END,preferences=COALESCE($7,preferences),version=version+1
      WHERE id=$1 AND version=$2 RETURNING id`, [res.locals.user.id, input.version, input.nickname, input.cityCode, input.avatarAssetId !== undefined, input.avatarAssetId, input.preferences]);
    if (!result.rows.length) versionConflict();
    return getUser(client, res.locals.user.id);
  }) });
});
accountRouter.delete('/me', async (req, res) => {
  z.object({ confirmation: z.literal('DELETE_MY_ACCOUNT') }).strict().parse(req.body);
  await transaction(async client => {
    await client.query("UPDATE users SET status='deleting' WHERE id=$1", [res.locals.user.id]);
    await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [res.locals.user.id]);
    await client.query("UPDATE image_jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE user_id=$1 AND status IN ('queued','running')", [res.locals.user.id]);
  });
  res.status(202).json({ data: { status: 'deleting' } });
});

accountRouter.get('/clothing-options', async (req, res) => {
  const input = z.object({ kind: clothingOptionKindSchema.optional() }).strict().parse(req.query);
  const result = await pool.query('SELECT id,name,kind,sort_order AS "sortOrder",version FROM clothing_options WHERE user_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY kind,sort_order,id', [res.locals.user.id, input.kind]);
  res.json({ data: result.rows });
});
accountRouter.post('/clothing-options', async (req, res) => {
  const input = clothingOptionInputSchema.parse(req.body);
  res.status(201).json({ data: await transaction(async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id]);
    const count = await client.query<{ count: number; nextOrder: number }>('SELECT count(*)::integer AS count,COALESCE(max(sort_order)+1,0) AS "nextOrder" FROM clothing_options WHERE user_id=$1 AND kind=$2', [res.locals.user.id, input.kind]);
    if (count.rows[0].count >= 100) throw new HttpError(422, 'CLOTHING_OPTIONS_LIMIT', '每类最多创建 100 项');
    const result = await client.query('INSERT INTO clothing_options(user_id,kind,name,sort_order) VALUES($1,$2,$3,$4) RETURNING id,name,kind,sort_order AS "sortOrder",version', [res.locals.user.id, input.kind, input.name, count.rows[0].nextOrder]);
    return result.rows[0];
  }) });
});
accountRouter.post('/clothing-options/reorder', async (req, res) => {
  const input = z.object({ kind: clothingOptionKindSchema, items: z.array(z.object({ id: idSchema, version: z.number().int().positive() }).strict()).min(1) }).strict()
    .refine(value => new Set(value.items.map(item => item.id)).size === value.items.length, '排序项不能重复').parse(req.body);
  await transaction(async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id]);
    const current = await client.query<{ id: string; version: number }>('SELECT id,version FROM clothing_options WHERE user_id=$1 AND kind=$2 ORDER BY id FOR UPDATE', [res.locals.user.id, input.kind]);
    if (current.rows.length !== input.items.length || input.items.some(item => !current.rows.some(row => row.id === item.id && row.version === item.version))) versionConflict();
    for (const [index, item] of input.items.entries()) await client.query('UPDATE clothing_options SET sort_order=$3,version=version+1 WHERE user_id=$1 AND id=$2', [res.locals.user.id, item.id, index]);
  });
  res.sendStatus(204);
});
accountRouter.patch('/clothing-options/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = z.object({ version: z.number().int().positive(), name: clothingOptionInputSchema.shape.name }).strict().parse(req.body);
  const result = await pool.query('UPDATE clothing_options SET name=$3,version=version+1 WHERE user_id=$1 AND id=$2 AND version=$4 RETURNING id,name,kind,sort_order AS "sortOrder",version', [res.locals.user.id, id, input.name, input.version]);
  if (!result.rows.length) {
    const existing = await pool.query('SELECT id FROM clothing_options WHERE user_id=$1 AND id=$2', [res.locals.user.id, id]);
    if (!existing.rows.length) notFound();
    versionConflict();
  }
  res.json({ data: result.rows[0] });
});
accountRouter.delete('/clothing-options/:id', async (req, res) => {
  const result = await pool.query('DELETE FROM clothing_options WHERE user_id=$1 AND id=$2 RETURNING id', [res.locals.user.id, idSchema.parse(req.params.id)]);
  if (!result.rows.length) notFound();
  res.sendStatus(204);
});

accountRouter.patch('/categories/:id/size-kind', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = z.object({ version: z.number().int().positive(), sizeKind: sizeKindSchema }).strict().parse(req.body);
  res.json({ data: await transaction(async client => {
    const current = await client.query<{ version: number; sizeKind: string }>('SELECT version,size_kind AS "sizeKind" FROM categories WHERE user_id=$1 AND id=$2 AND parent_id IS NULL FOR UPDATE', [res.locals.user.id, id]);
    if (!current.rows.length) notFound();
    if (current.rows[0].version !== input.version) versionConflict();
    if (current.rows[0].sizeKind !== input.sizeKind) {
      const used = await client.query('SELECT c.id FROM clothes c JOIN categories cat ON cat.user_id=c.user_id AND cat.id=c.category_id WHERE c.user_id=$1 AND (cat.id=$2 OR cat.parent_id=$2) AND c.size_id IS NOT NULL LIMIT 1', [res.locals.user.id, id]);
      if (used.rows.length) throw new HttpError(409, 'SIZE_KIND_REFERENCED', '此分类已有衣物填写尺码，请先清空这些尺码再更换分组');
    }
    const result = await client.query('UPDATE categories SET size_kind=$3,version=version+1 WHERE user_id=$1 AND id=$2 RETURNING id,name,parent_id AS "parentId",name AS "displayName",size_kind AS "sizeKind",sort_order AS "sortOrder",version', [res.locals.user.id, id, input.sizeKind]);
    return result.rows[0];
  }) });
});

for (const table of ['categories', 'tags'] as const) {
  const createSchema = table === 'categories'
    ? z.object({ name: z.string().trim().min(1).max(30), parentId: idSchema.nullable().default(null) }).strict()
    : z.object({ name: z.string().trim().min(1).max(30), kind: z.enum(['occasion', 'style']) }).strict();
  accountRouter.get(`/${table}`, async (req, res) => {
    const input = z.object({ kind: z.enum(['occasion', 'style']).optional() }).strict().parse(req.query);
    const result = table === 'categories'
      ? await pool.query(`SELECT c.id,c.name,c.parent_id AS "parentId",concat_ws(' / ',p.name,c.name) AS "displayName",COALESCE(p.size_kind,c.size_kind) AS "sizeKind",c.sort_order AS "sortOrder",c.version FROM categories c LEFT JOIN categories p ON p.id=c.parent_id AND p.user_id=c.user_id WHERE c.user_id=$1 ORDER BY COALESCE(p.sort_order,c.sort_order),COALESCE(c.parent_id,c.id),c.parent_id NULLS FIRST,c.sort_order,c.id`, [res.locals.user.id])
      : await pool.query('SELECT id,name,kind,sort_order AS "sortOrder",version FROM tags WHERE user_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY sort_order,id', [res.locals.user.id, input.kind || null]);
    res.json({ data: result.rows });
  });
  accountRouter.post(`/${table}`, async (req, res) => {
    const input = createSchema.parse(req.body);
    res.status(201).json({ data: await transaction(async client => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id]);
      if ('parentId' in input && input.parentId) {
        const parent = await client.query('SELECT id FROM categories WHERE user_id=$1 AND id=$2 AND parent_id IS NULL FOR SHARE', [res.locals.user.id, input.parentId]);
        if (!parent.rows.length) throw new HttpError(422, 'CATEGORY_PARENT_INVALID', '二级分类只能放在本人已有的大类下');
      }
      const count = await client.query<{ count: number; nextOrder: number }>(`SELECT count(*)::integer AS count,COALESCE(max(sort_order)+1,0) AS "nextOrder" FROM ${table} WHERE user_id=$1`, [res.locals.user.id]);
      if (count.rows[0].count >= 100) throw new HttpError(422, 'TAXONOMY_LIMIT', '每人最多创建 100 项');
      const result = table === 'categories'
        ? await client.query(`INSERT INTO categories(user_id,name,sort_order,parent_id) VALUES($1,$2,$3,$4) RETURNING id,name,parent_id AS "parentId",concat_ws(' / ',(SELECT name FROM categories WHERE user_id=$1 AND id=$4),name) AS "displayName",COALESCE((SELECT size_kind FROM categories WHERE user_id=$1 AND id=$4),size_kind) AS "sizeKind",sort_order AS "sortOrder",version`, [res.locals.user.id, input.name, count.rows[0].nextOrder, 'parentId' in input ? input.parentId : null])
        : await client.query('INSERT INTO tags(user_id,name,kind,sort_order) VALUES($1,$2,$3,$4) RETURNING id,name,kind,sort_order AS "sortOrder",version', [res.locals.user.id, input.name, 'kind' in input ? input.kind : undefined, count.rows[0].nextOrder]);
      return result.rows[0];
    }) });
  });
  accountRouter.post(`/${table}/reorder`, async (req, res) => {
    const input = z.object({ items: z.array(z.object({ id: idSchema, version: z.number().int().positive() }).strict()).min(1).max(100) }).strict()
      .refine(value => new Set(value.items.map(item => item.id)).size === value.items.length, '排序项不能重复').parse(req.body);
    await transaction(async client => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id]);
      const current = await client.query<{ id: string; version: number }>(`SELECT id,version FROM ${table} WHERE user_id=$1 ORDER BY id FOR UPDATE`, [res.locals.user.id]);
      if (current.rows.length !== input.items.length || input.items.some(item => !current.rows.some(row => row.id === item.id && row.version === item.version))) versionConflict();
      for (const [index, item] of input.items.entries()) await client.query(`UPDATE ${table} SET sort_order=$3,version=version+1 WHERE user_id=$1 AND id=$2`, [res.locals.user.id, item.id, index]);
    });
    res.sendStatus(204);
  });
  accountRouter.patch(`/${table}/:id`, async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const input = z.object({ version: z.number().int().positive(), name: z.string().trim().min(1).max(30).optional(), sortOrder: z.number().int().min(0).max(100).optional() }).strict().parse(req.body);
    const result = await pool.query(`UPDATE ${table} SET name=COALESCE($3,name),sort_order=COALESCE($4,sort_order),version=version+1 WHERE user_id=$1 AND id=$2 AND version=$5 RETURNING id,name,sort_order AS "sortOrder",version${table === 'tags' ? ',kind' : `,parent_id AS "parentId",concat_ws(' / ',(SELECT p.name FROM categories p WHERE p.user_id=$1 AND p.id=categories.parent_id),name) AS "displayName",COALESCE((SELECT p.size_kind FROM categories p WHERE p.user_id=$1 AND p.id=categories.parent_id),size_kind) AS "sizeKind"`}`, [res.locals.user.id, id, input.name, input.sortOrder, input.version]);
    if (!result.rows.length) {
      const existing = await pool.query(`SELECT id FROM ${table} WHERE user_id=$1 AND id=$2`, [res.locals.user.id, id]);
      if (!existing.rows.length) notFound();
      versionConflict();
    }
    res.json({ data: result.rows[0] });
  });
  accountRouter.delete(`/${table}/:id`, async (req, res) => {
    const result = await pool.query(`DELETE FROM ${table} WHERE user_id=$1 AND id=$2 RETURNING id`, [res.locals.user.id, idSchema.parse(req.params.id)]);
    if (!result.rows.length) notFound();
    res.sendStatus(204);
  });
}
accountRouter.get('/statistics', async (req, res) => {
  const input = z.object({ scope: z.enum(['active', 'all']).default('active') }).strict().parse(req.query);
  const summary = await pool.query<{ totalCount: number; pricedCount: number; totalPriceCents: string }>(`SELECT count(*)::integer AS "totalCount",count(price_cents)::integer AS "pricedCount",COALESCE(sum(price_cents),0)::text AS "totalPriceCents" FROM clothes WHERE user_id=$1 AND ($2='all' OR status='active') AND status<>'draft'`, [res.locals.user.id, input.scope]);
  const categories = await pool.query<{ name: string; count: number }>(`SELECT COALESCE(cat.name,'未分类') AS name,count(*)::integer AS count FROM clothes c LEFT JOIN categories cat ON cat.id=c.category_id AND cat.user_id=c.user_id WHERE c.user_id=$1 AND ($2='all' OR c.status='active') AND c.status<>'draft' GROUP BY cat.id,cat.name ORDER BY count DESC,cat.id`, [res.locals.user.id, input.scope]);
  const activity = await pool.query<{ wornDays: number; outfitCount: number }>(`SELECT (SELECT count(DISTINCT worn_on)::integer FROM wear_records WHERE user_id=$1) AS "wornDays",(SELECT count(*)::integer FROM outfits WHERE user_id=$1) AS "outfitCount"`, [res.locals.user.id]);
  res.json({ data: { scope: input.scope, ...summary.rows[0], ...activity.rows[0], categories: categories.rows, description: '同一衣物同一天最多计穿着 1 次；金额仅汇总已填写价格的衣物。未记录不等于未穿着。' } });
});
accountRouter.get('/statistics/clothes', async (req, res) => {
  const input = pageQuerySchema.extend({ scope: z.enum(['active', 'all']).default('active'), sort: z.enum(['least-worn', 'most-worn']).default('least-worn') }).strict().parse(req.query);
  const direction = input.sort === 'most-worn' ? 'DESC' : 'ASC';
  const rows = await pool.query<Clothing>(`SELECT ${clothingColumns} ${clothingFrom} WHERE c.user_id=$1 AND ($2='all' OR c.status='active') AND c.status<>'draft' ORDER BY "wearCount" ${direction},c.id LIMIT $3 OFFSET $4`, [res.locals.user.id, input.scope, input.pageSize, (input.page - 1) * input.pageSize]);
  const total = await pool.query<{ total: number }>("SELECT count(*)::integer AS total FROM clothes WHERE user_id=$1 AND ($2='all' OR status='active') AND status<>'draft'", [res.locals.user.id, input.scope]);
  res.json({ data: rows.rows.map(item => ({ id: item.id, name: item.name, primaryAssetId: item.primaryAssetId, wearCount: item.wearCount, lastWornOn: item.lastWornOn, priceCents: item.priceCents,
    costPerWearCents: item.priceCents !== null && item.wearCount > 0 ? ((BigInt(item.priceCents) + BigInt(Math.floor(item.wearCount / 2))) / BigInt(item.wearCount)).toString() : null })),
    pagination: { page: input.page, pageSize: input.pageSize, total: total.rows[0].total } });
});
accountRouter.post('/data-exports', async (req, res) => {
  const input = z.object({ format: z.literal('zip') }).strict().parse(req.body);
  res.status(202).json({ data: await idempotent(res.locals.user.id, '/data-exports', req.get('Idempotency-Key'), input, async client => {
    const created = await client.query('INSERT INTO data_exports(user_id) VALUES($1) RETURNING id,status,asset_id AS "assetId",expires_at AS "expiresAt",error_code AS "errorCode"', [res.locals.user.id]);
    return created.rows[0];
  }) });
});
accountRouter.get('/data-exports/:id', async (req, res) => {
  const result = await pool.query('SELECT id,status,asset_id AS "assetId",expires_at AS "expiresAt",error_code AS "errorCode" FROM data_exports WHERE user_id=$1 AND id=$2', [res.locals.user.id, idSchema.parse(req.params.id)]);
  if (!result.rows.length) notFound();
  res.json({ data: result.rows[0] });
});
