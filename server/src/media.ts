import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, unlink, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { z } from 'zod';
import { idSchema } from '../../miniprogram/api/contracts.js';
import { config } from './config.js';
import { pool, transaction } from './db.js';
import { HttpError, notFound } from './errors.js';

export const uploadRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 1 } });
uploadRouter.post('/', upload.single('file'), async (req, res) => {
  const input = z.object({ purpose: z.enum(['clothing', 'body-photo', 'avatar']) }).strict().parse(req.body);
  if (!req.file) throw new HttpError(400, 'IMAGE_REQUIRED', '请选择图片');
  const image = sharp(req.file.buffer, { limitInputPixels: 24000000, failOn: 'error', animated: false });
  const files = await (async () => {
    try {
      const metadata = await image.metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) throw new HttpError(422, 'IMAGE_UNSUPPORTED', '仅支持单帧 JPEG、PNG 和 WebP 图片');
      const original = await image.rotate().toBuffer({ resolveWithObject: true });
      const thumbnail = await sharp(original.data).resize({ width: 480, height: 528, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
      return { original, thumbnail };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(422, 'IMAGE_UNSUPPORTED', '图片无法解码或超过 2400 万像素，请压缩或更换图片');
    }
  })();
  const id = randomUUID();
  const thumbnailId = randomUUID();
  const originalKey = `${input.purpose === 'avatar' ? 'avatars' : input.purpose === 'body-photo' ? 'body-photos' : 'originals'}/${id}.${files.original.info.format === 'jpeg' ? 'jpg' : files.original.info.format}`;
  const thumbnailKey = `thumbnails/${thumbnailId}.webp`;
  await Promise.all([originalKey, thumbnailKey].map(key => mkdir(dirname(join(config.MEDIA_DIR, key)), { recursive: true })));
  try {
    await writeFile(join(config.MEDIA_DIR, originalKey), files.original.data, { flag: 'wx' });
    await writeFile(join(config.MEDIA_DIR, thumbnailKey), files.thumbnail.data, { flag: 'wx' });
    await transaction(async client => {
      await client.query(`INSERT INTO media_assets(id,user_id,kind,storage_key,mime_type,width,height,byte_size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, res.locals.user.id, input.purpose === 'body-photo' ? 'body-photo' : 'original', originalKey, `image/${files.original.info.format}`, files.original.info.width, files.original.info.height, files.original.data.length]);
      await client.query(`INSERT INTO media_assets(id,user_id,kind,storage_key,mime_type,width,height,byte_size,parent_asset_id) VALUES($1,$2,'thumbnail',$3,'image/webp',$4,$5,$6,$7)`, [thumbnailId, res.locals.user.id, thumbnailKey, files.thumbnail.info.width, files.thumbnail.info.height, files.thumbnail.data.length, id]);
    });
  } catch (error) {
    await Promise.all([originalKey, thumbnailKey].map(key => unlink(join(config.MEDIA_DIR, key)).catch(cleanupError => {
      if (cleanupError.code !== 'ENOENT') console.error(JSON.stringify({ event: 'upload_cleanup_failed', assetId: id }));
    })));
    throw error;
  }
  res.status(201).json({ data: { assetId: id, thumbnailAssetId: thumbnailId, width: files.original.info.width, height: files.original.info.height, mimeType: `image/${files.original.info.format}` } });
});
function signature(userId: string, assetId: string, expires: number, variant: 'original' | 'preview') {
  return createHmac('sha256', config.MEDIA_SIGNING_KEY).update(`${userId}:${assetId}:${expires}${variant === 'preview' ? ':preview' : ''}`).digest('hex');
}
uploadRouter.post('/signed-urls', async (req, res) => {
  const input = z.object({ assetIds: z.array(idSchema).min(1).max(20), variant: z.enum(['original', 'thumbnail', 'preview']).default('original') }).strict().parse(req.body);
  const result = await pool.query<{ id: string; contentId: string; mime_type: string }>(`SELECT a.id,a.mime_type,CASE WHEN $3='thumbnail' THEN COALESCE((SELECT t.id FROM media_assets t WHERE t.user_id=a.user_id AND t.parent_asset_id=a.id AND t.kind='thumbnail' AND t.status='ready' ORDER BY t.id LIMIT 1),a.id) ELSE a.id END AS "contentId" FROM media_assets a WHERE a.user_id=$1 AND a.id=ANY($2::uuid[]) AND a.status='ready'
    AND (a.kind<>'export' OR EXISTS(SELECT 1 FROM data_exports e WHERE e.user_id=a.user_id AND e.asset_id=a.id AND e.expires_at>now()))`, [res.locals.user.id, [...new Set(input.assetIds)], input.variant]);
  if (result.rows.length !== new Set(input.assetIds).size) notFound();
  if (input.variant !== 'original' && result.rows.some(asset => !asset.mime_type.startsWith('image/'))) throw new HttpError(400, 'IMAGE_REQUIRED', '仅图片支持预览');
  const expires = Math.floor(Date.now() / 1000) + 60;
  res.json({ data: result.rows.map(asset => {
    const variant = input.variant === 'preview' || input.variant === 'thumbnail' && asset.contentId === asset.id ? 'preview' : 'original';
    return { assetId: asset.id, expiresAt: new Date(expires * 1000).toISOString(), url: `${config.PUBLIC_BASE_URL}/api/media/content/${asset.contentId}?userId=${res.locals.user.id}&expires=${expires}&variant=${variant}&signature=${signature(res.locals.user.id, asset.contentId, expires, variant)}` };
  }) });
});
export const contentRouter = Router();
contentRouter.get('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = z.object({ userId: idSchema, expires: z.coerce.number().int().positive(), variant: z.enum(['original', 'preview']).default('original'), signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.query);
  if (input.expires <= Math.floor(Date.now() / 1000) || !timingSafeEqual(Buffer.from(input.signature, 'hex'), Buffer.from(signature(input.userId, id, input.expires, input.variant), 'hex'))) throw new HttpError(403, 'MEDIA_URL_EXPIRED', '图片链接无效或已过期，请重新加载');
  const result = await pool.query<{ storage_key: string; mime_type: string; kind: string; preview_key: string | null }>(`SELECT a.storage_key,a.mime_type,a.kind,
    (SELECT p.storage_key FROM media_assets p WHERE p.parent_asset_id=a.id AND p.storage_key='previews/'||a.id::text||'.webp' AND p.status='ready') AS preview_key
    FROM media_assets a JOIN users u ON u.id=a.user_id
    WHERE a.id=$1 AND a.user_id=$2 AND a.status='ready' AND u.status='active'
    AND (a.kind<>'export' OR EXISTS(SELECT 1 FROM data_exports e WHERE e.user_id=a.user_id AND e.asset_id=a.id AND e.expires_at>now()))`, [id, input.userId]);
  if (!result.rows.length) notFound();
  if (input.variant === 'preview' && !result.rows[0].mime_type.startsWith('image/')) throw new HttpError(400, 'IMAGE_REQUIRED', '仅图片支持预览');
  if (input.variant === 'preview' && result.rows[0].mime_type !== 'image/webp') {
    const key = result.rows[0].preview_key || await transaction(async client => {
      const locked = await client.query("SELECT id FROM media_assets WHERE id=$1 AND status='ready' FOR UPDATE", [id]);
      if (!locked.rows.length) notFound();
      const key = `previews/${id}.webp`;
      const cached = await client.query('SELECT id FROM media_assets WHERE storage_key=$1', [key]);
      if (cached.rows.length) return key;
      const preview = await sharp(join(config.MEDIA_DIR, result.rows[0].storage_key)).rotate().webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
      await mkdir(join(config.MEDIA_DIR, 'previews'), { recursive: true });
      await writeFile(join(config.MEDIA_DIR, `${key}.tmp`), preview.data);
      await rename(join(config.MEDIA_DIR, `${key}.tmp`), join(config.MEDIA_DIR, key));
      await client.query("INSERT INTO media_assets(id,user_id,kind,storage_key,mime_type,width,height,byte_size,parent_asset_id) VALUES($1,$2,'generated',$3,'image/webp',$4,$5,$6,$7)", [randomUUID(), input.userId, key, preview.info.width, preview.info.height, preview.data.length, id]);
      return key;
    });
    res.set('Cache-Control', `private, max-age=${Math.max(0, input.expires - Math.floor(Date.now() / 1000))}`);
    res.type('image/webp');
    res.sendFile(join(config.MEDIA_DIR, key), { dotfiles: 'allow' });
    return;
  }
  res.set('Cache-Control', input.variant === 'preview' || result.rows[0].kind === 'thumbnail' ? `private, max-age=${Math.max(0, input.expires - Math.floor(Date.now() / 1000))}` : 'private, max-age=0, no-store');
  res.type(result.rows[0].mime_type);
  if (result.rows[0].kind === 'export') res.attachment('wardrobe-export.zip');
  res.sendFile(join(config.MEDIA_DIR, result.rows[0].storage_key), { dotfiles: 'allow' });
});
