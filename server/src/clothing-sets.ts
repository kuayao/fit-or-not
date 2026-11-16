import { Router } from 'express';
import { z } from 'zod';
import { clothingSetInputSchema, idSchema } from '../../miniprogram/api/contracts.js';
import type { ClothingSet } from '../../miniprogram/api/contracts.js';
import { pool, transaction } from './db.js';
import type { Database } from './db.js';
import { pageQuerySchema, requireAssets, requireClothingEditable } from './clothes.js';
import { HttpError, notFound, versionConflict } from './errors.js';

export const setColumns = `s.id,s.name,s.cover_asset_id AS "coverAssetId",s.version,s.created_at AS "createdAt",
  (SELECT count(*)::integer FROM clothes c WHERE c.user_id=s.user_id AND c.set_id=s.id) AS "memberCount",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'categoryName',NULLIF(concat_ws(' / ',p.name,cat.name),''),'primaryAssetId',c.primary_asset_id,'status',c.status) ORDER BY c.created_at,c.id)
    FROM clothes c LEFT JOIN categories cat ON cat.user_id=c.user_id AND cat.id=c.category_id
    LEFT JOIN categories p ON p.user_id=cat.user_id AND p.id=cat.parent_id WHERE c.user_id=s.user_id AND c.set_id=s.id),'[]') AS members`;
export async function readClothingSet(db: Database, userId: string, id: string) {
  const found = await db.query<ClothingSet>(`SELECT ${setColumns} FROM clothing_sets s WHERE s.user_id=$1 AND s.id=$2`, [userId, id]);
  if (!found.rows.length) notFound();
  return found.rows[0];
}
export async function saveClothingSet(db: Database, userId: string, input: z.infer<typeof clothingSetInputSchema>, current?: { id: string; version: number }) {
  await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
  if (current) {
    const stored = await readClothingSet(db, userId, current.id);
    if (stored.version !== current.version) versionConflict();
  }
  if (input.coverAssetId) await requireAssets(db, userId, [input.coverAssetId], ['original', 'cutout']);
  const members = await db.query<{ id: string; set_id: string | null; status: string }>('SELECT id,set_id,status FROM clothes WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE', [userId, input.memberIds]);
  if (members.rows.length !== input.memberIds.length || members.rows.some(item => item.status === 'draft')) throw new HttpError(422, 'CLOTHING_UNAVAILABLE', '请选择已入橱的本人衣物');
  if (!input.moveMembers && members.rows.some(item => item.set_id && item.set_id !== current?.id)) throw new HttpError(409, 'SET_MEMBERSHIP_CONFLICT', '所选衣物已属于其他套装，请确认移动');
  for (const member of members.rows) await requireClothingEditable(db, userId, member.id);
  const saved = current
    ? await db.query<{ id: string }>('UPDATE clothing_sets SET name=$3,cover_asset_id=$4,version=version+1,updated_at=now() WHERE user_id=$1 AND id=$2 AND version=$5 RETURNING id', [userId, current.id, input.name, input.coverAssetId, current.version])
    : await db.query<{ id: string }>('INSERT INTO clothing_sets(user_id,name,cover_asset_id) VALUES($1,$2,$3) RETURNING id', [userId, input.name, input.coverAssetId]);
  if (!saved.rows.length) versionConflict();
  const id = saved.rows[0].id;
  const removed = await db.query<{ id: string }>('SELECT id FROM clothes WHERE user_id=$1 AND set_id=$2 AND NOT(id=ANY($3::uuid[])) ORDER BY id FOR UPDATE', [userId, id, input.memberIds]);
  for (const member of removed.rows) await requireClothingEditable(db, userId, member.id);
  await db.query('UPDATE clothes SET set_id=$3,version=version+1,updated_at=now() WHERE user_id=$1 AND id=ANY($2::uuid[]) AND set_id IS DISTINCT FROM $3::uuid', [userId, input.memberIds, id]);
  await db.query('UPDATE clothes SET set_id=NULL,version=version+1,updated_at=now() WHERE user_id=$1 AND set_id=$2 AND NOT(id=ANY($3::uuid[]))', [userId, id, input.memberIds]);
  await db.query('UPDATE clothing_sets SET version=version+1,updated_at=now() WHERE user_id=$1 AND id=ANY($2::uuid[]) AND id<>$3', [userId, members.rows.flatMap(item => item.set_id ? [item.set_id] : []), id]);
  return readClothingSet(db, userId, id);
}
export const clothingSetsRouter = Router();
clothingSetsRouter.get('/', async (req, res) => {
  const input = pageQuerySchema.extend({ q: z.string().max(100).default('') }).strict().parse(req.query);
  const sets = await pool.query<ClothingSet>(`SELECT ${setColumns} FROM clothing_sets s WHERE s.user_id=$1 AND s.name ILIKE $2 ORDER BY s.created_at DESC,s.id DESC LIMIT $3 OFFSET $4`, [res.locals.user.id, `%${input.q}%`, input.pageSize, (input.page - 1) * input.pageSize]);
  const total = await pool.query<{ total: number }>('SELECT count(*)::integer AS total FROM clothing_sets WHERE user_id=$1 AND name ILIKE $2', [res.locals.user.id, `%${input.q}%`]);
  res.json({ data: sets.rows, pagination: { page: input.page, pageSize: input.pageSize, total: total.rows[0].total } });
});
clothingSetsRouter.post('/', async (req, res) => {
  const input = clothingSetInputSchema.parse(req.body);
  res.status(201).json({ data: await transaction(client => saveClothingSet(client, res.locals.user.id, input)) });
});
clothingSetsRouter.get('/:id', async (req, res) => res.json({ data: await readClothingSet(pool, res.locals.user.id, idSchema.parse(req.params.id)) }));
clothingSetsRouter.patch('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = clothingSetInputSchema.extend({ version: z.number().int().positive() }).parse(req.body);
  res.json({ data: await transaction(client => saveClothingSet(client, res.locals.user.id, input, { id, version: input.version })) });
});
clothingSetsRouter.delete('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  await transaction(async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id]);
    const current = await readClothingSet(client, res.locals.user.id, id);
    for (const member of current.members) await requireClothingEditable(client, res.locals.user.id, member.id);
    await client.query('UPDATE clothes SET set_id=NULL,version=version+1,updated_at=now() WHERE user_id=$1 AND set_id=$2', [res.locals.user.id, id]);
    await client.query('DELETE FROM clothing_sets WHERE user_id=$1 AND id=$2', [res.locals.user.id, id]);
  });
  res.status(204).end();
});
