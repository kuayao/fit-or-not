import { Router } from 'express';
import { z } from 'zod';
import { clothingInputSchema, idSchema, redetectImportSchema } from '../../miniprogram/api/contracts.js';
import type { ClothingImport, ClothingImportDetail, ClothingTarget, ImageJob } from '../../miniprogram/api/contracts.js';
import { pool, transaction } from './db.js';
import type { Database } from './db.js';
import { pageQuerySchema, readClothing, requireAssets, saveClothing } from './clothes.js';
import { saveClothingSet } from './clothing-sets.js';
import { jobColumns, unconfirmedProviderCall } from './jobs.js';
import { idempotent } from './idempotency.js';
import { config } from './config.js';
import { HttpError, notFound, versionConflict } from './errors.js';

const importColumns = `r.id,r.input_asset_id AS "inputAssetId",r.mode,r.status,r.name,r.save_as_set AS "saveAsSet",r.cover_asset_id AS "coverAssetId",r.version,r.created_at AS "createdAt",
  (SELECT count(*)::integer FROM clothing_import_items i WHERE i.import_id=r.id AND i.user_id=r.user_id AND i.clothing_id IS NOT NULL) AS "itemCount",
  EXISTS(SELECT 1 FROM image_jobs j WHERE j.user_id=r.user_id AND j.import_id=r.id AND j.status IN ('queued','running')) AS pending`;
export async function readImport(db: Database, userId: string, id: string): Promise<ClothingImportDetail> {
  const found = await db.query<ClothingImport>(`SELECT ${importColumns} FROM clothing_imports r WHERE r.user_id=$1 AND r.id=$2`, [userId, id]);
  if (!found.rows.length) notFound();
  const items = await db.query<{ id: string; included: boolean; target: ClothingTarget | null; clothing_id: string | null }>('SELECT id,included,target,clothing_id FROM clothing_import_items WHERE user_id=$1 AND import_id=$2 ORDER BY target_key,id', [userId, id]);
  const jobs = await db.query<ImageJob>(`SELECT ${jobColumns} FROM image_jobs WHERE user_id=$1 AND import_id=$2 ORDER BY created_at,id`, [userId, id]);
  return { ...found.rows[0], items: await Promise.all(items.rows.map(async item => ({ id: item.id, included: item.included, target: item.target, clothing: item.clothing_id ? await readClothing(db, userId, item.clothing_id) : null }))), jobs: jobs.rows };
}
export async function createImportMember(db: Database, userId: string, timezone: string, record: { id: string; inputAssetId: string }, targetKey: string, target: ClothingTarget | null) {
  const clothing = await saveClothing(db, userId, clothingInputSchema.parse({ name: target?.name || '待识别衣物', primaryAssetId: record.inputAssetId, status: 'draft' }), timezone);
  const item = await db.query<{ id: string }>('INSERT INTO clothing_import_items(user_id,import_id,clothing_id,target_key,target) VALUES($1,$2,$3,$4,$5) RETURNING id', [userId, record.id, clothing.id, targetKey, target ? JSON.stringify(target) : null]);
  await db.query("INSERT INTO image_jobs(user_id,input_asset_id,clothing_id,kind,import_id,import_item_id,processing_state) VALUES($1,$2,$3,'process',$4,$5,$6)", [userId, record.inputAssetId, clothing.id, record.id, item.rows[0].id, JSON.stringify({ clothingVersion: clothing.version })]);
}
export async function refreshImportStatus(importId: string | null) {
  if (!importId) return;
  await transaction(async client => {
    await client.query('SELECT id FROM clothing_imports WHERE id=$1 FOR UPDATE', [importId]);
    await client.query(`UPDATE clothing_imports r SET status=CASE WHEN EXISTS(SELECT 1 FROM image_jobs j WHERE j.user_id=r.user_id AND j.import_id=r.id AND j.status IN ('queued','running')) THEN 'processing' WHEN NOT EXISTS(SELECT 1 FROM clothing_import_items i WHERE i.import_id=r.id AND i.clothing_id IS NOT NULL) THEN 'needs-attention' ELSE 'review' END
    WHERE r.id=$1 AND r.status NOT IN ('confirmed','cancelled')`, [importId]);
  });
}
export const clothingImportsRouter = Router();
clothingImportsRouter.post('/', async (req, res) => {
  const input = z.object({ inputAssetId: idSchema, mode: z.enum(['single', 'set']) }).strict().parse(req.body);
  if (!config.NEW_API_KEY) throw new HttpError(503, 'SERVICE_NOT_CONFIGURED', '图片处理暂不可用，请稍后再试');
  res.status(202).json({ data: await idempotent(res.locals.user.id, '/clothing-imports', req.get('Idempotency-Key'), input, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`import:${res.locals.user.id}:${input.inputAssetId}`]);
    await requireAssets(client, res.locals.user.id, [input.inputAssetId], ['original']);
    const existing = await client.query("SELECT id FROM clothing_imports WHERE user_id=$1 AND input_asset_id=$2 AND status NOT IN ('confirmed','cancelled')", [res.locals.user.id, input.inputAssetId]);
    if (existing.rows.length) throw new HttpError(409, 'IMAGE_ALREADY_IMPORTED', '这张图片已有待处理或待审核的录入');
    const created = await client.query<{ id: string }>('INSERT INTO clothing_imports(user_id,input_asset_id,mode,save_as_set,cover_asset_id) VALUES($1,$2,$3,$4,$2) RETURNING id', [res.locals.user.id, input.inputAssetId, input.mode, input.mode === 'set']);
    const id = created.rows[0].id;
    if (input.mode === 'single') await createImportMember(client, res.locals.user.id, res.locals.user.timezone, { id, inputAssetId: input.inputAssetId }, '1', null);
    if (input.mode === 'set') await client.query("INSERT INTO image_jobs(user_id,input_asset_id,kind,import_id) VALUES($1,$2,'locate',$3)", [res.locals.user.id, input.inputAssetId, id]);
    return readImport(client, res.locals.user.id, id);
  }) });
});
clothingImportsRouter.get('/', async (req, res) => {
  const input = pageQuerySchema.extend({ empty: z.enum(['true']).optional() }).strict().parse(req.query);
  const where = `r.user_id=$1 AND r.status<>'confirmed' AND ($2::boolean=false OR (r.status<>'cancelled' AND NOT EXISTS(SELECT 1 FROM clothing_import_items i WHERE i.import_id=r.id AND i.clothing_id IS NOT NULL)))`;
  const rows = await pool.query<ClothingImport>(`SELECT ${importColumns} FROM clothing_imports r WHERE ${where} ORDER BY r.created_at DESC,r.id DESC LIMIT $3 OFFSET $4`, [res.locals.user.id, input.empty === 'true', input.pageSize, (input.page - 1) * input.pageSize]);
  const count = await pool.query<{ total: number }>(`SELECT count(*)::integer AS total FROM clothing_imports r WHERE ${where}`, [res.locals.user.id, input.empty === 'true']);
  res.json({ data: rows.rows, pagination: { page: input.page, pageSize: input.pageSize, total: count.rows[0].total } });
});
clothingImportsRouter.get('/:id', async (req, res) => res.json({ data: await readImport(pool, res.locals.user.id, idSchema.parse(req.params.id)) }));
clothingImportsRouter.post('/:id/redetect', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = redetectImportSchema.parse(req.body);
  if (!config.NEW_API_KEY) throw new HttpError(503, 'SERVICE_NOT_CONFIGURED', '图片处理暂不可用，请稍后再试');
  res.status(202).json({ data: await idempotent(res.locals.user.id, `/clothing-imports/${id}/redetect`, req.get('Idempotency-Key'), input, async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id]);
    await client.query('SELECT id FROM clothing_imports WHERE user_id=$1 AND id=$2 FOR UPDATE', [res.locals.user.id, id]);
    const current = await readImport(client, res.locals.user.id, id);
    if (current.mode !== 'set' || current.status === 'confirmed' || current.status === 'cancelled' || current.pending || current.itemCount) throw new HttpError(409, 'IMPORT_STATE_CONFLICT', '仅未生成单品且已结束处理的套装录入可重新识别');
    if (current.version !== input.version) versionConflict();
    const unresolved = await client.query(`SELECT id FROM image_jobs WHERE user_id=$1 AND input_asset_id=$2 AND ${unconfirmedProviderCall} LIMIT 1`, [res.locals.user.id, current.inputAssetId]);
    if (unresolved.rows.length) throw new HttpError(409, 'PROVIDER_PENDING', '图片处理未完成，请返回重试');
    await client.query("INSERT INTO image_jobs(user_id,input_asset_id,kind,import_id,processing_state) VALUES($1,$2,'locate',$3,$4)", [res.locals.user.id, current.inputAssetId, id, JSON.stringify({ userPrompt: input.userPrompt || '' })]);
    await client.query("UPDATE clothing_imports SET status='processing',version=version+1 WHERE user_id=$1 AND id=$2", [res.locals.user.id, id]);
    return readImport(client, res.locals.user.id, id);
  }) });
});
clothingImportsRouter.patch('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = z.object({ version: z.number().int().positive(), name: z.string().trim().max(60), saveAsSet: z.boolean(), coverAssetId: idSchema.nullable(), items: z.array(z.object({ id: idSchema, included: z.boolean() }).strict()).max(6).refine(items => new Set(items.map(item => item.id)).size === items.length) }).strict().parse(req.body);
  res.json({ data: await transaction(async client => {
    await client.query('SELECT id FROM clothing_imports WHERE user_id=$1 AND id=$2 FOR UPDATE', [res.locals.user.id, id]);
    const current = await readImport(client, res.locals.user.id, id);
    if (current.status === 'confirmed' || current.status === 'cancelled') throw new HttpError(409, 'IMPORT_STATE_CONFLICT', '录入已结束');
    if (current.version !== input.version) versionConflict();
    if (input.coverAssetId) await requireAssets(client, res.locals.user.id, [input.coverAssetId], ['original', 'cutout']);
    if (input.items.some(item => !current.items.some(member => member.id === item.id))) notFound();
    await client.query('UPDATE clothing_imports SET name=$3,save_as_set=$4,cover_asset_id=$5,version=version+1 WHERE user_id=$1 AND id=$2', [res.locals.user.id, id, input.name, input.saveAsSet, input.coverAssetId]);
    for (const item of input.items) await client.query('UPDATE clothing_import_items SET included=$4 WHERE user_id=$1 AND import_id=$2 AND id=$3', [res.locals.user.id, id, item.id, item.included]);
    return readImport(client, res.locals.user.id, id);
  }) });
});
clothingImportsRouter.post('/:id/items', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = z.object({ inputAssetId: idSchema, version: z.number().int().positive() }).strict().parse(req.body);
  res.status(202).json({ data: await idempotent(res.locals.user.id, `/clothing-imports/${id}/items`, req.get('Idempotency-Key'), input, async client => {
    await client.query('SELECT id FROM clothing_imports WHERE user_id=$1 AND id=$2 FOR UPDATE', [res.locals.user.id, id]);
    const current = await readImport(client, res.locals.user.id, id);
    if (current.status === 'confirmed' || current.status === 'cancelled') throw new HttpError(409, 'IMPORT_STATE_CONFLICT', '录入已结束');
    if (current.version !== input.version) versionConflict();
    if (current.items.length >= 6) throw new HttpError(422, 'IMPORT_ITEM_LIMIT', '每次录入最多六件');
    await requireAssets(client, res.locals.user.id, [input.inputAssetId], ['original']);
    await createImportMember(client, res.locals.user.id, res.locals.user.timezone, { id, inputAssetId: input.inputAssetId }, `manual-${current.items.length + 1}`, null);
    await client.query("UPDATE clothing_imports SET status='processing',version=version+1 WHERE user_id=$1 AND id=$2", [res.locals.user.id, id]);
    return readImport(client, res.locals.user.id, id);
  }) });
});
clothingImportsRouter.post('/:id/confirm', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = z.object({ version: z.number().int().positive(), items: z.array(z.object({ id: idSchema, version: z.number().int().positive() }).strict()).min(1).max(6).refine(items => new Set(items.map(item => item.id)).size === items.length) }).strict().parse(req.body);
  res.json({ data: await idempotent(res.locals.user.id, `/clothing-imports/${id}/confirm`, req.get('Idempotency-Key'), input, async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id]);
    await client.query('SELECT id FROM clothing_imports WHERE user_id=$1 AND id=$2 FOR UPDATE', [res.locals.user.id, id]);
    const current = await readImport(client, res.locals.user.id, id);
    if (current.status === 'confirmed' || current.status === 'cancelled' || current.pending) throw new HttpError(409, 'IMPORT_STATE_CONFLICT', '请等待处理结束后审核确认');
    if (current.version !== input.version) versionConflict();
    const selected = current.items.filter(item => item.included && item.clothing);
    if (selected.length !== input.items.length || selected.some(item => !input.items.some(value => value.id === item.clothing!.id && value.version === item.clothing!.version))) versionConflict();
    if (current.saveAsSet && selected.length < 2) throw new HttpError(422, 'SET_MEMBERS_REQUIRED', '套装至少需要两件，请补录或取消保存为套装');
    if (current.saveAsSet && !current.name.trim()) throw new HttpError(422, 'SET_NAME_REQUIRED', '请输入套装名称');
    await client.query("UPDATE clothing_imports SET status='confirmed',confirmed_at=now(),version=version+1 WHERE user_id=$1 AND id=$2", [res.locals.user.id, id]);
    for (const item of selected) {
      const clothing = await readClothing(client, res.locals.user.id, item.clothing!.id);
      if (clothing.version !== item.clothing!.version) versionConflict();
      const job = current.jobs.find(job => job.id === clothing.processingJobId);
      if (job?.result?.suggestions?.subcategoryName && !job.result.subcategoryReviewed && job.result.suggestions.categoryId === job.result.suggestions.rootCategoryId) throw new HttpError(422, 'SUBCATEGORY_REVIEW_REQUIRED', '请先编辑单品并确认二级分类建议');
      await saveClothing(client, res.locals.user.id, { ...clothing, status: 'active' }, res.locals.user.timezone, clothing);
    }
    for (const item of current.items.filter(item => !item.included && item.clothing)) await client.query("DELETE FROM clothes WHERE user_id=$1 AND id=$2 AND status='draft'", [res.locals.user.id, item.clothing!.id]);
    if (current.saveAsSet) await saveClothingSet(client, res.locals.user.id, { name: current.name, coverAssetId: current.coverAssetId, memberIds: selected.map(item => item.clothing!.id), moveMembers: false });
    return readImport(client, res.locals.user.id, id);
  }) });
});
clothingImportsRouter.post('/:id/cancel', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  res.status(202).json({ data: await transaction(async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id]);
    const updated = await client.query("UPDATE clothing_imports SET status='cancelled',version=version+1 WHERE user_id=$1 AND id=$2 AND status<>'confirmed' RETURNING id", [res.locals.user.id, id]);
    if (!updated.rows.length) notFound();
    await client.query("UPDATE image_jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,phase=CASE WHEN status='queued' THEN '已取消' ELSE '正在取消' END,finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE user_id=$1 AND import_id=$2 AND status IN ('queued','running')", [res.locals.user.id, id]);
    await client.query("DELETE FROM clothes c USING clothing_import_items i WHERE c.user_id=$1 AND i.user_id=c.user_id AND i.import_id=$2 AND i.clothing_id=c.id AND c.status='draft'", [res.locals.user.id, id]);
    return readImport(client, res.locals.user.id, id);
  }) });
});
