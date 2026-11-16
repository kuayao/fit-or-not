import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import sharp from 'sharp';
import { ZipFile } from 'yazl';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { ImageJobResult } from '../../miniprogram/api/contracts.js';
import { processClothingDetection } from './clothing-detection.js';
import { refreshImportStatus } from './clothing-imports.js';
import { processAiImageJob } from './ai-images.js';
import type { ImageProcessingState } from './ai-images.js';
import { config } from './config.js';
import { pool, transaction } from './db.js';
import { readOutfit } from './outfits.js';
import { HttpError } from './errors.js';

type ClaimedJob = { id: string; user_id: string; kind: string; input_asset_id: string | null; clothing_id: string | null; outfit_id: string | null; outfit_version: number | null; import_id: string | null; import_item_id: string | null; result: ImageJobResult | null; processing_state: ImageProcessingState };
async function recordAsset(client: PoolClient, userId: string, id: string, key: string, kind: string, mime: string, parentId: string | null = null) {
  const file = join(config.MEDIA_DIR, key);
  const info = mime.startsWith('image/') ? await sharp(file).metadata() : { width: 0, height: 0 };
  await client.query('INSERT INTO media_assets(id,user_id,kind,storage_key,mime_type,width,height,byte_size,parent_asset_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, userId, kind, key, mime, info.width, info.height, (await stat(file)).size, parentId]);
}
export async function processNextImageJob() {
  const job = await transaction(async client => {
    const result = await client.query<ClaimedJob>(`SELECT j.id,j.user_id,j.kind,j.input_asset_id,j.clothing_id,j.outfit_id,j.outfit_version,j.import_id,j.import_item_id,j.result,j.processing_state FROM image_jobs j JOIN users u ON u.id=j.user_id WHERE j.status='queued' AND u.status='active' ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
    if (!result.rows.length) return null;
    await client.query("UPDATE image_jobs SET status='running',phase='正在准备',started_at=now(),heartbeat_at=now(),lease_expires_at=now()+interval '30 seconds' WHERE id=$1", [result.rows[0].id]);
    return result.rows[0];
  });
  if (!job) return false;
  if (job.kind !== 'outfit-cover') {
    const companions = job.import_id && job.kind !== 'locate' ? await transaction(async client => {
      const members = await client.query<ClaimedJob>(`SELECT j.id,j.user_id,j.kind,j.input_asset_id,j.clothing_id,j.outfit_id,j.outfit_version,j.import_id,j.import_item_id,j.result,j.processing_state FROM image_jobs j WHERE j.user_id=$1 AND j.import_id=$2 AND j.import_item_id IS NOT NULL AND j.status='queued' ORDER BY j.created_at,j.id FOR UPDATE SKIP LOCKED LIMIT $3`, [job.user_id, job.import_id, job.import_item_id ? 1 : 2]);
      const cover = job.kind !== 'set-cover' ? await client.query<ClaimedJob>(`SELECT j.id,j.user_id,j.kind,j.input_asset_id,j.clothing_id,j.outfit_id,j.outfit_version,j.import_id,j.import_item_id,j.result,j.processing_state FROM image_jobs j WHERE j.user_id=$1 AND j.import_id=$2 AND j.kind='set-cover' AND j.status='queued' ORDER BY j.created_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1`, [job.user_id, job.import_id]) : null;
      const next = [...members.rows, ...(cover?.rows || [])];
      await client.query("UPDATE image_jobs SET status='running',phase='正在准备',started_at=now(),heartbeat_at=now(),lease_expires_at=now()+interval '30 seconds' WHERE id=ANY($1::uuid[])", [next.map(item => item.id)]);
      return next;
    }) : [];
    await Promise.all([job, ...companions].map(async item => {
      await (item.kind === 'locate' ? processClothingDetection(item) : processAiImageJob(item));
      await refreshImportStatus(item.import_id);
    }));
    return true;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const heartbeat = setInterval(() => {
    void pool.query<{ cancel_requested: boolean }>("UPDATE image_jobs SET heartbeat_at=now(),lease_expires_at=now()+interval '30 seconds' WHERE id=$1 AND status='running' RETURNING cancel_requested", [job.id]).then(result => { if (!result.rows.length || result.rows[0].cancel_requested) controller.abort(); }).catch(() => controller.abort());
  }, 5000);
  const outputId = randomUUID();
  const outputKey = `outfit-covers/${outputId}.png`;
  const thumbnailId = randomUUID();
  const thumbnailKey = `thumbnails/${thumbnailId}.webp`;
  const written = [outputKey, `${outputKey}.tmp`, thumbnailKey];
  try {
    await Promise.all([outputKey, thumbnailKey].map(key => mkdir(dirname(join(config.MEDIA_DIR, key)), { recursive: true })));
    const result = await renderCover(job, outputKey);
    await sharp(join(config.MEDIA_DIR, outputKey)).resize({ width: 480, height: 640, fit: 'inside' }).webp({ quality: 82 }).toFile(join(config.MEDIA_DIR, thumbnailKey));
    const accepted = await transaction(async client => {
      const status = await client.query<{ cancel_requested: boolean; status: string }>('SELECT cancel_requested,status FROM image_jobs WHERE id=$1 FOR UPDATE', [job.id]);
      if (!status.rows.length || status.rows[0].cancel_requested || status.rows[0].status !== 'running' || controller.signal.aborted) return false;
      const owner = await client.query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE", [job.user_id]);
      if (!owner.rows.length) return false;
      const outfit = await client.query('SELECT id FROM outfits WHERE user_id=$1 AND id=$2 AND version=$3 FOR UPDATE', [job.user_id, job.outfit_id, job.outfit_version]);
      if (!outfit.rows.length) return false;
      await recordAsset(client, job.user_id, outputId, outputKey, 'outfit-cover', 'image/png', job.input_asset_id);
      await recordAsset(client, job.user_id, thumbnailId, thumbnailKey, 'thumbnail', 'image/webp', outputId);
      await client.query('UPDATE outfits SET cover_asset_id=$3 WHERE user_id=$1 AND id=$2 AND version=$4', [job.user_id, job.outfit_id, outputId, job.outfit_version]);
      await client.query("UPDATE image_jobs SET status='succeeded',phase='处理完成',result=$2,model_revision=$3,finished_at=now(),lease_expires_at=NULL WHERE id=$1", [job.id, JSON.stringify({ ...result, cutoutAssetId: outputId, thumbnailAssetId: thumbnailId }), result.modelRevision]);
      return true;
    });
    if (!accepted) {
      await pool.query("UPDATE image_jobs SET status='cancelled',phase='已取消',finished_at=now(),lease_expires_at=NULL WHERE id=$1 AND status='running'", [job.id]);
      await removeFiles(written);
    }
  } catch (error) {
    await removeFiles(written);
    const state = await pool.query<{ cancel_requested: boolean }>('SELECT cancel_requested FROM image_jobs WHERE id=$1', [job.id]);
    const cancelled = state.rows[0]?.cancel_requested || error instanceof HttpError && error.code === 'STALE_OUTFIT';
    await pool.query('UPDATE image_jobs SET status=$2,phase=$3,error_code=$4,finished_at=now(),lease_expires_at=NULL WHERE id=$1 AND status=\'running\'', [job.id, cancelled ? 'cancelled' : 'failed', cancelled ? '已取消' : '处理失败', cancelled ? null : controller.signal.aborted ? 'JOB_TIMEOUT' : error instanceof HttpError ? error.code : 'IMAGE_PROCESSING_FAILED']);
    console.error(JSON.stringify({ event: 'image_job_failed', jobId: job.id, errorType: error instanceof Error ? error.name : 'UnknownError' }));
  } finally { clearTimeout(timeout); clearInterval(heartbeat); }
  return true;
}
async function renderCover(job: ClaimedJob, key: string) {
  const outfit = await readOutfit(pool, job.user_id, job.outfit_id!);
  if (outfit.version !== job.outfit_version) throw new HttpError(409, 'STALE_OUTFIT', '搭配已更新');
  const layers = [];
  for (const item of outfit.items) {
    const asset = await pool.query<{ storage_key: string }>('SELECT a.storage_key FROM clothes c JOIN media_assets a ON a.id=c.primary_asset_id AND a.user_id=c.user_id WHERE c.user_id=$1 AND c.id=$2', [job.user_id, item.clothingId]);
    const image = await sharp(join(config.MEDIA_DIR, asset.rows[0].storage_key)).resize(Math.max(1, Math.round(item.width * 1080)), Math.max(1, Math.round(item.height * 1440)), { fit: 'contain', background: '#00000000' }).rotate(item.rotation, { background: '#00000000' }).png().toBuffer({ resolveWithObject: true });
    layers.push({ input: image.data, left: Math.round((item.x + item.width / 2) * 1080 - image.info.width / 2), top: Math.round((item.y + item.height / 2) * 1440 - image.info.height / 2) });
  }
  await sharp({ create: { width: 1080, height: 1440, channels: 4, background: outfit.backgroundColor } }).composite(layers).png().toFile(join(config.MEDIA_DIR, `${key}.tmp`));
  await rename(join(config.MEDIA_DIR, `${key}.tmp`), join(config.MEDIA_DIR, key));
  return { modelRevision: 'sharp-0.35.5' };
}
async function removeFiles(keys: string[]) {
  for (const key of keys) await unlink(join(config.MEDIA_DIR, key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
export async function processNextExport() {
  const result = await pool.query<{ id: string; user_id: string }>("UPDATE data_exports SET status='running' WHERE id=(SELECT e.id FROM data_exports e JOIN users u ON u.id=e.user_id WHERE e.status='queued' AND u.status='active' ORDER BY e.created_at,e.id LIMIT 1) RETURNING id,user_id");
  if (!result.rows.length) return false;
  const job = result.rows[0]; const assetId = randomUUID(); const key = `exports/${assetId}.zip`;
  try {
    await mkdir(dirname(join(config.MEDIA_DIR, key)), { recursive: true });
    const snapshot = await transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const tables = [
        ['user', 'SELECT id,nickname,city_code,timezone,preferences,created_at FROM users WHERE id=$1'],
        ['categories', 'SELECT c.id,c.name,c.parent_id,c.sort_order,COALESCE(p.size_kind,c.size_kind) AS size_kind FROM categories c LEFT JOIN categories p ON p.user_id=c.user_id AND p.id=c.parent_id WHERE c.user_id=$1'],
        ['tags', 'SELECT id,name,kind,sort_order FROM tags WHERE user_id=$1'],
        ['clothingOptions', 'SELECT id,kind,name,sort_order FROM clothing_options WHERE user_id=$1'],
        ['clothes', `SELECT c.id,c.name,c.set_id,c.category_id,c.primary_asset_id,c.status,c.colors,c.seasons,c.item_type,c.color_description,c.pattern,c.visible_features,c.brand_id,c.size_id,c.material_id,COALESCE(b.name,'') AS brand,COALESCE(s.name,'') AS size_label,COALESCE(m.name,'') AS material,c.price_cents::text,c.purchased_on,c.notes,c.favorite,c.created_at FROM clothes c LEFT JOIN clothing_options b ON b.user_id=c.user_id AND b.id=c.brand_id LEFT JOIN clothing_options s ON s.user_id=c.user_id AND s.id=c.size_id LEFT JOIN clothing_options m ON m.user_id=c.user_id AND m.id=c.material_id WHERE c.user_id=$1`],
        ['clothingSets', 'SELECT id,name,cover_asset_id,version,created_at FROM clothing_sets WHERE user_id=$1'],
        ['clothingImports', 'SELECT id,input_asset_id,mode,status,name,save_as_set,cover_asset_id,created_at,confirmed_at FROM clothing_imports WHERE user_id=$1'],
        ['clothingImportItems', 'SELECT id,import_id,clothing_id,target_key,target,included FROM clothing_import_items WHERE user_id=$1'],
        ['clothingTags', 'SELECT clothing_id,tag_id FROM clothing_tags WHERE user_id=$1'],
        ['clothingAssets', 'SELECT clothing_id,asset_id,role,sort_order FROM clothing_assets WHERE user_id=$1'],
        ['outfits', 'SELECT id,name,occasion,seasons,notes,favorite,background_color,cover_asset_id FROM outfits WHERE user_id=$1'],
        ['outfitItems', 'SELECT outfit_id,clothing_id,x,y,width,height,rotation,z_index FROM outfit_items WHERE user_id=$1'],
        ['wearRecords', 'SELECT id,worn_on,occasion,notes,source_outfit_id,body_asset_id FROM wear_records WHERE user_id=$1'],
        ['wearItems', 'SELECT wear_record_id,clothing_id,name_snapshot,category_snapshot FROM wear_items WHERE user_id=$1'],
        ['packingLists', 'SELECT id,name,start_on,end_on FROM packing_lists WHERE user_id=$1'],
        ['packingItems', 'SELECT packing_list_id,clothing_id,packed,sort_order FROM packing_items WHERE user_id=$1']
      ] as const;
      const collections: [string, Record<string, unknown>[]][] = [];
      for (const [name, sql] of tables) collections.push([name, (await client.query<Record<string, unknown>>(sql, [job.user_id])).rows]);
      const media = await client.query<{ id: string; storage_key: string; mime_type: string; kind: string; parent_asset_id: string | null }>("SELECT id,storage_key,mime_type,kind,parent_asset_id FROM media_assets WHERE user_id=$1 AND status='ready' AND kind<>'export'", [job.user_id]);
      return { data: Object.fromEntries(collections), media: media.rows };
    });
    const output = createWriteStream(join(config.MEDIA_DIR, `${key}.tmp`));
    const archive = new ZipFile();
    const completed = new Promise<void>((resolveDone, reject) => { output.on('close', resolveDone); output.on('error', reject); archive.on('error', reject); });
    archive.outputStream.pipe(output);
    archive.addBuffer(Buffer.from(JSON.stringify({ exportedAt: new Date().toISOString(), timezone: 'Asia/Shanghai', ...snapshot.data, media: snapshot.media.map(asset => ({ id: asset.id, kind: asset.kind, mimeType: asset.mime_type, parentAssetId: asset.parent_asset_id, file: `media/${asset.storage_key}` })) }, null, 2)), 'data.json');
    const csvFields = ['id', 'name', 'price_cents', 'status', 'purchased_on'];
    archive.addBuffer(Buffer.from('\ufeff' + [csvFields.join(','), ...snapshot.data['clothes'].map(item => csvFields.map(field => `"${String(item[field] ?? '').replaceAll('"', '""')}"`).join(','))].join('\r\n')), 'clothes.csv');
    archive.addBuffer(Buffer.from('衣橱数据导出\n日期按 Asia/Shanghai 自然日记录；金额为人民币整数分字符串，空值与零元不同。\ndata.json 保存完整关系；clothes.csv 为衣物摘要；media/ 保存原图与派生文件。\n不包含微信身份、会话、服务密钥或其他成员数据。\n'), 'README.txt');
    for (const asset of snapshot.media) archive.addFile(join(config.MEDIA_DIR, asset.storage_key), `media/${asset.storage_key}`);
    archive.end(); await completed;
    await rename(join(config.MEDIA_DIR, `${key}.tmp`), join(config.MEDIA_DIR, key));
    await transaction(async client => {
      const user = await client.query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE", [job.user_id]);
      if (!user.rows.length) throw new HttpError(409, 'ACCOUNT_DELETING', '账号正在注销');
      await recordAsset(client, job.user_id, assetId, key, 'export', 'application/zip');
      await client.query("UPDATE data_exports SET status='succeeded',asset_id=$2,expires_at=now()+interval '24 hours' WHERE id=$1", [job.id, assetId]);
    });
  } catch {
    await removeFiles([key, `${key}.tmp`]);
    await pool.query("UPDATE data_exports SET status='failed',error_code='EXPORT_FAILED' WHERE id=$1", [job.id]);
  }
  return true;
}
export async function maintenance() {
  await pool.query("UPDATE image_jobs SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,phase='任务已结束',error_code=CASE WHEN cancel_requested THEN NULL ELSE 'WORKER_LEASE_EXPIRED' END,finished_at=now() WHERE status='running' AND lease_expires_at<now()");
  const staleImports = await pool.query<{ id: string }>("SELECT id FROM clothing_imports WHERE status IN ('queued','processing') AND NOT EXISTS(SELECT 1 FROM image_jobs WHERE import_id=clothing_imports.id AND status IN ('queued','running'))");
  for (const record of staleImports.rows) await refreshImportStatus(record.id);
  await pool.query("DELETE FROM registrations WHERE expires_at<now()");
  await pool.query("UPDATE media_assets SET status='deleting' WHERE id IN (SELECT asset_id FROM data_exports WHERE expires_at<now())");
  const expired = await pool.query<{ id: string; storage_key: string }>("SELECT id,storage_key FROM media_assets WHERE status='deleting' AND kind='export'");
  for (const asset of expired.rows) {
    await removeFiles([asset.storage_key]);
    await transaction(async client => { await client.query('UPDATE data_exports SET asset_id=NULL WHERE asset_id=$1', [asset.id]); await client.query('DELETE FROM media_assets WHERE id=$1', [asset.id]); });
  }
  const deleting = await pool.query<{ id: string }>("SELECT u.id FROM users u WHERE status='deleting' AND NOT EXISTS(SELECT 1 FROM image_jobs j WHERE j.user_id=u.id AND j.status IN ('queued','running'))");
  for (const user of deleting.rows) {
    const files = await pool.query<{ storage_key: string }>('SELECT storage_key FROM media_assets WHERE user_id=$1', [user.id]);
    await removeFiles(files.rows.map(file => file.storage_key));
    await transaction(async client => {
      await client.query("SELECT id FROM users WHERE id=$1 AND status='deleting' FOR UPDATE", [user.id]);
      await client.query('DELETE FROM wear_records WHERE user_id=$1', [user.id]);
      await client.query('DELETE FROM packing_lists WHERE user_id=$1', [user.id]);
      await client.query('DELETE FROM outfits WHERE user_id=$1', [user.id]);
      await client.query('DELETE FROM image_jobs WHERE user_id=$1', [user.id]);
      await client.query('DELETE FROM clothing_imports WHERE user_id=$1', [user.id]);
      await client.query('DELETE FROM clothing_sets WHERE user_id=$1', [user.id]);
      await client.query('DELETE FROM clothes WHERE user_id=$1', [user.id]);
      await client.query('DELETE FROM data_exports WHERE user_id=$1', [user.id]);
      await client.query('DELETE FROM media_assets WHERE user_id=$1', [user.id]);
      await client.query("DELETE FROM users WHERE id=$1 AND status='deleting'", [user.id]);
    });
  }
  await transaction(async client => {
    await client.query("SELECT id FROM media_assets WHERE status='ready' AND created_at<now()-interval '24 hours' ORDER BY id FOR UPDATE");
    await client.query(`WITH RECURSIVE seeds(id) AS (
      SELECT primary_asset_id FROM clothes UNION SELECT asset_id FROM clothing_assets
      UNION SELECT avatar_asset_id FROM users WHERE avatar_asset_id IS NOT NULL
      UNION SELECT input_asset_id FROM clothing_imports
      UNION SELECT cover_asset_id FROM clothing_imports WHERE cover_asset_id IS NOT NULL
      UNION SELECT cover_asset_id FROM clothing_sets WHERE cover_asset_id IS NOT NULL
      UNION SELECT cover_asset_id FROM outfits WHERE cover_asset_id IS NOT NULL
      UNION SELECT body_asset_id FROM wear_records WHERE body_asset_id IS NOT NULL
      UNION SELECT input_asset_id FROM image_jobs WHERE input_asset_id IS NOT NULL
      UNION SELECT (result->>'cutoutAssetId')::uuid FROM image_jobs WHERE result->>'cutoutAssetId' IS NOT NULL
      UNION SELECT (result->>'thumbnailAssetId')::uuid FROM image_jobs WHERE result->>'thumbnailAssetId' IS NOT NULL
      UNION SELECT (processing_state->>'editAssetId')::uuid FROM image_jobs WHERE processing_state->>'editAssetId' IS NOT NULL
      UNION SELECT (processing_state->>'rawAssetId')::uuid FROM image_jobs WHERE processing_state->>'rawAssetId' IS NOT NULL
      UNION SELECT asset_id FROM data_exports WHERE asset_id IS NOT NULL
      UNION SELECT id FROM media_assets WHERE created_at>=now()-interval '24 hours'
    ), edges(a,b) AS (
      SELECT id,parent_asset_id FROM media_assets WHERE parent_asset_id IS NOT NULL
      UNION ALL SELECT parent_asset_id,id FROM media_assets WHERE parent_asset_id IS NOT NULL
    ), live(id) AS (SELECT id FROM seeds UNION SELECT edges.b FROM edges JOIN live ON live.id=edges.a)
    UPDATE media_assets SET status='deleting' WHERE status='ready' AND created_at<now()-interval '24 hours' AND id NOT IN (SELECT id FROM live)`);
  });
  const unused = await pool.query<{ id: string; storage_key: string }>("SELECT id,storage_key FROM media_assets WHERE status='deleting' AND kind<>'export'");
  await removeFiles(unused.rows.map(asset => asset.storage_key));
  await pool.query("DELETE FROM media_assets WHERE id=ANY($1::uuid[]) AND status='deleting'", [unused.rows.map(asset => asset.id)]);
  const files = await readdir(config.MEDIA_DIR, { recursive: true, withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const file of files) {
    if (!file.isFile() || !/^[0-9a-f-]{36}\.(png|jpe?g|webp|zip)(\.tmp)?$/.test(file.name)) continue;
    const name = relative(config.MEDIA_DIR, join(file.parentPath, file.name));
    if ((await stat(join(config.MEDIA_DIR, name))).mtimeMs >= Date.now() - 86400000) continue;
    const asset = await pool.query('SELECT id FROM media_assets WHERE storage_key=$1', [name]);
    if (!asset.rows.length) await removeFiles([name]);
  }
}
