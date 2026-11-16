import { Router } from 'express';
import { z } from 'zod';
import { dateSchema, idSchema, wearInputSchema, wearPatchSchema } from '../../miniprogram/api/contracts.js';
import type { WearRecord } from '../../miniprogram/api/contracts.js';
import { pool, transaction } from './db.js';
import type { Database } from './db.js';
import { readOutfit } from './outfits.js';
import { requireClothes, requireAssets, today } from './clothes.js';
import { HttpError, notFound, versionConflict } from './errors.js';

const wearColumns = `r.id,r.worn_on AS "wornOn",r.occasion,r.notes,r.body_asset_id AS "bodyAssetId",r.source_outfit_id AS "sourceOutfitId",r.version,
  (SELECT jsonb_agg(jsonb_build_object('clothingId',i.clothing_id,'name',i.name_snapshot,'categoryName',i.category_snapshot,'primaryAssetId',c.primary_asset_id,'status',c.status) ORDER BY i.clothing_id)
   FROM wear_items i JOIN clothes c ON c.id=i.clothing_id AND c.user_id=i.user_id WHERE i.user_id=r.user_id AND i.wear_record_id=r.id) AS items`;
async function readWear(db: Database, userId: string, id: string) {
  const result = await db.query<WearRecord>(`SELECT ${wearColumns} FROM wear_records r WHERE r.user_id=$1 AND r.id=$2`, [userId, id]);
  if (!result.rows.length) notFound();
  return result.rows[0];
}
async function saveWearItems(db: Database, userId: string, id: string, clothingIds: string[]) {
  await db.query('DELETE FROM wear_items WHERE user_id=$1 AND wear_record_id=$2', [userId, id]);
  await db.query(`INSERT INTO wear_items(user_id,wear_record_id,clothing_id,name_snapshot,category_snapshot)
    SELECT c.user_id,$2,c.id,c.name,COALESCE(cat.name,'未分类') FROM clothes c LEFT JOIN categories cat ON cat.id=c.category_id AND cat.user_id=c.user_id
    WHERE c.user_id=$1 AND c.id=ANY($3::uuid[])`, [userId, id, clothingIds]);
}
export const wearRouter = Router();
wearRouter.get('/', async (req, res) => {
  const input = z.object({ from: dateSchema, to: dateSchema }).strict().refine(value => value.from <= value.to && (Date.parse(value.to) - Date.parse(value.from)) / 86400000 <= 365, '查询范围最多 366 天').parse(req.query);
  const result = await pool.query<WearRecord>(`SELECT ${wearColumns} FROM wear_records r WHERE r.user_id=$1 AND r.worn_on BETWEEN $2 AND $3 ORDER BY r.worn_on DESC,r.created_at DESC,r.id DESC`, [res.locals.user.id, input.from, input.to]);
  res.json({ data: result.rows });
});
wearRouter.post('/', async (req, res) => {
  const input = wearInputSchema.parse(req.body);
  if (input.wornOn > today(res.locals.user.timezone)) throw new HttpError(400, 'FUTURE_DATE', '不能记录未来的实际穿着');
  const saved = await transaction(async client => {
    const clothingIds = input.outfitId ? (await readOutfit(client, res.locals.user.id, input.outfitId)).items.map(item => item.clothingId) : input.clothingIds!;
    await requireClothes(client, res.locals.user.id, clothingIds);
    if (input.bodyAssetId) await requireAssets(client, res.locals.user.id, [input.bodyAssetId], ['body-photo']);
    const result = await client.query<{ id: string }>('INSERT INTO wear_records(user_id,worn_on,occasion,notes,body_asset_id,source_outfit_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [res.locals.user.id, input.wornOn, input.occasion, input.notes, input.bodyAssetId, input.outfitId || null]);
    await saveWearItems(client, res.locals.user.id, result.rows[0].id, clothingIds);
    return readWear(client, res.locals.user.id, result.rows[0].id);
  });
  res.status(201).json({ data: saved });
});
wearRouter.patch('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = wearPatchSchema.parse(req.body);
  if (input.wornOn > today(res.locals.user.timezone)) throw new HttpError(400, 'FUTURE_DATE', '不能记录未来的实际穿着');
  const saved = await transaction(async client => {
    const lock = await client.query('SELECT id FROM wear_records WHERE user_id=$1 AND id=$2 FOR UPDATE', [res.locals.user.id, id]);
    if (!lock.rows.length) notFound();
    const current = await readWear(client, res.locals.user.id, id);
    if (current.version !== input.version) versionConflict();
    await requireClothes(client, res.locals.user.id, input.clothingIds, current.items.map(item => item.clothingId));
    if (input.bodyAssetId) await requireAssets(client, res.locals.user.id, [input.bodyAssetId], ['body-photo']);
    const result = await client.query('UPDATE wear_records SET worn_on=$3,occasion=$4,notes=$5,body_asset_id=$6,version=version+1 WHERE user_id=$1 AND id=$2 AND version=$7 RETURNING id', [res.locals.user.id, id, input.wornOn, input.occasion, input.notes, input.bodyAssetId, input.version]);
    if (!result.rows.length) versionConflict();
    const retained = current.items.filter(item => input.clothingIds.includes(item.clothingId));
    await saveWearItems(client, res.locals.user.id, id, input.clothingIds);
    for (const item of retained) await client.query('UPDATE wear_items SET name_snapshot=$4,category_snapshot=$5 WHERE user_id=$1 AND wear_record_id=$2 AND clothing_id=$3', [res.locals.user.id, id, item.clothingId, item.name, item.categoryName]);
    return readWear(client, res.locals.user.id, id);
  });
  res.json({ data: saved });
});
wearRouter.delete('/:id', async (req, res) => {
  const result = await pool.query('DELETE FROM wear_records WHERE user_id=$1 AND id=$2 RETURNING id', [res.locals.user.id, idSchema.parse(req.params.id)]);
  if (!result.rows.length) notFound();
  res.sendStatus(204);
});
