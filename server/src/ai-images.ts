import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { recognitionSchema } from '../../miniprogram/api/contracts.js';
import type { ClothingTarget, ImageJobResult } from '../../miniprogram/api/contracts.js';
import { config } from './config.js';
import { pool, transaction } from './db.js';
import { HttpError } from './errors.js';
import { COMPLETION_PROMPT, RECOGNITION_PROMPT, REPAIR_PROMPT, SET_COVER_PROMPT } from './image-prompts.js';
import { readClothing, saveClothing } from './clothes.js';
import { providerFailure } from './provider-failure.js';

type Call = { model: string; promptRevision: string; startedAt: string; delivery: 'submitting' | 'completed' | 'unknown' | 'not-sent'; requestId?: string; finishedAt?: string; failure?: ReturnType<typeof providerFailure> };
export type ImageProcessingState = { recognition?: Call; cutout?: Call; detection?: Call; rawAssetId?: string; clothingVersion?: number; lastAppliedVersion?: number; recognitionApplied?: boolean; cutoutApplied?: boolean; coverAssetId?: string; editAssetId?: string; userPrompt?: string; refreshRecognition?: boolean; confirmedRetryAt?: string };
export type AiJob = { id: string; user_id: string; input_asset_id: string | null; clothing_id: string | null; kind: string; import_id: string | null; import_item_id: string | null; result: ImageJobResult | null; processing_state: ImageProcessingState };
const imageResponseSchema = z.object({ data: z.array(z.object({ b64_json: z.string().min(1).optional(), url: z.url().optional() }).refine(value => Boolean(value.b64_json || value.url))).min(1).max(1) });
const chatResponseSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).min(1) });

export async function readLimited(response: Response, limit: number) {
  if (Number(response.headers.get('content-length')) > limit) throw new HttpError(502, 'PROVIDER_RESULT_TOO_LARGE', '模型返回的文件过大');
  if (!response.body) throw new HttpError(502, 'PROVIDER_EMPTY_RESULT', '模型没有返回可用结果');
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = [];
  const length = { value: 0 };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length.value += chunk.value.byteLength;
      if (length.value > limit) throw new HttpError(502, 'PROVIDER_RESULT_TOO_LARGE', '模型返回的文件过大');
      buffers.push(chunk.value);
    }
    return Buffer.concat(buffers);
  } finally { await reader.cancel(); }
}

export async function processAiImageJob(job: AiJob) {
  const result: ImageJobResult & { steps: NonNullable<ImageJobResult['steps']> } = {
    ...job.result,
    steps: job.result?.steps || {
      recognition: { status: job.kind === 'cutout' || job.kind === 'set-cover' ? 'skipped' : 'queued', ...(job.kind === 'cutout' || job.kind === 'set-cover' ? { skipReason: 'not-requested' } : {}) },
      cutout: { status: job.kind === 'classify' ? 'skipped' : 'queued', ...(job.kind === 'classify' ? { skipReason: 'not-requested' } : {}) }
    }
  };
  const state = job.processing_state;
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    void pool.query<{ cancel_requested: boolean }>("UPDATE image_jobs SET heartbeat_at=now(),lease_expires_at=now()+interval '30 seconds' WHERE id=$1 AND status='running' RETURNING cancel_requested", [job.id]).then(update => {
      if (!update.rows.length || update.rows[0].cancel_requested) controller.abort();
    }).catch(() => controller.abort());
  }, 5000);
  const persistence = { tail: Promise.resolve() };
  const persist = (phase: string) => {
    persistence.tail = persistence.tail.then(async () => { await pool.query("UPDATE image_jobs SET result=$2,processing_state=$3,phase=$4 WHERE id=$1 AND status='running'", [job.id, JSON.stringify(result), JSON.stringify(state), phase]); });
    return persistence.tail;
  };
  try {
    if (!config.NEW_API_KEY) throw new HttpError(503, 'SERVICE_NOT_CONFIGURED', '图片处理暂不可用，请稍后再试');
    const input = await pool.query<{ storage_key: string; mime_type: string }>("SELECT a.storage_key,a.mime_type FROM media_assets a JOIN users u ON u.id=a.user_id WHERE a.id=$1 AND a.user_id=$2 AND a.status='ready' AND u.status='active'", [job.input_asset_id, job.user_id]);
    if (!input.rows.length) throw new HttpError(404, 'RESOURCE_NOT_FOUND', '输入图片已不可用');
    if (job.clothing_id && state.clothingVersion === undefined) state.clothingVersion = (await readClothing(pool, job.user_id, job.clothing_id)).version;
    const photo = await readFile(join(config.MEDIA_DIR, input.rows[0].storage_key));
    const targetResult = job.import_item_id ? await pool.query<{ target: ClothingTarget | null }>('SELECT i.target FROM clothing_import_items i JOIN clothing_imports r ON r.user_id=i.user_id AND r.id=i.import_id WHERE i.user_id=$1 AND i.id=$2 AND r.input_asset_id=$3', [job.user_id, job.import_item_id, job.input_asset_id]) : null;
    const target = targetResult?.rows[0]?.target;
    const setTargets = job.kind === 'set-cover' ? await pool.query<{ target: ClothingTarget }>('SELECT target FROM clothing_import_items WHERE user_id=$1 AND import_id=$2 AND target IS NOT NULL ORDER BY target_key,id', [job.user_id, job.import_id]) : null;
    const edit = state.editAssetId ? await pool.query<{ storage_key: string; mime_type: string }>('SELECT storage_key,mime_type FROM media_assets WHERE user_id=$1 AND id=$2', [job.user_id, state.editAssetId]) : null;
    const sourceInfo = await sharp(photo).metadata();
    const targetPhoto = target && !state.userPrompt && !state.editAssetId ? await sharp(photo).extract({ left: Math.floor(target.box.left * sourceInfo.width), top: Math.floor(target.box.top * sourceInfo.height), width: Math.min(Math.max(1, Math.round(target.box.width * sourceInfo.width)), sourceInfo.width - Math.floor(target.box.left * sourceInfo.width)), height: Math.min(Math.max(1, Math.round(target.box.height * sourceInfo.height)), sourceInfo.height - Math.floor(target.box.top * sourceInfo.height)) }).png().toBuffer() : null;
    const maskContent = !state.editAssetId && state.rawAssetId && state.cutout?.promptRevision === 'mask-v2' ? await sharp(photo).resize(1024, 1024, { fit: 'inside' }).flatten({ background: '#ffffff' }).png().toBuffer({ resolveWithObject: true }) : null;
    const maskSource = maskContent ? await sharp(maskContent.data).extend({ left: Math.floor((1024 - maskContent.info.width) / 2), right: Math.ceil((1024 - maskContent.info.width) / 2), top: Math.floor((1024 - maskContent.info.height) / 2), bottom: Math.ceil((1024 - maskContent.info.height) / 2), background: '#ffffff' }).png().toBuffer() : null;
    const baseUrl = config.NEW_API_BASE_URL.replace(/\/$/, '');
    await Promise.all((['recognition', 'cutout'] as const).map(async stage => {
      if (controller.signal.aborted) return;
      if (result.steps[stage].status === 'succeeded' || result.steps[stage].status === 'skipped') return;
      if (stage === 'cutout' && !state.editAssetId && (!state.userPrompt && target?.visibility === 'retake' || result.suggestions?.cutoutReadiness === 'retake')) {
        result.steps.cutout = { status: 'skipped', skipReason: 'retake', message: '照片存在明显遮挡或缺失，请重新裁剪或拍照' };
        await persist('请重新裁剪或拍照');
        return;
      }
      result.steps[stage] = { status: 'running' };
      await persist(stage === 'recognition' ? '正在识别衣物' : state.editAssetId ? '正在修补图片' : '正在生成透明图');
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(stage === 'recognition' ? config.AI_RECOGNITION_TIMEOUT_MS : config.AI_CUTOUT_TIMEOUT_MS)]);
      try {
        if (stage === 'recognition') {
          const categories = await pool.query<{ id: string; name: string; parentId: string | null }>('SELECT id,name,parent_id AS "parentId" FROM categories WHERE user_id=$1 ORDER BY sort_order,id', [job.user_id]);
          const tags = await pool.query<{ id: string; name: string; kind: string }>('SELECT id,name,kind FROM tags WHERE user_id=$1 ORDER BY sort_order,id', [job.user_id]);
          state.recognition = { model: config.AI_RECOGNITION_MODEL, promptRevision: 'recognition-v6-medium-hint', startedAt: new Date().toISOString(), delivery: 'submitting' };
          await persist('正在识别衣物');
          const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST', signal, redirect: 'error', headers: { Authorization: `Bearer ${config.NEW_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: config.AI_RECOGNITION_MODEL, reasoning_effort: 'medium', response_format: { type: 'json_object' }, max_completion_tokens: 4096, messages: [
              { role: 'system', content: RECOGNITION_PROMPT },
              { role: 'user', content: [
                { type: 'text', text: JSON.stringify({ userPrompt: state.userPrompt || '', ...(target && !state.userPrompt ? { target, instruction: '只识别指定目标；整图用于上下文，局部图用于细节。只能报告可见特征，隐藏的肩带、后背等结构返回未知；同图其他成员不算目标歧义。' } : {}), allowedCategories: categories.rows, allowedStyleTags: tags.rows.filter(tag => tag.kind === 'style').map(tag => ({ id: tag.id, name: tag.name })), allowedOccasionTags: tags.rows.filter(tag => tag.kind === 'occasion').map(tag => ({ id: tag.id, name: tag.name })) }) },
                { type: 'image_url', image_url: { url: `data:${input.rows[0].mime_type};base64,${photo.toString('base64')}` } },
                ...(targetPhoto ? [{ type: 'image_url', image_url: { url: `data:image/png;base64,${targetPhoto.toString('base64')}` } }] : [])
              ] }
            ] })
          });
          state.recognition.requestId = response.headers.get('x-request-id') || response.headers.get('x-oneapi-request-id') || undefined;
          const body = await readLimited(response, 1024 * 1024);
          state.recognition.delivery = 'completed';
          if (!response.ok) throw new HttpError(502, 'RECOGNITION_REQUEST_FAILED', `资料识别请求失败（HTTP ${response.status}），请检查通道是否支持此模型的图片理解接口`);
          const payload: unknown = JSON.parse(body.toString('utf8'));
          const content = chatResponseSchema.parse(payload).choices[0].message.content.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
          const parsed: unknown = JSON.parse(content);
          const suggestions = recognitionSchema.transform(value => ({
            ...value,
            subcategoryName: categories.rows.some(category => category.id === value.rootCategoryId && category.parentId === null && category.name === value.subcategoryName) ? null : value.subcategoryName
          })).superRefine((value, context) => {
            const root = categories.rows.find(category => category.id === value.rootCategoryId && category.parentId === null);
            const category = categories.rows.find(category => category.id === value.categoryId);
            if (value.rootCategoryId === null && (value.categoryId !== null || value.subcategoryName !== null)
              || value.rootCategoryId !== null && (!root || !category || category.id !== root.id && category.parentId !== root.id)) {
              context.addIssue({ code: 'custom', message: '分类不属于允许的一级分类及其二级分类' });
            }
            if (value.subcategoryName && categories.rows.some(category => category.parentId === null && category.name === value.subcategoryName)) context.addIssue({ code: 'custom', message: '二级品类不能与一级分类同名' });
            for (const [kind, ids] of [['style', value.styleTagIds], ['occasion', value.occasionTagIds]] as const) {
              if (ids.some(id => !tags.rows.some(tag => tag.id === id && tag.kind === kind))) context.addIssue({ code: 'custom', message: '标签不在允许集合中' });
            }
          }).parse(parsed);
          result.suggestions = !target && !state.userPrompt && suggestions.inputIssues.includes('multiple-items') ? { ...suggestions, cutoutReadiness: 'needs-review' } : suggestions;
          delete result.subcategoryReviewed;
          result.colors = suggestions.colors;
          result.categoryCandidates = suggestions.categoryId ? [{ categoryId: suggestions.categoryId, rank: 1 }] : [];
        }
        if (stage === 'cutout') {
          if (!state.rawAssetId) {
            const form = new FormData();
            form.set('model', config.AI_CUTOUT_MODEL);
            if (edit) {
              form.append('image[]', new Blob([new Uint8Array(await readFile(join(config.MEDIA_DIR, edit.rows[0].storage_key)))], { type: edit.rows[0].mime_type }), 'current.png');
              form.append('image[]', new Blob([new Uint8Array(photo)], { type: input.rows[0].mime_type }), 'original');
            }
            if (!edit) form.set('image', new Blob([new Uint8Array(photo)], { type: input.rows[0].mime_type }), 'clothing');
            form.set('prompt', edit ? `${REPAIR_PROMPT}\n用户修补意见：${JSON.stringify({ userPrompt: state.userPrompt })}` : job.kind === 'set-cover' ? `${SET_COVER_PROMPT}\n目标资料（坐标基于整张原图）：${JSON.stringify(setTargets!.rows.map(item => item.target))}` : `${COMPLETION_PROMPT}\n${state.userPrompt || target ? `唯一目标资料（坐标基于整张原图）：${JSON.stringify(state.userPrompt ? { userPrompt: state.userPrompt } : target)}` : '目标是照片中唯一明确的主单品，输出一件；连衣裙不可拆成上衣与裙子。'}`);
            form.set('size', '1024x1024');
            form.set('background', 'transparent');
            form.set('output_format', 'png');
            form.set('quality', config.AI_CUTOUT_QUALITY);
            form.set('complexity', config.AI_CUTOUT_COMPLEXITY);
            form.set('n', '1');
            state.cutout = { model: config.AI_CUTOUT_MODEL, promptRevision: edit ? 'repair-v1' : job.kind === 'set-cover' ? 'set-cover-v1' : 'completion-v2', startedAt: new Date().toISOString(), delivery: 'submitting' };
            await persist(state.editAssetId ? '正在修补图片' : '正在生成透明图');
            const response = await fetch(`${baseUrl}/images/edits`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${config.NEW_API_KEY}` }, body: form, signal });
            state.cutout.requestId = response.headers.get('x-request-id') || response.headers.get('x-oneapi-request-id') || undefined;
            const body = await readLimited(response, 30 * 1024 * 1024);
            state.cutout.delivery = 'completed';
            if (!response.ok) throw new HttpError(502, 'CUTOUT_REQUEST_FAILED', `抠图请求失败（HTTP ${response.status}），请检查图像通道配置`);
            const payload: unknown = JSON.parse(body.toString('utf8'));
            const output = imageResponseSchema.parse(payload).data[0];
            const bytes = output.b64_json ? Buffer.from(output.b64_json, 'base64') : await downloadImage(output.url!, signal);
            if (bytes.length > 20 * 1024 * 1024) throw new HttpError(502, 'PROVIDER_RESULT_TOO_LARGE', '模型返回的文件过大');
            const info = await sharp(bytes, { limitInputPixels: 24000000 }).metadata();
            if (!['png', 'webp', 'jpeg'].includes(info.format || '')) throw new HttpError(502, 'IMAGE_UNSUPPORTED', '模型返回的图片格式不可用');
            const rawId = randomUUID();
            const rawKey = `cutouts/${rawId}.${info.format}`;
            await mkdir(join(config.MEDIA_DIR, 'cutouts'), { recursive: true });
            await writeFile(join(config.MEDIA_DIR, rawKey), bytes);
            await transaction(async client => {
              await client.query("INSERT INTO media_assets(id,user_id,kind,storage_key,mime_type,width,height,byte_size,parent_asset_id) VALUES($1,$2,'generated',$3,$4,$5,$6,$7,$8)", [rawId, job.user_id, rawKey, `image/${info.format}`, info.width, info.height, bytes.length, job.input_asset_id]);
              await client.query("UPDATE image_jobs SET processing_state=jsonb_set(processing_state,'{rawAssetId}',to_jsonb($2::text)) WHERE id=$1 AND status='running'", [job.id, rawId]);
            });
            state.rawAssetId = rawId;
          }
          await persist('正在整理图片');
          const raw = await pool.query<{ storage_key: string }>('SELECT storage_key FROM media_assets WHERE id=$1 AND user_id=$2', [state.rawAssetId, job.user_id]);
          const mask = maskSource ? await sharp(join(config.MEDIA_DIR, raw.rows[0].storage_key), { limitInputPixels: 24000000 }).resize(1024, 1024, { fit: 'fill' }).removeAlpha().greyscale().threshold(128).raw().toBuffer() : null;
          const decoded = await (maskSource ? sharp(maskSource) : sharp(join(config.MEDIA_DIR, raw.rows[0].storage_key), { limitInputPixels: 24000000 })).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          if (mask && maskContent) for (const [index, alpha] of mask.entries()) {
            const x = index % 1024;
            const y = Math.floor(index / 1024);
            decoded.data[index * 4 + 3] = x >= Math.floor((1024 - maskContent.info.width) / 2) && x < Math.floor((1024 - maskContent.info.width) / 2) + maskContent.info.width && y >= Math.floor((1024 - maskContent.info.height) / 2) && y < Math.floor((1024 - maskContent.info.height) / 2) + maskContent.info.height ? alpha : 0;
          }
          const bounds = { left: decoded.info.width, top: decoded.info.height, right: -1, bottom: -1, transparent: false };
          for (const index of decoded.data.keys()) {
            if (index % 4 !== 3) continue;
            if (decoded.data[index] <= 8) bounds.transparent = true;
            if (decoded.data[index] <= 8) continue;
            const pixel = (index - 3) / 4;
            bounds.left = Math.min(bounds.left, pixel % decoded.info.width);
            bounds.right = Math.max(bounds.right, pixel % decoded.info.width);
            bounds.top = Math.min(bounds.top, Math.floor(pixel / decoded.info.width));
            bounds.bottom = Math.max(bounds.bottom, Math.floor(pixel / decoded.info.width));
          }
          if (!bounds.transparent || bounds.right < 0) {
            delete state.rawAssetId;
            throw new HttpError(502, 'INVALID_TRANSPARENCY', '模型未返回有效透明单品图，请检查结果后重新处理');
          }
          const foreground = await sharp(decoded.data, { raw: decoded.info }).extract({ left: bounds.left, top: bounds.top, width: bounds.right - bounds.left + 1, height: bounds.bottom - bounds.top + 1 }).resize(896, 896, { fit: 'contain', background: '#00000000' }).extend({ top: 64, bottom: 64, left: 64, right: 64, background: '#00000000' }).png().toBuffer();
          const thumbnail = await sharp(foreground).resize({ width: 480, height: 528, fit: 'inside' }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
          const outputId = randomUUID();
          const thumbnailId = randomUUID();
          await mkdir(join(config.MEDIA_DIR, 'thumbnails'), { recursive: true });
          await writeFile(join(config.MEDIA_DIR, `cutouts/${outputId}.png.tmp`), foreground);
          await rename(join(config.MEDIA_DIR, `cutouts/${outputId}.png.tmp`), join(config.MEDIA_DIR, `cutouts/${outputId}.png`));
          await writeFile(join(config.MEDIA_DIR, `thumbnails/${thumbnailId}.webp`), thumbnail.data);
          controller.signal.throwIfAborted();
          await transaction(async client => {
            const active = await client.query("SELECT j.id FROM image_jobs j JOIN users u ON u.id=j.user_id WHERE j.id=$1 AND j.status='running' AND NOT j.cancel_requested AND u.status='active' FOR UPDATE OF j", [job.id]);
            if (!active.rows.length) throw new HttpError(409, 'JOB_CANCELLED', '处理已取消');
            await client.query("INSERT INTO media_assets(id,user_id,kind,storage_key,mime_type,width,height,byte_size,parent_asset_id) VALUES($1,$2,'cutout',$3,'image/png',1024,1024,$4,$5),($6,$2,'thumbnail',$7,'image/webp',$8,$9,$10,$1)", [outputId, job.user_id, `cutouts/${outputId}.png`, foreground.length, job.input_asset_id, thumbnailId, `thumbnails/${thumbnailId}.webp`, thumbnail.info.width, thumbnail.info.height, thumbnail.data.length]);
            await client.query("UPDATE image_jobs SET result=jsonb_set(jsonb_set(COALESCE(result,'{}'),'{cutoutAssetId}',to_jsonb($2::text)),'{thumbnailAssetId}',to_jsonb($3::text)) WHERE id=$1", [job.id, outputId, thumbnailId]);
          });
          result.cutoutAssetId = outputId;
          result.thumbnailAssetId = thumbnailId;
        }
        result.steps[stage] = { status: 'succeeded' };
      } catch (error) {
        const failure = providerFailure(error);
        const call = state[stage];
        if (call) {
          call.failure = failure;
          if (call.delivery === 'submitting') call.delivery = !call.requestId && failure.notSent ? 'not-sent' : 'unknown';
        }
        console.error(JSON.stringify({ event: 'ai_provider_failed', jobId: job.id, stage, requestId: call?.requestId, delivery: call?.delivery, ...failure }));
        result.steps[stage] = {
          status: 'failed',
          errorCode: call?.delivery === 'unknown' ? 'PROVIDER_PENDING' : call?.delivery === 'not-sent' ? 'PROVIDER_CONNECTION_FAILED' : error instanceof HttpError ? error.code : error instanceof z.ZodError || error instanceof SyntaxError ? 'INVALID_MODEL_RESPONSE' : signal.aborted ? 'JOB_TIMEOUT' : 'IMAGE_PROCESSING_FAILED',
          message: call?.delivery === 'unknown' ? '处理未完成，请重试' : call?.delivery === 'not-sent' ? '连接模型服务失败，请重试' : error instanceof HttpError ? error.message : error instanceof z.ZodError || error instanceof SyntaxError ? '模型返回的资料格式不符合约定，请检查模型能力' : '本阶段未能完成，已保留其他处理结果'
        };
      }
      if (state[stage]) state[stage].finishedAt = new Date().toISOString();
      await persist('正在整理处理结果');
    }));
    const complete = Object.values(result.steps).every(step => step.status === 'succeeded' || step.status === 'skipped' && step.skipReason === 'not-requested');
    const usable = Boolean(state.editAssetId ? result.cutoutAssetId : result.suggestions || result.cutoutAssetId);
    if (usable) result.outcome = complete ? 'complete' : 'partial';
    result.canRetry = !Object.values(state).some(call => typeof call === 'object' && call.delivery === 'unknown') && (Boolean(state.editAssetId) || result.suggestions?.cutoutReadiness !== 'retake') && !complete;
    const errors = Object.values(result.steps).filter(step => step.status === 'failed');
    await transaction(async client => {
      const appliedState = { ...state };
      if (job.kind === 'set-cover') await client.query('SELECT id FROM clothing_imports WHERE user_id=$1 AND id=$2 FOR UPDATE', [job.user_id, job.import_id]);
      const active = await client.query<{ cancel_requested: boolean; timezone: string }>("SELECT j.cancel_requested,u.timezone FROM image_jobs j JOIN users u ON u.id=j.user_id WHERE j.id=$1 AND j.status='running' AND u.status='active' FOR UPDATE OF j", [job.id]);
      if (!active.rows.length) return;
      if (job.kind === 'set-cover' && result.cutoutAssetId && !active.rows[0].cancel_requested && !controller.signal.aborted) {
        await client.query("UPDATE clothing_imports SET cover_asset_id=$3,version=version+1 WHERE user_id=$1 AND id=$2 AND status NOT IN ('confirmed','cancelled') AND cover_asset_id IS NOT DISTINCT FROM $4::uuid", [job.user_id, job.import_id, result.cutoutAssetId, state.coverAssetId || null]);
      }
      if (job.clothing_id && usable && !active.rows[0].cancel_requested && !controller.signal.aborted) {
        const clothing = await client.query('SELECT id FROM clothes WHERE user_id=$1 AND id=$2 FOR UPDATE', [job.user_id, job.clothing_id]);
        if (clothing.rows.length) {
          const current = await readClothing(client, job.user_id, job.clothing_id);
          const saved = current.version === (state.lastAppliedVersion ?? state.clothingVersion) ? await saveClothing(client, job.user_id, {
            ...current,
            ...(result.suggestions && !state.recognitionApplied ? {
              name: result.suggestions.name || current.name, categoryId: result.suggestions.categoryId || current.categoryId,
              colors: result.suggestions.colors, seasons: result.suggestions.seasons,
              tagIds: [...result.suggestions.styleTagIds, ...result.suggestions.occasionTagIds],
              itemType: result.suggestions.itemType, colorDescription: result.suggestions.colorDescription,
              pattern: result.suggestions.pattern, visibleFeatures: result.suggestions.visibleFeatures
            } : {}),
            primaryAssetId: state.cutoutApplied ? current.primaryAssetId : result.cutoutAssetId || current.primaryAssetId
          }, active.rows[0].timezone, current, job.id) : current;
          appliedState.lastAppliedVersion = saved.version;
          appliedState.recognitionApplied = state.recognitionApplied || Boolean(result.suggestions);
          appliedState.cutoutApplied = state.cutoutApplied || Boolean(result.cutoutAssetId);
        }
      }
      await client.query("UPDATE image_jobs SET status=CASE WHEN cancel_requested THEN 'cancelled' WHEN $2 THEN 'succeeded' ELSE 'failed' END,phase=$3,result=$4,processing_state=$5,error_code=$6,model_revision=$7,finished_at=now(),lease_expires_at=NULL WHERE id=$1 AND status='running'", [job.id, usable, controller.signal.aborted ? '处理已结束，已有结果已保留' : complete ? '处理完成，待核对' : usable ? '部分处理完成，待核对' : '处理未完成，可手动编辑', JSON.stringify(result), JSON.stringify(appliedState), usable ? null : errors[0]?.errorCode || 'IMAGE_PROCESSING_FAILED', config.AI_CUTOUT_MODEL]);
    });
  } catch (error) {
    result.canRetry = !Object.values(state).some(call => typeof call === 'object' && (call.delivery === 'submitting' || call.delivery === 'unknown'));
    await pool.query("UPDATE image_jobs SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,phase='处理未完成',result=$2,processing_state=$3,error_code=$4,finished_at=now(),lease_expires_at=NULL WHERE id=$1 AND status='running'", [job.id, JSON.stringify(result), JSON.stringify(state), error instanceof HttpError ? error.code : 'IMAGE_PROCESSING_FAILED']);
    console.error(JSON.stringify({ event: 'ai_image_job_failed', jobId: job.id, errorType: error instanceof Error ? error.name : 'UnknownError' }));
  } finally { clearInterval(heartbeat); }
}

async function downloadImage(value: string, signal: AbortSignal) {
  const url = new URL(value);
  const allowed = [new URL(config.NEW_API_BASE_URL).hostname, ...config.AI_IMAGE_DOWNLOAD_HOSTS.split(',').map(host => host.trim()).filter(Boolean)];
  if (url.protocol !== 'https:' || url.username || url.password || !allowed.includes(url.hostname)) throw new HttpError(502, 'IMAGE_DOWNLOAD_HOST_REQUIRED', '请将模型图片下载域名填入服务端 AI_IMAGE_DOWNLOAD_HOSTS');
  const response = await fetch(url, { signal, redirect: 'error' });
  if (!response.ok) throw new HttpError(502, 'IMAGE_DOWNLOAD_FAILED', '模型图片下载失败');
  return readLimited(response, 20 * 1024 * 1024);
}
