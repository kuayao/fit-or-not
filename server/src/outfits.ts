import { Router } from 'express';
import { z } from 'zod';
import type { Outfit, OutfitCategory, LayoutItem } from '../../miniprogram/api/contracts.js';
import { idSchema, outfitInputSchema, outfitPatchSchema, outfitCategoryInputSchema } from '../../miniprogram/api/contracts.js';
import { pool, transaction } from './db.js';
import type { Database } from './db.js';
import { pageQuerySchema, requireClothes } from './clothes.js';
import { HttpError, notFound, versionConflict } from './errors.js';
import { layoutExtents } from '../../miniprogram/utils/layout.js';

export function validateLayout(items: LayoutItem[]) {
  for (const item of items) {
    const { halfWidth, halfHeight } = layoutExtents(item);
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;
    if (cx - halfWidth < -0.000001 || cx + halfWidth > 1.000001 || cy - halfHeight < -0.000001 || cy + halfHeight > 1.000001) throw new HttpError(422, 'LAYOUT_OUT_OF_BOUNDS', '衣物超出画布边界，请缩小或移回画布内');
  }
}
const outfitColumns = `o.id,o.name,o.occasion,o.seasons,o.notes,o.favorite,o.category_id AS "categoryId",
  (SELECT c.name FROM outfit_categories c WHERE c.user_id=o.user_id AND c.id=o.category_id) AS "categoryName",
  o.background_color AS "backgroundColor",o.cover_asset_id AS "coverAssetId",o.version,o.created_at AS "createdAt",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('clothingId',i.clothing_id,'assetId',c.primary_asset_id) ORDER BY i.z_index,i.clothing_id) FROM outfit_items i JOIN clothes c ON c.user_id=i.user_id AND c.id=i.clothing_id WHERE i.user_id=o.user_id AND i.outfit_id=o.id),'[]'::jsonb) AS "previewAssets",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('clothingId',i.clothing_id,'x',i.x,'y',i.y,'width',i.width,'height',i.height,'rotation',i.rotation,'zIndex',i.z_index) ORDER BY i.z_index,i.clothing_id) FROM outfit_items i WHERE i.user_id=o.user_id AND i.outfit_id=o.id),'[]'::jsonb) AS items`;
export async function readOutfit(db: Database, userId: string, id: string) {
  const result = await db.query<Outfit>(`SELECT ${outfitColumns} FROM outfits o WHERE o.user_id=$1 AND o.id=$2`, [userId, id]);
  if (!result.rows.length) notFound();
  return result.rows[0];
}
async function saveOutfit(db: Database, userId: string, input: z.infer<typeof outfitInputSchema>, current?: Outfit) {
  validateLayout(input.items);
  await requireClothes(db, userId, input.items.map(item => item.clothingId), current?.items.map(item => item.clothingId));
  if (input.categoryId) {
    const category = await db.query('SELECT id FROM outfit_categories WHERE user_id=$1 AND id=$2', [userId, input.categoryId]);
    if (!category.rows.length) notFound();
  }
  const values = [userId, input.name, input.occasion, input.seasons, input.notes, input.favorite, input.backgroundColor, input.categoryId];
  const saved = current
    ? await db.query<{ id: string; version: number }>(`UPDATE outfits SET name=$2,occasion=$3,seasons=$4,notes=$5,favorite=$6,background_color=$7,category_id=$8,cover_asset_id=NULL,version=version+1,updated_at=now() WHERE user_id=$1 AND id=$9 AND version=$10 RETURNING id,version`, [...values, current.id, current.version])
    : await db.query<{ id: string; version: number }>('INSERT INTO outfits(user_id,name,occasion,seasons,notes,favorite,background_color,category_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,version', values);
  if (!saved.rows.length) versionConflict();
  await db.query('DELETE FROM outfit_items WHERE user_id=$1 AND outfit_id=$2', [userId, saved.rows[0].id]);
  for (const item of input.items) await db.query('INSERT INTO outfit_items(user_id,outfit_id,clothing_id,x,y,width,height,rotation,z_index) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [userId, saved.rows[0].id, item.clothingId, item.x, item.y, item.width, item.height, item.rotation, item.zIndex]);
  await db.query("UPDATE image_jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE user_id=$1 AND outfit_id=$2 AND status IN ('queued','running')", [userId, saved.rows[0].id]);
  await db.query("INSERT INTO image_jobs(user_id,outfit_id,outfit_version,kind) VALUES($1,$2,$3,'outfit-cover')", [userId, saved.rows[0].id, saved.rows[0].version]);
  return readOutfit(db, userId, saved.rows[0].id);
}
export const outfitsRouter = Router();
export const outfitCategoriesRouter = Router();
outfitCategoriesRouter.get('/', async (_req, res) => {
  const result = await pool.query<OutfitCategory>('SELECT id,name FROM outfit_categories WHERE user_id=$1 ORDER BY created_at,id', [res.locals.user.id]);
  res.json({ data: result.rows });
});
outfitCategoriesRouter.post('/', async (req, res) => {
  const input = outfitCategoryInputSchema.parse(req.body);
  const result = await pool.query<OutfitCategory>('INSERT INTO outfit_categories(user_id,name) VALUES($1,$2) RETURNING id,name', [res.locals.user.id, input.name]);
  res.status(201).json({ data: result.rows[0] });
});
outfitsRouter.get('/', async (req, res) => {
  const input = pageQuerySchema.extend({ q: z.string().max(100).default(''), occasion: z.string().max(60).optional(), categoryId: idSchema.optional(), favorite: z.enum(['true', 'false']).optional() }).strict().parse(req.query);
  const values = [res.locals.user.id, `%${input.q}%`, input.occasion || null, input.favorite === undefined ? null : input.favorite === 'true', input.categoryId || null];
  const where = 'WHERE o.user_id=$1 AND o.name ILIKE $2 AND ($3::text IS NULL OR o.occasion=$3) AND ($4::boolean IS NULL OR o.favorite=$4) AND ($5::uuid IS NULL OR o.category_id=$5)';
  const result = await pool.query<Outfit>(`SELECT ${outfitColumns} FROM outfits o ${where} ORDER BY o.created_at DESC,o.id DESC LIMIT $6 OFFSET $7`, [...values, input.pageSize, (input.page - 1) * input.pageSize]);
  const total = await pool.query<{ total: number }>(`SELECT count(*)::integer AS total FROM outfits o ${where}`, values);
  res.json({ data: result.rows, pagination: { page: input.page, pageSize: input.pageSize, total: total.rows[0].total } });
});
outfitsRouter.post('/', async (req, res) => {
  const input = outfitInputSchema.parse(req.body);
  res.status(201).json({ data: await transaction(client => saveOutfit(client, res.locals.user.id, input)) });
});
outfitsRouter.get('/:id', async (req, res) => res.json({ data: await readOutfit(pool, res.locals.user.id, idSchema.parse(req.params.id)) }));
outfitsRouter.patch('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = outfitPatchSchema.parse(req.body);
  const saved = await transaction(async client => {
    const lock = await client.query('SELECT id FROM outfits WHERE user_id=$1 AND id=$2 FOR UPDATE', [res.locals.user.id, id]);
    if (!lock.rows.length) notFound();
    const current = await readOutfit(client, res.locals.user.id, id);
    if (current.version !== input.version) versionConflict();
    return saveOutfit(client, res.locals.user.id, { ...current, ...input }, current);
  });
  res.json({ data: saved });
});
outfitsRouter.delete('/:id', async (req, res) => {
  const result = await pool.query('DELETE FROM outfits WHERE user_id=$1 AND id=$2 RETURNING id', [res.locals.user.id, idSchema.parse(req.params.id)]);
  if (!result.rows.length) notFound();
  res.sendStatus(204);
});
