import { Router } from 'express';
import { z } from 'zod';
import { idSchema, packingInputSchema, packingPatchSchema, packingStatusInputSchema, dateSchema } from '../../miniprogram/api/contracts.js';
import type { PackingList } from '../../miniprogram/api/contracts.js';
import { pool, transaction } from './db.js';
import type { Database } from './db.js';
import { pageQuerySchema, requireClothes } from './clothes.js';
import { HttpError, notFound, versionConflict } from './errors.js';
import { syncPackingReminders } from './packing-reminders.js';

const packingColumns = `p.id,p.name,p.start_on AS "startOn",p.end_on AS "endOn",p.departure_time AS "departureTime",p.ended_at AS "endedAt",p.version,p.created_at AS "createdAt",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('timing',r.timing,'scheduledAt',r.scheduled_at,'status',r.status) ORDER BY r.scheduled_at,r.timing)
   FROM packing_reminders r WHERE r.user_id=p.user_id AND r.packing_list_id=p.id),'[]'::jsonb) AS reminders,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('clothingId',i.clothing_id,'name',c.name,'primaryAssetId',c.primary_asset_id,'status',c.status,'packed',i.packed,
     'rootCategoryId',COALESCE(parent.id,cat.id),'rootCategoryName',COALESCE(parent.name,cat.name,'未分类')) ORDER BY i.sort_order,i.clothing_id)
   FROM packing_items i JOIN clothes c ON c.id=i.clothing_id AND c.user_id=i.user_id
   LEFT JOIN categories cat ON cat.id=c.category_id AND cat.user_id=c.user_id
   LEFT JOIN categories parent ON parent.id=cat.parent_id AND parent.user_id=cat.user_id
   WHERE i.user_id=p.user_id AND i.packing_list_id=p.id),'[]'::jsonb) AS items`;
async function readPacking(db: Database, userId: string, id: string) {
  const result = await db.query<PackingList>(`SELECT ${packingColumns} FROM packing_lists p WHERE p.user_id=$1 AND p.id=$2`, [userId, id]);
  if (!result.rows.length) notFound();
  return result.rows[0];
}
async function savePackingItems(db: Database, userId: string, id: string, items: { clothingId: string; packed: boolean }[]) {
  await db.query('DELETE FROM packing_items WHERE user_id=$1 AND packing_list_id=$2', [userId, id]);
  for (const [index, item] of [...new Map(items.map(item => [item.clothingId, item])).values()].entries()) await db.query('INSERT INTO packing_items(user_id,packing_list_id,clothing_id,packed,sort_order) VALUES($1,$2,$3,$4,$5)', [userId, id, item.clothingId, item.packed, index]);
}
export const packingRouter = Router();
packingRouter.get('/', async (req, res) => {
  const input = pageQuerySchema.extend({ status: z.enum(['active', 'ended']).default('active') }).strict().parse(req.query);
  const result = await pool.query<PackingList>(`SELECT ${packingColumns} FROM packing_lists p WHERE p.user_id=$1 AND (p.ended_at IS NOT NULL)=$4 ORDER BY p.created_at DESC,p.id DESC LIMIT $2 OFFSET $3`, [res.locals.user.id, input.pageSize, (input.page - 1) * input.pageSize, input.status === 'ended']);
  const total = await pool.query<{ total: number }>('SELECT count(*)::integer AS total FROM packing_lists WHERE user_id=$1 AND (ended_at IS NOT NULL)=$2', [res.locals.user.id, input.status === 'ended']);
  res.json({ data: result.rows, pagination: { page: input.page, pageSize: input.pageSize, total: total.rows[0].total } });
});
packingRouter.post('/', async (req, res) => {
  const input = packingInputSchema.parse(req.body);
  res.status(201).json({ data: await transaction(async client => {
    await requireClothes(client, res.locals.user.id, input.clothingIds);
    const result = await client.query<{ id: string }>('INSERT INTO packing_lists(user_id,name,start_on,end_on,departure_time) VALUES($1,$2,$3,$4,$5) RETURNING id', [res.locals.user.id, input.name, input.startOn, input.endOn, input.departureTime || '07:00']);
    await savePackingItems(client, res.locals.user.id, result.rows[0].id, input.clothingIds.map(clothingId => ({ clothingId, packed: false })));
    await syncPackingReminders(client, res.locals.user.id, result.rows[0].id, input.startOn, { startOn: null, reminders: [] }, input.reminderSubscriptions);
    return readPacking(client, res.locals.user.id, result.rows[0].id);
  }) });
});
packingRouter.get('/:id', async (req, res) => res.json({ data: await readPacking(pool, res.locals.user.id, idSchema.parse(req.params.id)) }));
packingRouter.patch('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = packingPatchSchema.parse(req.body);
  res.json({ data: await transaction(async client => {
    const lock = await client.query('SELECT id FROM packing_lists WHERE user_id=$1 AND id=$2 FOR UPDATE', [res.locals.user.id, id]);
    if (!lock.rows.length) notFound();
    const current = await readPacking(client, res.locals.user.id, id);
    if (current.version !== input.version) versionConflict();
    if (current.endedAt) throw new HttpError(409, 'TRIP_ENDED', '请先重新开启行程后再修改');
    await requireClothes(client, res.locals.user.id, input.items.map(item => item.clothingId), current.items.map(item => item.clothingId));
    const result = await client.query('UPDATE packing_lists SET name=$3,start_on=$4,end_on=$5,departure_time=$7,version=version+1 WHERE user_id=$1 AND id=$2 AND version=$6 RETURNING id', [res.locals.user.id, id, input.name, input.startOn, input.endOn, input.version, input.departureTime || '07:00']);
    if (!result.rows.length) versionConflict();
    await savePackingItems(client, res.locals.user.id, id, input.items);
    if (current.startOn !== input.startOn || input.reminderSubscriptions) await syncPackingReminders(client, res.locals.user.id, id, input.startOn, current, input.reminderSubscriptions);
    return readPacking(client, res.locals.user.id, id);
  }) });
});
packingRouter.patch('/:id/status', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = packingStatusInputSchema.parse(req.body);
  res.json({ data: await transaction(async client => {
    const current = await client.query<{ version: number }>('SELECT version FROM packing_lists WHERE user_id=$1 AND id=$2 FOR UPDATE', [res.locals.user.id, id]);
    if (!current.rows.length) notFound();
    if (current.rows[0].version !== input.version) versionConflict();
    await client.query('UPDATE packing_lists SET ended_at=CASE WHEN $3 THEN now() END,version=version+1 WHERE user_id=$1 AND id=$2', [res.locals.user.id, id, input.ended]);
    if (input.ended) await client.query("UPDATE packing_reminders SET status='cancelled' WHERE user_id=$1 AND packing_list_id=$2 AND status IN ('scheduled','sending')", [res.locals.user.id, id]);
    return readPacking(client, res.locals.user.id, id);
  }) });
});
packingRouter.post('/:id/copy', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = z.object({ name: z.string().trim().min(1).max(60), startOn: dateSchema.nullable(), endOn: dateSchema.nullable() }).strict().refine(value => !value.startOn || !value.endOn || value.startOn <= value.endOn, '日期范围不正确').parse(req.body);
  res.status(201).json({ data: await transaction(async client => {
    const current = await readPacking(client, res.locals.user.id, id);
    const available = current.items;
    await requireClothes(client, res.locals.user.id, available.map(item => item.clothingId));
    const result = await client.query<{ id: string }>('INSERT INTO packing_lists(user_id,name,start_on,end_on) VALUES($1,$2,$3,$4) RETURNING id', [res.locals.user.id, input.name, input.startOn, input.endOn]);
    await savePackingItems(client, res.locals.user.id, result.rows[0].id, available.map(item => ({ clothingId: item.clothingId, packed: false })));
    return readPacking(client, res.locals.user.id, result.rows[0].id);
  }) });
});
packingRouter.delete('/:id', async (req, res) => {
  const result = await pool.query('DELETE FROM packing_lists WHERE user_id=$1 AND id=$2 RETURNING id', [res.locals.user.id, idSchema.parse(req.params.id)]);
  if (!result.rows.length) notFound();
  res.sendStatus(204);
});
