import { Router } from 'express';
import { z } from 'zod';
import { idSchema, imageJobInputSchema, imageJobRetrySchema } from '../../miniprogram/api/contracts.js';
import type { ImageJob, ImageJobResult, ImageJobInput } from '../../miniprogram/api/contracts.js';
import type { ImageProcessingState } from './ai-images.js';
import { pool } from './db.js';
import type { Database } from './db.js';
import { requireAssets, requireClothingEditable, pageQuerySchema, readClothing } from './clothes.js';
import { idempotent } from './idempotency.js';
import { HttpError, notFound } from './errors.js';

export const unconfirmedProviderCall = `(processing_state->>'confirmedRetryAt' IS NULL AND (processing_state->'recognition'->>'delivery' IN ('submitting','unknown') OR processing_state->'cutout'->>'delivery' IN ('submitting','unknown') OR processing_state->'detection'->>'delivery' IN ('submitting','unknown')))`;
export const jobColumns = `import_id AS "importId",import_item_id AS "importItemId",id,kind,status,phase,input_asset_id AS "inputAssetId",clothing_id AS "clothingId",error_code AS "errorCode",result,created_at AS "createdAt",COALESCE(processing_state->>'userPrompt','') AS "userPrompt",processing_state->>'editAssetId' AS "editAssetId",COALESCE(${unconfirmedProviderCall},false) AS "providerPending",
  EXISTS(SELECT 1 FROM clothes c JOIN media_assets a ON a.user_id=c.user_id AND a.id=c.primary_asset_id WHERE c.user_id=image_jobs.user_id AND c.id=image_jobs.clothing_id AND (c.primary_asset_id=image_jobs.input_asset_id OR a.parent_asset_id=image_jobs.input_asset_id)) AS "matchesPrimaryAsset",
  (SELECT c.name FROM clothes c WHERE c.user_id=image_jobs.user_id AND c.id=image_jobs.clothing_id) AS "clothingName",
  (SELECT c.status FROM clothes c WHERE c.user_id=image_jobs.user_id AND c.id=image_jobs.clothing_id) AS "clothingStatus"`;
async function createJob(db: Database, userId: string, input: Omit<ImageJobInput, 'kind'> & { kind: string }, attemptOf?: string, seed?: { result: ImageJobResult; processingState: ImageProcessingState; importId: string | null; importItemId: string | null }) {
  const processingState: ImageProcessingState = seed?.processingState || { userPrompt: input.userPrompt || '', refreshRecognition: Boolean(input.refreshRecognition), ...(input.editAssetId ? { editAssetId: input.editAssetId } : {}) };
  const membership = input.clothingId ? await db.query<{ import_id: string; id: string }>("SELECT i.import_id,i.id FROM clothing_import_items i JOIN clothing_imports r ON r.user_id=i.user_id AND r.id=i.import_id WHERE i.user_id=$1 AND i.clothing_id=$2 AND r.status NOT IN ('confirmed','cancelled') FOR UPDATE OF r", [userId, input.clothingId]) : null;
  const importId = seed?.importId || membership?.rows[0]?.import_id || null;
  const importItemId = seed?.importItemId || membership?.rows[0]?.id || null;
  await requireAssets(db, userId, [input.inputAssetId], processingState.editAssetId ? ['original'] : ['original', 'cutout']);
  if (input.clothingId) {
    const lock = await db.query('SELECT id FROM clothes WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, input.clothingId]);
    if (!lock.rows.length) notFound();
    const clothing = await readClothing(db, userId, input.clothingId);
    if (processingState.editAssetId) {
      await requireAssets(db, userId, [processingState.editAssetId], ['cutout']);
      const attached = await db.query(`SELECT a.id FROM media_assets a WHERE a.user_id=$1 AND a.id=$2 AND a.parent_asset_id=$3
        AND (a.id=$4 OR EXISTS(SELECT 1 FROM image_jobs j WHERE j.user_id=$1 AND j.clothing_id=$5 AND j.input_asset_id=$3 AND j.result->>'cutoutAssetId'=$2::text))`, [userId, processingState.editAssetId, input.inputAssetId, clothing.primaryAssetId, input.clothingId]);
      if (!attached.rows.length) throw new HttpError(422, 'ASSET_NOT_ATTACHED', '修补底图及原图必须属于这件衣物的同一次图片处理');
    }
    if (!seed) processingState.clothingVersion = clothing.version;
    if (!seed && (processingState.editAssetId || importId && !input.refreshRecognition)) processingState.recognitionApplied = true;
    if (clothing.primaryAssetId !== input.inputAssetId && !clothing.detailAssetIds.includes(input.inputAssetId)) {
      const previous = await db.query('SELECT id FROM image_jobs WHERE user_id=$1 AND clothing_id=$2 AND input_asset_id=$3 LIMIT 1', [userId, input.clothingId, input.inputAssetId]);
      if (!previous.rows.length) throw new HttpError(422, 'ASSET_NOT_ATTACHED', '处理图片不属于所选衣物');
    }
  }
  const existing = await db.query<ImageJob & { processing_state: ImageProcessingState }>(`SELECT ${jobColumns},processing_state FROM image_jobs WHERE user_id=$1 AND input_asset_id=$2 AND kind=$3 AND status IN ('queued','running') AND import_item_id IS NOT DISTINCT FROM $4::uuid`, [userId, input.inputAssetId, input.kind, importItemId]);
  if (existing.rows.length) {
    if (existing.rows[0].clothingId !== (input.clothingId || null)) throw new HttpError(409, 'IMAGE_ALREADY_PROCESSING', '这张图片已有其他处理任务');
    if ((existing.rows[0].processing_state.editAssetId || '') !== (processingState.editAssetId || '') || existing.rows[0].userPrompt !== (processingState.userPrompt || '') || Boolean(existing.rows[0].processing_state.refreshRecognition) !== Boolean(processingState.refreshRecognition)) throw new HttpError(409, 'IMAGE_ALREADY_PROCESSING', '这张图片正在按其他条件处理，请等待完成后再重新识别');
    const { processing_state, ...job } = existing.rows[0];
    return job;
  }
  const unresolved = await db.query(`SELECT id FROM image_jobs WHERE user_id=$1 AND input_asset_id=$2 AND import_item_id IS NOT DISTINCT FROM $3::uuid AND ${unconfirmedProviderCall} LIMIT 1`, [userId, input.inputAssetId, importItemId]);
  if (unresolved.rows.length) throw new HttpError(409, 'PROVIDER_PENDING', '图片处理未完成，请重试');
  if (input.clothingId) await requireClothingEditable(db, userId, input.clothingId);
  const recognition = processingState.editAssetId && !seed ? await db.query<{ result: ImageJobResult }>("SELECT result FROM image_jobs WHERE user_id=$1 AND clothing_id=$2 AND input_asset_id=$3 AND result->'suggestions' IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1", [userId, input.clothingId, input.inputAssetId]) : null;
  const initialResult = seed?.result || (recognition?.rows[0] ? { suggestions: recognition.rows[0].result.suggestions, subcategoryReviewed: recognition.rows[0].result.subcategoryReviewed } : null);
  const created = await db.query<ImageJob>(`INSERT INTO image_jobs(user_id,input_asset_id,clothing_id,kind,attempt_of,result,processing_state,import_id,import_item_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${jobColumns}`, [userId, input.inputAssetId, input.clothingId || null, input.kind, attemptOf || null, initialResult ? JSON.stringify(initialResult) : null, JSON.stringify(processingState), importId, importItemId]);
  if (importId) await db.query("UPDATE clothing_imports SET status='processing' WHERE user_id=$1 AND id=$2", [userId, importId]);
  return created.rows[0];
}
export const jobsRouter = Router();
jobsRouter.post('/', async (req, res) => {
  const input = imageJobInputSchema.parse(req.body);
  res.status(202).json({ data: await idempotent(res.locals.user.id, '/image-jobs', req.get('Idempotency-Key'), input, async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`image:${res.locals.user.id}:${input.inputAssetId}:${input.kind}`]);
    return createJob(client, res.locals.user.id, input);
  }) });
});
jobsRouter.get('/', async (req, res) => {
  const input = pageQuerySchema.extend({ status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional(), standalone: z.enum(['true']).optional() }).strict().parse(req.query);
  const result = await pool.query<ImageJob>(`SELECT ${jobColumns} FROM image_jobs WHERE user_id=$1 AND ($2::text IS NULL OR status=$2) AND ($5::boolean=false OR import_id IS NULL) ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`, [res.locals.user.id, input.status || null, input.pageSize, (input.page - 1) * input.pageSize, input.standalone === 'true']);
  const total = await pool.query<{ total: number }>('SELECT count(*)::integer AS total FROM image_jobs WHERE user_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::boolean=false OR import_id IS NULL)', [res.locals.user.id, input.status || null, input.standalone === 'true']);
  res.json({ data: result.rows, pagination: { page: input.page, pageSize: input.pageSize, total: total.rows[0].total } });
});
jobsRouter.get('/:id', async (req, res) => {
  const result = await pool.query<ImageJob>(`SELECT ${jobColumns} FROM image_jobs WHERE user_id=$1 AND id=$2`, [res.locals.user.id, idSchema.parse(req.params.id)]);
  if (!result.rows.length) notFound();
  res.json({ data: result.rows[0] });
});
jobsRouter.post('/:id/cancel', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const updated = await pool.query<ImageJob>(`UPDATE image_jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
    phase=CASE WHEN status='queued' THEN '已取消' ELSE '正在取消' END,finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END
    WHERE user_id=$1 AND id=$2 AND status IN ('queued','running') RETURNING ${jobColumns}`, [res.locals.user.id, id]);
  if (!updated.rows.length) {
    const exists = await pool.query('SELECT id FROM image_jobs WHERE user_id=$1 AND id=$2', [res.locals.user.id, id]);
    if (!exists.rows.length) notFound();
    throw new HttpError(409, 'JOB_STATE_CONFLICT', '任务已经结束');
  }
  res.status(202).json({ data: updated.rows[0] });
});
jobsRouter.post('/:id/retry', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = imageJobRetrySchema.parse(req.body);
  res.status(202).json({ data: await idempotent(res.locals.user.id, `/image-jobs/${id}/retry`, req.get('Idempotency-Key'), input, async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id]);
    const previous = await client.query<{ input_asset_id: string; clothing_id: string | null; kind: string; status: string; result: ImageJobResult | null; processing_state: ImageProcessingState; import_id: string | null; import_item_id: string | null }>('SELECT input_asset_id,clothing_id,kind,status,result,processing_state,import_id,import_item_id FROM image_jobs WHERE user_id=$1 AND id=$2', [res.locals.user.id, id]);
    if (!previous.rows.length) notFound();
    const job = previous.rows[0];
    if (!['failed', 'cancelled'].includes(job.status) && job.result?.outcome !== 'partial') throw new HttpError(409, 'JOB_STATE_CONFLICT', '当前任务无需重试');
    const uncertain = Object.values(job.processing_state).some(call => typeof call === 'object' && (call.delivery === 'submitting' || call.delivery === 'unknown'));
    if (uncertain && !input.confirmUncertain && !job.processing_state.confirmedRetryAt) throw new HttpError(409, 'PROVIDER_PENDING', '请确认重新处理这张图片');
    if (job.import_id && (await client.query<{ status: string }>("SELECT status FROM clothing_imports WHERE id=$1 AND user_id=$2 FOR UPDATE", [job.import_id, res.locals.user.id])).rows.some(record => ['confirmed', 'cancelled'].includes(record.status))) throw new HttpError(409, 'IMPORT_STATE_CONFLICT', '录入已结束，请从衣物页重新处理');
    if (job.kind === 'locate' && (await client.query('SELECT id FROM clothing_import_items WHERE import_id=$1 AND clothing_id IS NOT NULL LIMIT 1', [job.import_id])).rows.length) throw new HttpError(409, 'IMPORT_STATE_CONFLICT', '已生成单品，请在单品页重新识别');
    if (!job.processing_state.editAssetId && job.result?.suggestions?.cutoutReadiness === 'retake') throw new HttpError(422, 'PHOTO_RETAKE_REQUIRED', '请重新裁剪或拍照后处理');
    if (previous.rows[0].kind === 'outfit-cover') throw new HttpError(409, 'JOB_STATE_CONFLICT', '请重新保存搭配以生成封面');
    if ((await client.query('SELECT id FROM image_jobs WHERE user_id=$1 AND attempt_of=$2 LIMIT 1', [res.locals.user.id, id])).rows.length) throw new HttpError(409, 'JOB_STATE_CONFLICT', '已创建重试任务，请查看最新处理结果');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`image:${res.locals.user.id}:${previous.rows[0].input_asset_id}:${previous.rows[0].kind}`]);
    if (uncertain && !job.processing_state.confirmedRetryAt) await client.query("UPDATE image_jobs SET processing_state=jsonb_set(processing_state,'{confirmedRetryAt}',to_jsonb($3::text)) WHERE user_id=$1 AND id=$2", [res.locals.user.id, id, new Date().toISOString()]);
    const retryState = { ...job.processing_state };
    delete retryState.confirmedRetryAt;
    for (const stage of ['recognition', 'cutout', 'detection'] as const) {
      if (retryState[stage]?.delivery === 'unknown' || retryState[stage]?.delivery === 'submitting') delete retryState[stage];
    }
    await client.query("UPDATE image_jobs SET result=jsonb_set(COALESCE(result,'{}'),'{canRetry}','false') WHERE user_id=$1 AND id=$2", [res.locals.user.id, id]);
    const retryResult = { ...job.result, outcome: undefined, canRetry: false, steps: job.result?.steps ? {
      recognition: ['succeeded', 'skipped'].includes(job.result.steps.recognition.status) ? job.result.steps.recognition : { status: 'queued' as const },
      cutout: ['succeeded', 'skipped'].includes(job.result.steps.cutout.status) ? job.result.steps.cutout : { status: 'queued' as const }
    } : undefined };
    return createJob(client, res.locals.user.id, { inputAssetId: job.input_asset_id, clothingId: job.clothing_id || undefined, kind: job.kind }, id, { result: retryResult, processingState: retryState, importId: job.import_id, importItemId: job.import_item_id });
  }) });
});
