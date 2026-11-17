import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { detectionSchema } from '../../miniprogram/api/contracts.js';
import { config } from './config.js';
import { pool, transaction } from './db.js';
import { HttpError } from './errors.js';
import { DETECTION_PROMPT } from './image-prompts.js';
import { readLimited } from './ai-images.js';
import type { AiJob } from './ai-images.js';
import { providerFailure } from './provider-failure.js';
import { createImportMember } from './clothing-imports.js';

export async function processClothingDetection(job: AiJob) {
  const state = job.processing_state;
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    void pool.query<{ cancel_requested: boolean }>("UPDATE image_jobs SET heartbeat_at=now(),lease_expires_at=now()+interval '30 seconds' WHERE id=$1 AND status='running' RETURNING cancel_requested", [job.id]).then(result => { if (!result.rows.length || result.rows[0].cancel_requested) controller.abort(); }).catch(() => controller.abort());
  }, 5000);
  try {
    if (!config.NEW_API_KEY) throw new HttpError(503, 'SERVICE_NOT_CONFIGURED', '图片处理暂不可用，请稍后再试');
    const input = await pool.query<{ storage_key: string; mime_type: string }>("SELECT storage_key,mime_type FROM media_assets WHERE user_id=$1 AND id=$2 AND status='ready'", [job.user_id, job.input_asset_id]);
    if (!input.rows.length) throw new HttpError(404, 'RESOURCE_NOT_FOUND', '输入图片不可用');
    state.detection = { model: config.AI_RECOGNITION_MODEL, promptRevision: 'locate-v2', startedAt: new Date().toISOString(), delivery: 'submitting' };
    await pool.query("UPDATE image_jobs SET phase='正在定位套装成员',processing_state=$2 WHERE id=$1", [job.id, JSON.stringify(state)]);
    const response = await fetch(`${config.NEW_API_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(config.AI_RECOGNITION_TIMEOUT_MS)]),
      headers: { Authorization: `Bearer ${config.NEW_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.AI_RECOGNITION_MODEL, reasoning_effort: 'medium', max_completion_tokens: 2048, response_format: { type: 'json_object' }, messages: [
        { role: 'system', content: DETECTION_PROMPT },
        { role: 'user', content: [{ type: 'text', text: JSON.stringify({ userPrompt: state.userPrompt || '' }) }, { type: 'image_url', image_url: { url: `data:${input.rows[0].mime_type};base64,${(await readFile(join(config.MEDIA_DIR, input.rows[0].storage_key))).toString('base64')}` } }] }
      ] })
    });
    state.detection.requestId = response.headers.get('x-request-id') || response.headers.get('x-oneapi-request-id') || undefined;
    const body = await readLimited(response, 1024 * 1024);
    state.detection.delivery = 'completed';
    state.detection.finishedAt = new Date().toISOString();
    if (!response.ok) throw new HttpError(502, 'DETECTION_REQUEST_FAILED', `套装定位失败（HTTP ${response.status}）`);
    const payload: unknown = JSON.parse(body.toString('utf8'));
    const content = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) }).parse(payload).choices[0].message.content.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const parsed: unknown = JSON.parse(content);
    const detection = detectionSchema.parse(parsed);
    await transaction(async client => {
      const record = await client.query<{ id: string; status: string; timezone: string; cover_asset_id: string | null }>('SELECT r.id,r.status,r.cover_asset_id,u.timezone FROM clothing_imports r JOIN users u ON u.id=r.user_id WHERE r.user_id=$1 AND r.id=$2 AND u.status=\'active\' FOR UPDATE OF r', [job.user_id, job.import_id]);
      const active = await client.query("SELECT id FROM image_jobs WHERE id=$1 AND status='running' AND NOT cancel_requested FOR UPDATE", [job.id]);
      if (!record.rows.length || record.rows[0].status === 'cancelled' || !active.rows.length || controller.signal.aborted) {
        await client.query("UPDATE image_jobs SET status='cancelled',phase='已取消',finished_at=now(),processing_state=$2,lease_expires_at=NULL WHERE id=$1", [job.id, JSON.stringify(state)]);
        return;
      }
      if (detection.targets.length < 2) {
        await client.query("UPDATE image_jobs SET status='failed',error_code='DETECTION_INSUFFICIENT_ITEMS',phase=$2,result=$3,processing_state=$4,finished_at=now(),lease_expires_at=NULL WHERE id=$1", [job.id, `只定位到 ${detection.targets.length} 件，未生成单品。请补充描述重新识别，或更换照片`, JSON.stringify({ detection }), JSON.stringify(state)]);
        return;
      }
      for (const [index, target] of detection.targets.entries()) await createImportMember(client, job.user_id, record.rows[0].timezone, { id: job.import_id!, inputAssetId: job.input_asset_id! }, `${job.id}-${index + 1}`, target);
      await client.query("INSERT INTO image_jobs(user_id,input_asset_id,kind,import_id,processing_state) VALUES($1,$2,'set-cover',$3,$4)", [job.user_id, job.input_asset_id, job.import_id, JSON.stringify({ coverAssetId: record.rows[0].cover_asset_id || '' })]);
      await client.query('UPDATE clothing_imports SET name=$3,version=version+1 WHERE user_id=$1 AND id=$2', [job.user_id, job.import_id, detection.name]);
      await client.query("UPDATE image_jobs SET status='succeeded',phase=$2,result=$3,processing_state=$4,finished_at=now(),lease_expires_at=NULL WHERE id=$1", [job.id, `已定位 ${detection.targets.length} 件`, JSON.stringify({ detection }), JSON.stringify(state)]);
    });
  } catch (error) {
    const failure = providerFailure(error);
    if (state.detection) {
      state.detection.failure = failure;
      state.detection.finishedAt = new Date().toISOString();
      if (state.detection.delivery === 'submitting') state.detection.delivery = !state.detection.requestId && failure.notSent ? 'not-sent' : 'unknown';
    }
    console.error(JSON.stringify({ event: 'ai_provider_failed', jobId: job.id, stage: 'detection', requestId: state.detection?.requestId, delivery: state.detection?.delivery, ...failure }));
    await pool.query("UPDATE image_jobs SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,phase=$2,error_code=$3,processing_state=$4,finished_at=now(),lease_expires_at=NULL WHERE id=$1 AND status='running'", [job.id, state.detection?.delivery === 'unknown' ? '处理未完成，请重试' : state.detection?.delivery === 'not-sent' ? '连接模型服务失败，请重试' : error instanceof HttpError ? error.message : '套装定位未完成，请核对照片', state.detection?.delivery === 'unknown' ? 'PROVIDER_PENDING' : state.detection?.delivery === 'not-sent' ? 'PROVIDER_CONNECTION_FAILED' : error instanceof HttpError ? error.code : 'INVALID_MODEL_RESPONSE', JSON.stringify(state)]);
  } finally { clearInterval(heartbeat); }
}
