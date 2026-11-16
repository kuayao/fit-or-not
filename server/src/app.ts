import { randomUUID } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import multer from 'multer';
import pg from 'pg';
import { ZodError } from 'zod';
import { authenticate, authRouter } from './auth.js';
import { contentRouter, uploadRouter } from './media.js';
import { clothingSetsRouter } from './clothing-sets.js';
import { clothingImportsRouter } from './clothing-imports.js';
import { clothesRouter } from './clothes.js';
import { outfitsRouter, outfitCategoriesRouter } from './outfits.js';
import { wearRouter } from './wear.js';
import { packingRouter } from './packing.js';
import { jobsRouter } from './jobs.js';
import { accountRouter } from './account.js';
import { servicesRouter } from './services.js';
import { recommendationsRouter } from './recommendations.js';
import { HttpError } from './errors.js';
import { pool } from './db.js';
import { config } from './config.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.TRUST_PROXY);
app.use((_req, res, next) => { res.locals.requestId = randomUUID(); res.set('X-Request-Id', res.locals.requestId); next(); });
app.use(express.json({ limit: '256kb' }));
app.use((req, _res, next) => {
  if (req.get('X-HTTP-Method-Override') !== undefined) {
    if (req.method !== 'POST' || req.get('X-HTTP-Method-Override') !== 'PATCH') throw new HttpError(400, 'INVALID_METHOD_OVERRIDE', '不支持的请求方法');
    req.method = 'PATCH';
  }
  next();
});
app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ data: { status: 'ready' } });
});
app.use('/api/auth', authRouter);
app.use('/api/media/content', contentRouter);
app.use('/api', authenticate);
app.use('/api/media', uploadRouter);
app.use('/api/clothes', clothesRouter);
app.use('/api/clothing-sets', clothingSetsRouter);
app.use('/api/clothing-imports', clothingImportsRouter);
app.use('/api/outfits', outfitsRouter);
app.use('/api/outfit-categories', outfitCategoriesRouter);
app.use('/api/wear-records', wearRouter);
app.use('/api/packing-lists', packingRouter);
app.use('/api/image-jobs', jobsRouter);
app.use('/api', accountRouter);
app.use('/api', servicesRouter);
app.use('/api/recommendations', recommendationsRouter);
app.use((_req, _res, next) => next(new HttpError(404, 'RESOURCE_NOT_FOUND', '接口不存在')));
const handleError: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  if (res.headersSent) { res.end(); return; }
  if (error instanceof ZodError) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: '输入不符合要求，请检查字段', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) } });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
    return;
  }
  if (error instanceof multer.MulterError) {
    res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: { code: 'IMAGE_TOO_LARGE', message: '请上传一张不超过 10 MB 的图片' } });
    return;
  }
  if (error instanceof pg.DatabaseError && error.code === '23505') {
    res.status(409).json({ error: { code: 'NAME_CONFLICT', message: '名称已存在或请求与已有记录冲突' } });
    return;
  }
  if (error instanceof pg.DatabaseError && error.code === '23503') {
    res.status(409).json({ error: { code: 'RESOURCE_REFERENCED', message: '资源不存在或仍被引用，请先处理关联内容' } });
    return;
  }
  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: '请求内容不是有效 JSON' } });
    return;
  }
  console.error(JSON.stringify({ event: 'request_failed', requestId: res.locals.requestId, method: req.method, path: req.path, errorType: error instanceof Error ? error.name : 'UnknownError', databaseCode: error instanceof pg.DatabaseError ? error.code : undefined }));
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时无法处理，请稍后重试' } });
};
app.use(handleError);
