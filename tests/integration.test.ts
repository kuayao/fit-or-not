import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import pg from 'pg';
import express from 'express';
import sharp from 'sharp';
import { z } from 'zod';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { clothingSchema, clothingOptionSchema, outfitSchema, outfitCategorySchema, packingSchema, wearSchema, statisticsSchema, clothingStatisticsSchema, mediaSchema, signedUrlSchema, jobSchema, categorySchema, tagSchema, exportSchema, loginSchema, userSchema, recognitionSchema } from '../miniprogram/api/contracts.js';
import type { Recognition } from '../miniprogram/api/contracts.js';

assert.equal(process.env.DB_HOST, '127.0.0.1', '集成测试只能使用本地独立 PG');
assert.equal(process.env.DB_PORT, '55436', '集成测试只能使用本项目测试容器端口');
const databaseName = `fit_or_not_test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD
});
await admin.query(`CREATE DATABASE "${databaseName}"`);
process.env.DB_NAME = databaseName;
process.env.NODE_ENV = 'test';
process.env.MEMBER_LIMIT = '3';
const testMedia = await mkdtemp(join(tmpdir(), 'fit-or-not-media-'));
process.env.MEDIA_DIR = testMedia;
const { pool } = await import('../server/src/db.js');
const { migrate } = await import('../server/src/migrate.js');
const { app } = await import('../server/src/app.js');
const { processNextImageJob, processNextExport, maintenance } = await import('../server/src/background.js');
const { config } = await import('../server/src/config.js');
await migrate();
const server = express().use('/ootd', app).listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}/ootd/api`;
config.PUBLIC_BASE_URL = base.slice(0, -4);
const tokenA = randomBytes(32).toString('base64url');
const tokenB = randomBytes(32).toString('base64url');
const users: string[] = [];
before(async () => {
  for (const [index, token] of [tokenA, tokenB].entries()) {
    const result = await pool.query<{ id: string }>('INSERT INTO users(wechat_openid,nickname) VALUES($1,$2) RETURNING id', [`test-${index}-${randomUUID()}`, `测试用户${index}`]);
    users.push(result.rows[0].id);
    await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [result.rows[0].id, createHash('sha256').update(token).digest('hex')]);
  }
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await pool.end();
  await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
  await rm(testMedia, { recursive: true });
});
async function request(method: string, path: string, body?: unknown, token = tokenA, key?: string) {
  return fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function data<T>(response: Response, schema: z.ZodType<T>, status = 200) {
  const payload: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(payload));
  return z.object({ data: schema }).parse(payload).data;
}
test('真实 PG/HTTP：昵称、头像保存、重新读取与归属隔离', async () => {
  const user = await data(await request('GET', '/me'), userSchema);
  const png = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#426e91' } }).png().toBuffer();
  const form = new FormData();
  form.set('purpose', 'avatar');
  form.set('file', new Blob([png], { type: 'image/png' }), 'avatar.png');
  const avatar = await data(await fetch(`${base}/media`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: form }), mediaSchema, 201);
  assert.equal((await pool.query<{ storage_key: string }>('SELECT storage_key FROM media_assets WHERE id=$1', [avatar.assetId])).rows[0].storage_key, `avatars/${avatar.assetId}.png`);
  const updated = await data(await request('PATCH', '/me', { version: user.version, nickname: '  衣橱主人  ', avatarAssetId: avatar.assetId }), userSchema);
  assert.equal(updated.nickname, '衣橱主人');
  assert.equal(updated.avatarAssetId, avatar.assetId);
  assert.equal(updated.version, user.version + 1);
  assert.deepEqual(await data(await request('GET', '/me'), userSchema), updated);
  const signed = await data(await request('POST', '/media/signed-urls', { assetIds: [avatar.assetId] }), z.array(signedUrlSchema));
  const mediaUrl = new URL(signed[0].url);
  assert.equal(mediaUrl.pathname, `/ootd/api/media/content/${avatar.assetId}`);
  assert.equal((await fetch(mediaUrl)).status, 200);
  assert.equal((await request('PATCH', '/me', { version: user.version, nickname: '旧版本' })).status, 409);
  const other = await data(await request('GET', '/me', undefined, tokenB), userSchema);
  assert.equal((await request('PATCH', '/me', { version: other.version, avatarAssetId: avatar.assetId }, tokenB)).status, 404);
  assert.deepEqual(await data(await request('GET', '/me', undefined, tokenB), userSchema), other);
  form.set('purpose', 'body-photo');
  const bodyPhoto = await data(await fetch(`${base}/media`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: form }), mediaSchema, 201);
  assert.equal((await pool.query<{ storage_key: string }>('SELECT storage_key FROM media_assets WHERE id=$1', [bodyPhoto.assetId])).rows[0].storage_key, `body-photos/${bodyPhoto.assetId}.png`);
});
test('真实 PG/HTTP：WebP 预览保留尺寸和透明度、并发复用、签名隔离及清理', async () => {
  const png = await sharp({ create: { width: 720, height: 960, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 300, height: 500, channels: 4, background: '#426e91' } }).png().toBuffer(), left: 210, top: 230 }]).png().toBuffer();
  const form = new FormData();
  form.set('purpose', 'clothing');
  form.set('file', new Blob([png], { type: 'image/png' }), 'transparent.png');
  const asset = await data(await fetch(`${base}/media`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: form }), mediaSchema, 201);
  const signed = await data(await request('POST', '/media/signed-urls', { assetIds: [asset.assetId], variant: 'preview' }), z.array(signedUrlSchema));
  assert.equal((await pool.query('SELECT id FROM media_assets WHERE parent_asset_id=$1 AND kind=\'generated\'', [asset.assetId])).rows.length, 0);
  const previews = await Promise.all(Array.from({ length: 4 }, () => fetch(signed[0].url)));
  for (const response of previews) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.match(response.headers.get('cache-control')!, /^private, max-age=\d+$/);
    const image = await sharp(Buffer.from(await response.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
    assert.equal(image.info.width, 720);
    assert.equal(image.info.height, 960);
    assert.equal(image.info.channels, 4);
    assert.equal(image.data[3], 0);
    assert.equal(image.data[(480 * 720 + 360) * 4 + 3], 255);
  }
  const generated = await pool.query<{ id: string; storage_key: string }>("SELECT id,storage_key FROM media_assets WHERE parent_asset_id=$1 AND kind='generated'", [asset.assetId]);
  assert.equal(generated.rows.length, 1);
  const file = join(config.MEDIA_DIR, generated.rows[0].storage_key);
  const modified = (await stat(file)).mtimeMs;
  assert.equal((await fetch(signed[0].url)).status, 200);
  assert.equal((await stat(file)).mtimeMs, modified);
  const original = await data(await request('POST', '/media/signed-urls', { assetIds: [asset.assetId], variant: 'original' }), z.array(signedUrlSchema));
  const originalResponse = await fetch(original[0].url);
  assert.equal(originalResponse.headers.get('content-type'), 'image/png');
  assert.match(originalResponse.headers.get('cache-control')!, /no-store/);
  assert.deepEqual(Buffer.from(await originalResponse.arrayBuffer()), await readFile(join(config.MEDIA_DIR, `originals/${asset.assetId}.png`)));
  const webp = await data(await request('POST', '/media/signed-urls', { assetIds: [asset.thumbnailAssetId], variant: 'preview' }), z.array(signedUrlSchema));
  assert.deepEqual(Buffer.from(await (await fetch(webp[0].url)).arrayBuffer()), await readFile(join(config.MEDIA_DIR, `thumbnails/${asset.thumbnailAssetId}.webp`)));
  await pool.query('DELETE FROM media_assets WHERE id=$1', [asset.thumbnailAssetId]);
  const fallback = await data(await request('POST', '/media/signed-urls', { assetIds: [asset.assetId], variant: 'thumbnail' }), z.array(signedUrlSchema));
  assert.equal(new URL(fallback[0].url).searchParams.get('variant'), 'preview');
  assert.equal((await fetch(fallback[0].url)).headers.get('content-type'), 'image/webp');
  assert.equal((await stat(file)).mtimeMs, modified);
  const tampered = new URL(signed[0].url);
  tampered.searchParams.set('variant', 'original');
  assert.equal((await fetch(tampered)).status, 403);
  tampered.searchParams.set('variant', 'preview');
  tampered.searchParams.set('userId', users[1]);
  assert.equal((await fetch(tampered)).status, 403);
  assert.equal((await request('POST', '/media/signed-urls', { assetIds: [asset.assetId], variant: 'preview' }, tokenB)).status, 404);
  const expired = new URL(signed[0].url);
  expired.searchParams.set('expires', '1');
  assert.equal((await fetch(expired)).status, 403);
  const clothing = await data(await request('POST', '/clothes', { primaryAssetId: asset.assetId, status: 'draft' }), clothingSchema, 201);
  await pool.query("UPDATE media_assets SET created_at=now()-interval '25 hours' WHERE id=$1 OR parent_asset_id=$1", [asset.assetId]);
  await maintenance();
  assert(existsSync(file));
  await request('DELETE', `/clothes/${clothing.id}`);
  await maintenance();
  assert.equal(existsSync(file), false);
  assert.equal((await pool.query('SELECT id FROM media_assets WHERE id=$1 OR parent_asset_id=$1', [asset.assetId])).rows.length, 0);
});

test('图片任务迁移：旧识别结果补齐分类字段，列表和详情符合客户端契约', async t => {
  const root = await data(await request('POST', '/categories', { name: '历史任务分类' }), categorySchema, 201);
  const child = await data(await request('POST', '/categories', { name: '历史任务子分类', parentId: root.id }), categorySchema, 201);
  const foreign = await data(await request('POST', '/categories', { name: '历史任务他人分类' }, tokenB), categorySchema, 201);
  const asset = await pool.query<{ id: string }>("INSERT INTO media_assets(user_id,kind,storage_key,mime_type,width,height,byte_size) VALUES($1,'original',$2,'image/png',1,1,1) RETURNING id", [users[0], randomUUID()]);
  const ids: string[] = [];
  t.after(async () => {
    await pool.query('DELETE FROM image_jobs WHERE id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM media_assets WHERE id=$1', [asset.rows[0].id]);
    await pool.query('DELETE FROM categories WHERE id=ANY($1::uuid[])', [[child.id, root.id, foreign.id]]);
  });
  const legacy = {
    name: '历史衣物', categoryId: root.id, itemType: '上衣', colorDescription: '白色', pattern: 'solid',
    visibleFeatures: [], colors: ['white'], seasons: ['summer'], styleTagIds: [], occasionTagIds: [],
    inputIssues: [], cutoutReadiness: 'ready'
  };
  const results = [
    { suggestions: legacy },
    { suggestions: { ...legacy, categoryId: child.id } },
    { suggestions: { ...legacy, categoryId: null } },
    { suggestions: { ...legacy, categoryId: randomUUID() } },
    { suggestions: { ...legacy, categoryId: foreign.id } },
    { suggestions: { ...legacy, rootCategoryId: null } },
    { suggestions: { ...legacy, subcategoryName: '已有建议' } },
    { suggestions: { ...legacy, rootCategoryId: root.id, subcategoryName: '新任务建议' } },
    null,
    { modelRevision: 'sharp-0.35.5' }
  ];
  for (const result of results) {
    const job = await pool.query<{ id: string }>("INSERT INTO image_jobs(user_id,input_asset_id,kind,status,result) VALUES($1,$2,'process','succeeded',$3) RETURNING id", [users[0], asset.rows[0].id, JSON.stringify(result)]);
    ids.push(job.rows[0].id);
  }
  const before = await request('GET', `/image-jobs/${ids[0]}`);
  assert.equal(jobSchema.safeParse(z.object({ data: z.unknown() }).parse(await before.json()).data).success, false);
  const migration = await readFile('server/migrations/V7__image_job_recognition_fields.sql', 'utf8');
  assert.equal((await pool.query(migration)).rowCount, 7);
  for (const [index, id] of ids.entries()) {
    const migrated = await data(await request('GET', `/image-jobs/${id}`), jobSchema);
    const original = results[index];
    assert.deepEqual(migrated.result, original && 'suggestions' in original ? {
      ...original, suggestions: { rootCategoryId: index === 0 || index === 1 || index === 6 ? root.id : null, subcategoryName: null, ...original.suggestions }
    } : original);
  }
  const listed = await data(await request('GET', '/image-jobs?pageSize=50'), z.array(jobSchema));
  assert(ids.every(id => listed.some(job => job.id === id)));
  assert.equal((await pool.query(migration)).rowCount, 0);
});
test('AI 分类核对：识别协议、复用、新增确认、归属与事务回滚', async t => {
  const top = await data(await request('POST', '/categories', { name: 'AI 上衣' }), categorySchema, 201);
  const coat = await data(await request('POST', '/categories', { name: 'AI 外套' }), categorySchema, 201);
  const tshirt = await data(await request('POST', '/categories', { name: 'T恤', parentId: top.id }), categorySchema, 201);
  const foreign = await data(await request('POST', '/categories', { name: '他人的分类' }, tokenB), categorySchema, 201);
  const form = new FormData();
  form.set('purpose', 'clothing');
  form.set('file', new Blob([await sharp({ create: { width: 48, height: 48, channels: 3, background: '#fff' } }).png().toBuffer()]), 'classification.png');
  const asset = await data(await fetch(`${base}/media`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: form }), mediaSchema, 201);
  const output = { value: recognitionSchema.parse({ name: '白色短袖', rootCategoryId: top.id, categoryId: tshirt.id, subcategoryName: '圆领短袖', itemType: 'T恤', colorDescription: '白色', pattern: 'solid', visibleFeatures: ['圆领', '短袖'], colors: ['white'], seasons: ['summer'], styleTagIds: [], occasionTagIds: [], inputIssues: [], cutoutReadiness: 'ready' }) };
  const provider = express().use(express.json({ limit: '2mb' })).post('/chat/completions', (req, res) => {
    const body = z.object({ messages: z.tuple([z.object({ content: z.string() }), z.object({ content: z.tuple([z.object({ text: z.string() }), z.unknown()]) })]) }).parse(req.body);
    const context = z.object({ allowedCategories: z.array(z.object({ id: z.string(), parentId: z.string().nullable() })) }).parse(JSON.parse(body.messages[1].content[0].text));
    assert(body.messages[0].content.includes('语义匹配'));
    assert(context.allowedCategories.some(item => item.id === tshirt.id && item.parentId === top.id));
    assert(!context.allowedCategories.some(item => item.id === foreign.id));
    res.json({ choices: [{ message: { content: JSON.stringify(output.value) } }] });
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  assert(address && typeof address !== 'string');
  const previous = { url: config.NEW_API_BASE_URL, key: config.NEW_API_KEY };
  config.NEW_API_BASE_URL = `http://127.0.0.1:${address.port}`;
  config.NEW_API_KEY = 'local-protocol-fixture';
  t.after(async () => {
    config.NEW_API_BASE_URL = previous.url;
    config.NEW_API_KEY = previous.key;
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    await pool.query('DELETE FROM image_jobs WHERE input_asset_id=$1', [asset.assetId]);
    await pool.query('DELETE FROM clothes WHERE primary_asset_id=$1', [asset.assetId]);
    await pool.query('DELETE FROM categories WHERE id=ANY($1::uuid[]) OR parent_id=ANY($1::uuid[])', [[top.id, coat.id, foreign.id]]);
    await pool.query('DELETE FROM media_assets WHERE id=ANY($1::uuid[])', [[asset.assetId, asset.thumbnailAssetId]]);
  });
  async function recognize(classification: Pick<Recognition, 'rootCategoryId' | 'categoryId' | 'subcategoryName'>) {
    output.value = { ...output.value, ...classification };
    const clothing = await data(await request('POST', '/clothes', { primaryAssetId: asset.assetId, status: 'draft' }), clothingSchema, 201);
    const job = await data(await request('POST', '/image-jobs', { inputAssetId: asset.assetId, clothingId: clothing.id, kind: 'classify' }, tokenA, randomUUID()), jobSchema, 202);
    assert.equal(await processNextImageJob(), true);
    return { clothing: await data(await request('GET', `/clothes/${clothing.id}`), clothingSchema), job: await data(await request('GET', `/image-jobs/${job.id}`), jobSchema) };
  }
  const matched = await recognize({ rootCategoryId: top.id, categoryId: tshirt.id, subcategoryName: '圆领短袖' });
  assert.equal(matched.job.status, 'succeeded');
  assert.equal(matched.clothing.categoryId, tshirt.id);
  assert.equal(matched.job.result?.suggestions?.subcategoryName, '圆领短袖');
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM categories WHERE user_id=$1 AND name='圆领短袖'", [users[0]])).rows[0].count, 0);

  const rootOnly = await recognize({ rootCategoryId: top.id, categoryId: top.id, subcategoryName: top.name });
  assert.equal(rootOnly.job.status, 'succeeded');
  assert.equal(rootOnly.job.result?.steps?.recognition.status, 'succeeded');
  assert.deepEqual(rootOnly.job.result?.suggestions, { ...output.value, subcategoryName: null });
  assert.equal(rootOnly.clothing.categoryId, top.id);
  assert.equal(rootOnly.clothing.name, output.value.name);
  assert.deepEqual(rootOnly.clothing.colors, output.value.colors);

  const proposed = await recognize({ rootCategoryId: top.id, categoryId: top.id, subcategoryName: '针织开衫' });
  assert.equal(proposed.clothing.categoryId, top.id);
  assert.equal(proposed.job.result?.suggestions?.subcategoryName, '针织开衫');
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM categories WHERE user_id=$1 AND name='针织开衫'", [users[0]])).rows[0].count, 0, '识别完成不自动创建二级分类');
  const accepted = await data(await request('PATCH', `/clothes/${proposed.clothing.id}`, { version: proposed.clothing.version, status: 'active', categoryId: top.id, newSubcategory: { parentId: top.id, name: ' 针织开衫 ' } }), clothingSchema);
  assert.equal(accepted.categoryName, 'AI 上衣 / 针织开衫');
  assert.equal((await data(await request('GET', `/image-jobs/${proposed.job.id}`), jobSchema)).result?.subcategoryReviewed, true);

  const skipped = await recognize({ rootCategoryId: top.id, categoryId: top.id, subcategoryName: '背心' });
  const declined = await data(await request('PATCH', `/clothes/${skipped.clothing.id}`, { version: skipped.clothing.version, categoryId: top.id, status: 'active' }), clothingSchema);
  assert.equal(declined.categoryId, top.id);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM categories WHERE user_id=$1 AND name='背心'", [users[0]])).rows[0].count, 0);
  assert.equal((await data(await request('GET', `/image-jobs/${skipped.job.id}`), jobSchema)).result?.subcategoryReviewed, true);

  const rollback = await recognize({ rootCategoryId: top.id, categoryId: top.id, subcategoryName: '回滚品类' });
  const patch = { version: rollback.clothing.version, categoryId: top.id, status: 'active', newSubcategory: { parentId: top.id, name: '回滚品类' } };
  assert.equal((await request('PATCH', `/clothes/${rollback.clothing.id}`, { ...patch, tagIds: [randomUUID()] })).status, 404);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM categories WHERE user_id=$1 AND name='回滚品类'", [users[0]])).rows[0].count, 0);
  assert.equal((await data(await request('GET', `/clothes/${rollback.clothing.id}`), clothingSchema)).version, rollback.clothing.version);
  assert.notEqual((await data(await request('GET', `/image-jobs/${rollback.job.id}`), jobSchema)).result?.subcategoryReviewed, true);
  assert.equal((await request('PATCH', `/clothes/${rollback.clothing.id}`, patch, tokenB)).status, 404);
  assert.equal((await request('PATCH', `/clothes/${rollback.clothing.id}`, { ...patch, categoryId: foreign.id, newSubcategory: { parentId: foreign.id, name: '越权品类' } })).status, 422);
  assert.equal((await request('PATCH', `/clothes/${rollback.clothing.id}`, { ...patch, newSubcategory: { parentId: tshirt.id, name: '三级品类' } })).status, 422);
  assert.equal((await request('PATCH', `/clothes/${rollback.clothing.id}`, { ...patch, newSubcategory: { parentId: coat.id, name: '错误归属' } })).status, 422);
  assert.equal((await request('PATCH', `/clothes/${rollback.clothing.id}`, { ...patch, newSubcategory: { parentId: top.id, name: 'AI 外套' } })).status, 409);
  const exactReuse = await data(await request('PATCH', `/clothes/${rollback.clothing.id}`, { ...patch, newSubcategory: { parentId: top.id, name: '针织开衫' } }), clothingSchema);
  assert.equal(exactReuse.categoryId, accepted.categoryId);
  assert.equal((await request('PATCH', `/clothes/${rollback.clothing.id}`, patch)).status, 409, '重复提交不会创建额外分类');

  const concurrent = await Promise.all([0, 1].map(async () => data(await request('POST', '/clothes', { primaryAssetId: asset.assetId, status: 'draft' }), clothingSchema, 201)));
  const saved = await Promise.all(concurrent.map(async clothing => data(await request('PATCH', `/clothes/${clothing.id}`, { version: clothing.version, categoryId: top.id, status: 'active', newSubcategory: { parentId: top.id, name: '并发品类' } }), clothingSchema)));
  assert.equal(saved[0].categoryId, saved[1].categoryId);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM categories WHERE user_id=$1 AND name='并发品类'", [users[0]])).rows[0].count, 1);

  const uncertain = await recognize({ rootCategoryId: null, categoryId: null, subcategoryName: null });
  assert.equal(uncertain.job.status, 'succeeded');
  assert.equal(uncertain.clothing.categoryId, null);
  for (const classification of [{ rootCategoryId: coat.id, categoryId: tshirt.id, subcategoryName: 'T恤' }, { rootCategoryId: foreign.id, categoryId: foreign.id, subcategoryName: '他人品类' }, { rootCategoryId: top.id, categoryId: top.id, subcategoryName: 'AI 外套' }]) {
    const invalid = await recognize(classification);
    assert.equal(invalid.job.result?.steps?.recognition.errorCode, 'INVALID_MODEL_RESPONSE');
    assert.equal(invalid.clothing.categoryId, null);
  }
  await pool.query("INSERT INTO categories(user_id,name,parent_id) SELECT $1,'AI 限额 '||i,$2 FROM generate_series(1,100-(SELECT count(*)::int FROM categories WHERE user_id=$1)) AS i", [users[0], top.id]);
  assert.equal((await request('PATCH', `/clothes/${exactReuse.id}`, { version: exactReuse.version, categoryId: top.id, newSubcategory: { parentId: top.id, name: '超额品类' } })).status, 422);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM categories WHERE user_id=$1 AND name='超额品类'", [users[0]])).rows[0].count, 0);
  assert.equal((await data(await request('PATCH', `/clothes/${exactReuse.id}`, { version: exactReuse.version, categoryId: top.id, newSubcategory: { parentId: top.id, name: '针织开衫' } }), clothingSchema)).categoryId, accepted.categoryId, '数量已满时仍可复用已有分类');
});
test('真实 PG/HTTP：衣物、搭配、日历、统计、清单、私有图片和隔离', async t => {
  assert.equal((await fetch(`${base}/clothes`)).status, 401);
  const category = await data(await request('POST', '/categories', { name: '上装' }), categorySchema, 201);
  const png = await sharp({ create: { width: 120, height: 160, channels: 3, background: '#426e91' } }).png().toBuffer();
  const form = new FormData();
  form.set('purpose', 'clothing');
  form.set('file', new Blob([png], { type: 'image/png' }), '../../photo.png');
  const asset = await data(await fetch(`${base}/media`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: form }), mediaSchema, 201);
  assert.equal((await pool.query<{ storage_key: string }>('SELECT storage_key FROM media_assets WHERE id=$1', [asset.assetId])).rows[0].storage_key, `originals/${asset.assetId}.png`);
  assert.equal((await pool.query<{ storage_key: string }>('SELECT storage_key FROM media_assets WHERE id=$1', [asset.thumbnailAssetId])).rows[0].storage_key, `thumbnails/${asset.thumbnailAssetId}.webp`);
  const draft = await data(await request('POST', '/clothes', { primaryAssetId: asset.assetId, status: 'draft' }), clothingSchema, 201);
  assert.equal(draft.name, '');
  const confirmed = await data(await request('PATCH', `/clothes/${draft.id}`, { version: draft.version, status: 'active', categoryId: category.id }), clothingSchema);
  assert.equal(confirmed.name, category.name);
  assert.equal((await request('DELETE', `/clothes/${draft.id}`)).status, 204);
  const input = { primaryAssetId: asset.assetId, categoryId: category.id, name: '测试衬衫', priceCents: '29900', colors: ['blue'] };
  const clothing = await data(await request('POST', '/clothes', input), clothingSchema, 201);
  const free = await data(await request('POST', '/clothes', { ...input, name: '零元衬衫', priceCents: '0' }), clothingSchema, 201);
  await data(await request('POST', '/clothes', { ...input, name: '无价格衬衫', priceCents: null }), clothingSchema, 201);
  assert.equal((await request('GET', `/clothes/${clothing.id}`, undefined, tokenB)).status, 404);
  assert.equal((await request('POST', '/clothes', input, tokenB)).status, 404);
  const updated = await data(await request('PATCH', `/clothes/${clothing.id}`, { version: clothing.version, favorite: true }), clothingSchema);
  assert.equal(updated.version, 2);
  const category2 = await data(await request('POST', '/categories', { name: '测试分类' }), categorySchema, 201);
  assert.equal((await request('POST', '/categories/reorder', { items: [{ id: category2.id, version: 99 }, { id: category.id, version: category.version }] })).status, 409);
  assert.equal((await request('POST', '/categories/reorder', { items: [{ id: category2.id, version: category2.version }, { id: category.id, version: category.version }] })).status, 204);
  const ordered = await data(await request('GET', '/categories'), z.array(categorySchema));
  assert.deepEqual(ordered.map(item => item.id), [category2.id, category.id]);
  const batch = [updated, free].sort((a, b) => a.id.localeCompare(b.id));
  assert.equal((await request('POST', '/clothes/batch', { action: 'archive', items: batch.map((item, index) => ({ id: item.id, version: index === 1 ? 999 : item.version })) })).status, 409);
  assert.equal((await data(await request('GET', `/clothes/${batch[0].id}`), clothingSchema)).status, 'active');
  assert.equal((await data(await request('GET', `/clothes/${batch[0].id}`), clothingSchema)).version, batch[0].version);
  assert.equal((await request('PATCH', `/clothes/${clothing.id}`, { version: 1, name: '覆盖' })).status, 409);
  const list = await data(await request('GET', '/clothes?favorite=true&colors=blue'), z.array(clothingSchema));
  assert.deepEqual(list.map(item => item.id), [clothing.id]);
  assert.equal((await request('GET', '/clothes?pageSize=1000')).status, 400);
  await t.test('搭配独立分类：新增、归属、组合筛选、分页与修改回滚', async () => {
    const travel = await data(await request('POST', '/outfit-categories', { name: '  旅行  ' }), outfitCategorySchema, 201);
    assert.equal(travel.name, '旅行');
    assert.equal((await request('POST', '/outfit-categories', { name: '旅行' })).status, 409);
    assert.equal((await request('POST', '/outfit-categories', { name: ' ' })).status, 400);
    assert.equal((await request('POST', '/outfit-categories', { name: '超'.repeat(13) })).status, 400);
    assert.equal((await request('POST', '/outfit-categories', { name: '冒用', userId: users[1] })).status, 400);
    const separate = await data(await request('POST', '/outfit-categories', { name: '上装' }), outfitCategorySchema, 201);
    assert.notEqual(separate.id, category.id);
    const foreign = await data(await request('POST', '/outfit-categories', { name: '旅行' }, tokenB), outfitCategorySchema, 201);
    assert.deepEqual((await data(await request('GET', '/outfit-categories'), z.array(outfitCategorySchema))).map(item => item.id), [travel.id, separate.id]);
    assert.deepEqual((await data(await request('GET', '/outfit-categories', undefined, tokenB), z.array(outfitCategorySchema))).map(item => item.id), [foreign.id]);
    const input = { name: '分类测试', categoryId: travel.id, occasion: '原有场景', items: [{ clothingId: clothing.id, x: 0.2, y: 0.2, width: 0.3, height: 0.3, rotation: 0, zIndex: 0 }] };
    assert.equal((await request('POST', '/outfits', { ...input, categoryId: foreign.id })).status, 404);
    assert.equal((await request('POST', '/outfits', { ...input, categoryId: category.id })).status, 404);
    const created = [];
    for (const favorite of [true, false, true]) created.push(await data(await request('POST', '/outfits', { ...input, favorite }), outfitSchema, 201));
    assert.equal(created[0].categoryName, '旅行');
    assert.deepEqual(created[0].previewAssets, [{ clothingId: clothing.id, assetId: clothing.primaryAssetId }]);
    const first = z.object({ data: z.array(outfitSchema), pagination: z.object({ total: z.number() }) }).parse(await (await request('GET', `/outfits?categoryId=${travel.id}&pageSize=2`)).json());
    const second = await data(await request('GET', `/outfits?categoryId=${travel.id}&pageSize=2&page=2`), z.array(outfitSchema));
    assert.equal(first.pagination.total, 3);
    assert.equal(first.data.length, 2);
    assert.equal(second.length, 1);
    assert.equal(new Set([...first.data, ...second].map(item => item.id)).size, 3);
    assert.equal((await data(await request('GET', `/outfits?categoryId=${travel.id}&favorite=true&occasion=${encodeURIComponent('原有场景')}&q=${encodeURIComponent('分类')}`), z.array(outfitSchema))).length, 2);
    assert.equal((await data(await request('GET', `/outfits?categoryId=${foreign.id}`), z.array(outfitSchema))).length, 0);
    assert.equal((await request('GET', '/outfits?categoryId=invalid')).status, 400);
    assert.equal((await request('PATCH', `/outfits/${created[0].id}`, { version: created[0].version, categoryId: foreign.id, name: '不得写入' })).status, 404);
    assert.deepEqual(await data(await request('GET', `/outfits/${created[0].id}`), outfitSchema), created[0]);
    await assert.rejects(pool.query('UPDATE outfits SET category_id=$1 WHERE id=$2', [foreign.id, created[0].id]), (error: unknown) => error instanceof pg.DatabaseError && error.code === '23503');
    const changed = await data(await request('PATCH', `/outfits/${created[0].id}`, { version: created[0].version, categoryId: separate.id }), outfitSchema);
    assert.equal(changed.categoryName, '上装');
    assert.equal(changed.occasion, '原有场景');
    assert.deepEqual(changed.items, created[0].items);
    assert.equal((await request('PATCH', `/outfits/${changed.id}`, { version: created[0].version, categoryId: null })).status, 409);
    const unset = await data(await request('PATCH', `/outfits/${changed.id}`, { version: changed.version, categoryId: null }), outfitSchema);
    assert.equal(unset.categoryId, null); assert.equal(unset.categoryName, null);
    assert.equal((await request('PATCH', `/outfits/${changed.id}`, { version: unset.version, categoryId: foreign.id }, tokenB)).status, 404);
    for (const item of created) assert.equal((await request('DELETE', `/outfits/${item.id}`)).status, 204);
  });
  const outfit = await data(await request('POST', '/outfits', { name: '通勤', items: [{ clothingId: clothing.id, x: 0.2, y: 0.2, width: 0.3, height: 0.3, rotation: 0, zIndex: 0 }] }), outfitSchema, 201);
  assert.equal(await processNextImageJob(), true);
  const rendered = await data(await request('GET', `/outfits/${outfit.id}`), outfitSchema);
  assert(rendered.coverAssetId);
  const cover = await pool.query<{ storage_key: string }>('SELECT storage_key FROM media_assets WHERE id=$1', [rendered.coverAssetId]);
  assert.equal(cover.rows[0].storage_key, `outfit-covers/${rendered.coverAssetId}.png`);
  const coverInfo = await sharp(join(config.MEDIA_DIR, cover.rows[0].storage_key)).metadata();
  assert.equal(coverInfo.width, 1080);
  assert.equal(coverInfo.height, 1440);
  assert.equal((await request('POST', '/outfits', { name: '越界', items: [{ clothingId: clothing.id, x: 0.9, y: 0.9, width: 0.3, height: 0.3, rotation: 45, zIndex: 0 }] })).status, 422);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const record1 = await data(await request('POST', '/wear-records', { wornOn: day, outfitId: outfit.id }), wearSchema, 201);
  const record2 = await data(await request('POST', '/wear-records', { wornOn: day, clothingIds: [clothing.id], occasion: '晚餐' }), wearSchema, 201);
  assert.equal((await data(await request('GET', `/clothes/${clothing.id}`), clothingSchema)).wearCount, 1);
  await data(await request('PATCH', `/outfits/${outfit.id}`, { version: outfit.version, items: [{ clothingId: free.id, x: 0.2, y: 0.2, width: 0.3, height: 0.3, rotation: 0, zIndex: 0 }] }), outfitSchema);
  const records = await data(await request('GET', `/wear-records?from=${day}&to=${day}`), z.array(wearSchema));
  assert.equal(records.find(item => item.id === record1.id)?.items[0].clothingId, clothing.id);
  assert.equal((await request('POST', '/wear-records', { wornOn: '2099-01-01', clothingIds: [clothing.id] })).status, 400);
  assert.equal((await request('DELETE', `/clothes/${clothing.id}`)).status, 409);
  const packing = await data(await request('POST', '/packing-lists', { name: '出行', clothingIds: [clothing.id, clothing.id] }), packingSchema, 201);
  assert.equal(packing.items.length, 1);
  const packed = await data(await request('PATCH', `/packing-lists/${packing.id}`, { version: packing.version, name: packing.name, startOn: null, endOn: null, items: [{ clothingId: clothing.id, packed: true }] }), packingSchema);
  assert.equal(packed.items[0].packed, true);
  const copied = await data(await request('POST', `/packing-lists/${packing.id}/copy`, { name: '复制', startOn: null, endOn: null }), packingSchema, 201);
  assert.equal(copied.items[0].packed, false);
  const stats = await data(await request('GET', '/statistics'), statisticsSchema);
  assert.equal(stats.totalPriceCents, '29900');
  assert.equal(stats.pricedCount, 2);
  assert.equal(stats.wornDays, 1);
  assert.equal(stats.outfitCount, 1);
  const statsDetails = await data(await request('GET', '/statistics/clothes'), z.array(clothingStatisticsSchema));
  assert.equal(statsDetails.find(item => item.id === free.id)?.priceCents, '0');
  assert.equal(statsDetails.find(item => item.id === clothing.id)?.costPerWearCents, '29900');
  assert.equal(statsDetails[0].wearCount, 0);
  const mostWorn = await data(await request('GET', '/statistics/clothes?sort=most-worn&pageSize=1'), z.array(clothingStatisticsSchema));
  assert.equal(mostWorn[0].id, clothing.id);
  assert.equal((await request('GET', '/statistics/clothes?sort=invalid')).status, 400);
  const signed = await data(await request('POST', '/media/signed-urls', { assetIds: [asset.assetId] }), z.array(signedUrlSchema));
  const mediaUrl = new URL(signed[0].url);
  assert.equal(mediaUrl.pathname, `/ootd/api/media/content/${asset.assetId}`);
  assert.equal((await fetch(mediaUrl)).status, 200);
  await rename(join(config.MEDIA_DIR, `originals/${asset.assetId}.png`), join(config.MEDIA_DIR, `${asset.assetId}.png`));
  await pool.query('UPDATE media_assets SET storage_key=$2 WHERE id=$1', [asset.assetId, `${asset.assetId}.png`]);
  assert.equal((await fetch(mediaUrl)).status, 200, '已有根目录文件仍按数据库路径读取');
  mediaUrl.searchParams.set('signature', '0'.repeat(64));
  assert.equal((await fetch(mediaUrl)).status, 403);
  assert.equal((await request('POST', '/media/signed-urls', { assetIds: [asset.assetId] }, tokenB)).status, 404);
  const thumbnails = await data(await request('POST', '/media/signed-urls', { assetIds: [asset.assetId], variant: 'thumbnail' }), z.array(signedUrlSchema));
  assert.equal(thumbnails[0].assetId, asset.assetId);
  assert(new URL(thumbnails[0].url).pathname.endsWith(asset.thumbnailAssetId));
  const thumbnail = await fetch(thumbnails[0].url);
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.headers.get('content-type'), 'image/webp');
  const thumbnailInfo = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
  assert(thumbnailInfo.width <= 480 && thumbnailInfo.height <= 528);
  const key = randomUUID();
  const job = await data(await request('POST', '/image-jobs', { inputAssetId: asset.assetId, kind: 'cutout' }, tokenA, key), jobSchema, 202);
  assert.equal((await data(await request('POST', '/image-jobs', { inputAssetId: asset.assetId, kind: 'cutout' }, tokenA, key), jobSchema, 202)).id, job.id);
  assert.equal((await request('POST', '/image-jobs', { inputAssetId: asset.assetId, kind: 'classify' }, tokenA, key)).status, 409);
  assert.equal((await data(await request('POST', `/image-jobs/${job.id}/cancel`), jobSchema, 202)).status, 'cancelled');
  assert.equal((await request('POST', `/image-jobs/${job.id}/cancel`)).status, 409);
  assert.equal((await request('GET', `/image-jobs/${job.id}`, undefined, tokenB)).status, 404);
  const overridden = await fetch(`${base}/clothes/${free.id}`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json', 'X-HTTP-Method-Override': 'PATCH' }, body: JSON.stringify({ version: free.version, favorite: true }) });
  assert.equal(overridden.status, 200);
  const replacementForm = new FormData(); replacementForm.set('purpose', 'clothing'); replacementForm.set('file', new Blob([png]), 'replacement.png');
  const replacement = await data(await fetch(`${base}/media`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: replacementForm }), mediaSchema, 201);
  const changedImage = await data(await request('PATCH', `/clothes/${free.id}`, { version: free.version + 1, primaryAssetId: replacement.assetId }), clothingSchema);
  const invalidated = await data(await request('GET', `/outfits/${outfit.id}`), outfitSchema);
  assert.equal(invalidated.coverAssetId, null);
  assert.equal(invalidated.version, outfit.version + 2);
  assert.equal(changedImage.primaryAssetId, replacement.assetId);
  while (await processNextImageJob()) {}
  await t.test('New API 真实生成处理图与衣物资料', { skip: process.env.RUN_PAID_AI_TESTS !== 'true' || !config.NEW_API_KEY }, async () => {
    const processed = await data(await request('POST', '/image-jobs', { inputAssetId: asset.assetId, clothingId: clothing.id, kind: 'process' }, tokenA, randomUUID()), jobSchema, 202);
    await processNextImageJob();
    const done = await data(await request('GET', `/image-jobs/${processed.id}`), jobSchema);
    assert.equal(done.status, 'succeeded');
    assert(done.result?.cutoutAssetId);
    assert(done.result.suggestions?.categoryId);
    const processedAsset = await pool.query<{ storage_key: string }>('SELECT storage_key FROM media_assets WHERE id=$1', [done.result.cutoutAssetId]);
    assert.equal(processedAsset.rows[0].storage_key, `cutouts/${done.result.cutoutAssetId}.png`);
    assert.equal((await sharp(join(config.MEDIA_DIR, processedAsset.rows[0].storage_key)).metadata()).hasAlpha, true);
  });
  const exported = await data(await request('POST', '/data-exports', { format: 'zip' }, tokenA, randomUUID()), exportSchema, 202);
  assert.equal(await processNextExport(), true);
  const completed = await data(await request('GET', `/data-exports/${exported.id}`), exportSchema);
  assert.equal(completed.status, 'succeeded');
  const zip = await pool.query<{ storage_key: string }>('SELECT storage_key FROM media_assets WHERE id=$1', [completed.assetId]);
  assert.equal(zip.rows[0].storage_key, `exports/${completed.assetId}.zip`);
  const archive: unknown = JSON.parse(execFileSync('unzip', ['-p', join(config.MEDIA_DIR, zip.rows[0].storage_key), 'data.json'], { encoding: 'utf8' }));
  const parsedExport = z.object({ user: z.array(z.object({ id: z.string() })), clothes: z.array(z.object({ name: z.string() })), media: z.array(z.object({ id: z.string(), file: z.string() })) }).parse(archive);
  assert.deepEqual(parsedExport.user.map(user => user.id), [users[0]]);
  assert(parsedExport.media.some(item => item.id === asset.assetId));
  assert(parsedExport.media.some(item => item.file === `media/originals/${replacement.assetId}.png`));
  assert(execFileSync('unzip', ['-Z1', join(config.MEDIA_DIR, zip.rows[0].storage_key)], { encoding: 'utf8' }).split('\n').includes(`media/originals/${replacement.assetId}.png`));
  assert(!JSON.stringify(archive).includes('wechat_openid'));
  assert.equal((await request('DELETE', `/wear-records/${record1.id}`)).status, 204);
  assert.equal((await request('DELETE', `/wear-records/${record2.id}`)).status, 204);
  assert.equal((await data(await request('GET', `/clothes/${clothing.id}`), clothingSchema)).wearCount, 0);
  const orphanForm = new FormData();
  orphanForm.set('purpose', 'clothing'); orphanForm.set('file', new Blob([png]), 'unused.png');
  const orphan = await data(await fetch(`${base}/media`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: orphanForm }), mediaSchema, 201);
  const looseKeys = [`${randomUUID()}.png`, `originals/${randomUUID()}.png`, `thumbnails/${randomUUID()}.webp.tmp`];
  const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
  for (const key of looseKeys) {
    await writeFile(join(config.MEDIA_DIR, key), png);
    await utimes(join(config.MEDIA_DIR, key), oldTime, oldTime);
  }
  const freshKey = `thumbnails/${randomUUID()}.webp.tmp`;
  await writeFile(join(config.MEDIA_DIR, freshKey), png);
  await utimes(join(config.MEDIA_DIR, `${asset.assetId}.png`), oldTime, oldTime);
  await utimes(join(config.MEDIA_DIR, `thumbnails/${asset.thumbnailAssetId}.webp`), oldTime, oldTime);
  await pool.query("UPDATE media_assets SET created_at=now()-interval '25 hours'");
  await maintenance();
  for (const key of looseKeys) assert.equal(existsSync(join(config.MEDIA_DIR, key)), false);
  assert(existsSync(join(config.MEDIA_DIR, freshKey)));
  assert(existsSync(join(config.MEDIA_DIR, `${asset.assetId}.png`)));
  assert(existsSync(join(config.MEDIA_DIR, `thumbnails/${asset.thumbnailAssetId}.webp`)));
  assert.equal(existsSync(join(config.MEDIA_DIR, `originals/${orphan.assetId}.png`)), false);
  assert.equal(existsSync(join(config.MEDIA_DIR, `thumbnails/${orphan.thumbnailAssetId}.webp`)), false);
  assert.equal((await pool.query('SELECT id FROM media_assets WHERE id=ANY($1::uuid[])', [[orphan.assetId, orphan.thumbnailAssetId]])).rows.length, 0);
  assert.equal((await pool.query('SELECT id FROM media_assets WHERE id=$1', [asset.assetId])).rows.length, 1);
  const archived = await data(await request('PATCH', `/clothes/${clothing.id}`, { version: updated.version, status: 'archived' }), clothingSchema);
  assert.equal(archived.status, 'archived');
  assert.equal((await request('POST', `/packing-lists/${packing.id}/copy`, { name: '含归档的复制', startOn: null, endOn: null })).status, 422);
  await t.test('衣橱组合筛选：场景多选、色系、季节、收藏与分页', async () => {
    const commute = await data(await request('POST', '/tags', { name: '筛选通勤', kind: 'occasion' }), tagSchema, 201);
    const sport = await data(await request('POST', '/tags', { name: '筛选运动', kind: 'occasion' }), tagSchema, 201);
    const foreign = await data(await request('POST', '/tags', { name: '他人场景', kind: 'occasion' }, tokenB), tagSchema, 201);
    const style = await data(await request('POST', '/tags', { name: '筛选风格', kind: 'style' }), tagSchema, 201);
    const category = await data(await request('POST', '/categories', { name: '筛选分类' }), categorySchema, 201);
    const form = new FormData();
    form.set('purpose', 'clothing');
    form.set('file', new Blob([await sharp({ create: { width: 80, height: 100, channels: 3, background: '#426e91' } }).png().toBuffer()], { type: 'image/png' }), 'filter.png');
    const asset = await data(await fetch(`${base}/media`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: form }), mediaSchema, 201);
    const red = await data(await request('POST', '/clothes', { primaryAssetId: asset.assetId, categoryId: category.id, name: '筛选红色', colors: ['red'], seasons: ['spring'], tagIds: [commute.id], favorite: true }), clothingSchema, 201);
    const blue = await data(await request('POST', '/clothes', { primaryAssetId: asset.assetId, categoryId: category.id, name: '筛选蓝色', colors: ['blue'], seasons: ['summer'], tagIds: [sport.id] }), clothingSchema, 201);
    const cream = await data(await request('POST', '/clothes', { primaryAssetId: asset.assetId, categoryId: category.id, name: '筛选四季', colors: ['cream'], seasons: ['all'], tagIds: [commute.id, style.id] }), clothingSchema, 201);
    const combined = await data(await request('GET', `/clothes?occasionIds=${commute.id},${sport.id}&colors=red,blue&seasons=spring,summer`), z.array(clothingSchema));
    assert.deepEqual(new Set(combined.map(item => item.id)), new Set([red.id, blue.id]));
    const favorite = await data(await request('GET', `/clothes?occasionIds=${commute.id}&colors=red,cream&seasons=spring&favorite=true`), z.array(clothingSchema));
    assert.deepEqual(favorite.map(item => item.id), [red.id]);
    assert.deepEqual((await data(await request('GET', `/clothes?occasionIds=${commute.id}&seasons=winter`), z.array(clothingSchema))).map(item => item.id), [cream.id]);
    assert.deepEqual(await data(await request('GET', `/clothes?occasionIds=${foreign.id}`), z.array(clothingSchema)), []);
    assert.deepEqual(await data(await request('GET', `/clothes?occasionIds=${style.id}`), z.array(clothingSchema)), []);
    assert.deepEqual(await data(await request('GET', '/clothes?colors=white&seasons=winter'), z.array(clothingSchema)), []);
    assert.equal((await request('GET', '/clothes?occasionIds=invalid')).status, 400);
    const pageSchema = z.object({ data: z.array(clothingSchema), pagination: z.object({ total: z.number() }) });
    const first = pageSchema.parse(await (await request('GET', `/clothes?occasionIds=${commute.id},${sport.id}&pageSize=1`)).json());
    const second = pageSchema.parse(await (await request('GET', `/clothes?occasionIds=${commute.id},${sport.id}&pageSize=1&page=2`)).json());
    assert.equal(first.pagination.total, 3);
    assert.equal(second.pagination.total, 3);
    assert.equal(first.data.length, 1);
    assert.equal(second.data.length, 1);
    assert.notEqual(first.data[0].id, second.data[0].id);
  });
  await t.test('品牌、尺码、面料维护：选择、归属、排序、重命名、删除与导出', async () => {
    assert.equal((await fetch(`${base}/clothing-options`)).status, 401);
    assert.deepEqual(await data(await request('GET', '/clothing-options'), z.array(clothingOptionSchema)), []);
    const brand = await data(await request('POST', '/clothing-options', { kind: 'brand', name: '  测试品牌  ' }), clothingOptionSchema, 201);
    assert.equal(brand.name, '测试品牌');
    const brand2 = await data(await request('POST', '/clothing-options', { kind: 'brand', name: '第二品牌' }), clothingOptionSchema, 201);
    const size = await data(await request('POST', '/clothing-options', { kind: 'clothing-size', name: 'M' }), clothingOptionSchema, 201);
    const material = await data(await request('POST', '/clothing-options', { kind: 'material', name: '棉 95% / 氨纶 5%' }), clothingOptionSchema, 201);
    const foreign = await data(await request('POST', '/clothing-options', { kind: 'brand', name: brand.name }, tokenB), clothingOptionSchema, 201);
    assert.equal((await request('POST', '/clothing-options', { kind: 'brand', name: brand.name })).status, 409);
    assert.equal((await request('POST', '/clothing-options', { kind: 'brand', name: ' ' })).status, 400);
    assert.equal((await request('POST', '/clothing-options', { kind: 'other', name: '无效类型' })).status, 400);
    assert.equal((await request('POST', '/clothing-options', { kind: 'clothing-size', name: '长'.repeat(101) })).status, 400);
    assert.equal((await request('GET', '/clothing-options?kind=other')).status, 400);
    assert.equal((await request('PATCH', `/clothing-options/${brand.id}`, { version: brand.version, name: '越权修改' }, tokenB)).status, 404);
    assert.equal((await request('DELETE', `/clothing-options/${brand.id}`, undefined, tokenB)).status, 404);
    assert.deepEqual((await data(await request('GET', '/clothing-options', undefined, tokenB), z.array(clothingOptionSchema))).map(item => item.id), [foreign.id]);
    const sorted = [brand2, brand].map(item => ({ id: item.id, version: item.version }));
    assert.equal((await request('POST', '/clothing-options/reorder', { kind: 'brand', items: [{ id: brand2.id, version: 999 }, sorted[1]] })).status, 409);
    assert.equal((await request('POST', '/clothing-options/reorder', { kind: 'brand', items: [{ id: brand.id, version: brand.version }, { id: foreign.id, version: foreign.version }] })).status, 409);
    assert.equal((await request('POST', '/clothing-options/reorder', { kind: 'brand', items: [{ id: brand.id, version: brand.version }, { id: size.id, version: size.version }] })).status, 409);
    assert.equal((await request('POST', '/clothing-options/reorder', { kind: 'brand', items: sorted })).status, 204);
    const brands = await data(await request('GET', '/clothing-options?kind=brand'), z.array(clothingOptionSchema));
    assert.deepEqual(brands.map(item => item.id), [brand2.id, brand.id]);
    assert.equal((await request('POST', '/clothing-options/reorder', { kind: 'brand', items: sorted })).status, 409);
    const optionInput = { primaryAssetId: asset.assetId, categoryId: category.id, name: '维护项衣物', brandId: brand.id, sizeId: size.id, materialId: material.id };
    assert.equal((await request('POST', '/clothes', { ...optionInput, brandId: foreign.id })).status, 422);
    assert.equal((await request('POST', '/clothes', { ...optionInput, brandId: size.id })).status, 422);
    assert.equal((await request('POST', '/clothes', { ...optionInput, sizeId: randomUUID() })).status, 422);
    assert.equal((await request('POST', '/clothes', { ...optionInput, brand: brand.name })).status, 400);
    const item = await data(await request('POST', '/clothes', optionInput), clothingSchema, 201);
    assert.deepEqual([item.brand, item.sizeLabel, item.material], [brand.name, size.name, material.name]);
    assert.deepEqual([item.brandId, item.sizeId, item.materialId], [brand.id, size.id, material.id]);
    assert.equal((await request('PATCH', `/clothes/${item.id}`, { version: item.version, materialId: size.id })).status, 422);
    assert.deepEqual(await data(await request('GET', `/clothes/${item.id}`), clothingSchema), item);
    for (const option of [brand, size, material]) {
      const response = await request('DELETE', `/clothing-options/${option.id}`);
      assert.equal(response.status, 409);
      assert.equal(z.object({ error: z.object({ code: z.string() }) }).parse(await response.json()).error.code, 'RESOURCE_REFERENCED');
    }
    const renamedBrand = await data(await request('PATCH', `/clothing-options/${brand.id}`, { version: brands[1].version, name: '更新后的品牌' }), clothingOptionSchema);
    const renamedSize = await data(await request('PATCH', `/clothing-options/${size.id}`, { version: size.version, name: 'L' }), clothingOptionSchema);
    const renamedMaterial = await data(await request('PATCH', `/clothing-options/${material.id}`, { version: material.version, name: '纯棉' }), clothingOptionSchema);
    assert.equal((await request('PATCH', `/clothing-options/${brand.id}`, { version: brands[1].version, name: '旧版本修改' })).status, 409);
    const reread = await data(await request('GET', `/clothes/${item.id}`), clothingSchema);
    assert.deepEqual([reread.brand, reread.sizeLabel, reread.material], [renamedBrand.name, renamedSize.name, renamedMaterial.name]);
    const search = z.object({ data: z.array(clothingSchema), pagination: z.object({ total: z.number() }) }).parse(await (await request('GET', `/clothes?q=${encodeURIComponent(renamedBrand.name)}`)).json());
    assert.deepEqual(search.data.map(item => item.id), [item.id]);
    assert.equal(search.pagination.total, 1);
    const exported = await data(await request('POST', '/data-exports', { format: 'zip' }, tokenA, randomUUID()), exportSchema, 202);
    assert.equal(await processNextExport(), true);
    const completed = await data(await request('GET', `/data-exports/${exported.id}`), exportSchema);
    assert.equal(completed.status, 'succeeded');
    const zip = await pool.query<{ storage_key: string }>('SELECT storage_key FROM media_assets WHERE id=$1', [completed.assetId]);
    const snapshot = z.object({ clothingOptions: z.array(z.object({ id: z.string(), name: z.string() })), clothes: z.array(z.object({ id: z.string(), brand_id: z.string().nullable(), brand: z.string(), size_label: z.string(), material: z.string() })) }).parse(JSON.parse(execFileSync('unzip', ['-p', join(config.MEDIA_DIR, zip.rows[0].storage_key), 'data.json'], { encoding: 'utf8' })));
    assert(!snapshot.clothingOptions.some(option => option.id === foreign.id));
    assert.equal(snapshot.clothingOptions.find(option => option.id === brand.id)?.name, renamedBrand.name);
    assert.deepEqual(snapshot.clothes.find(clothing => clothing.id === item.id), { id: item.id, brand_id: brand.id, brand: renamedBrand.name, size_label: renamedSize.name, material: renamedMaterial.name });
    const cleared = await data(await request('PATCH', `/clothes/${item.id}`, { version: reread.version, brandId: null, sizeId: null, materialId: null }), clothingSchema);
    assert.deepEqual([cleared.brand, cleared.sizeLabel, cleared.material], ['', '', '']);
    for (const option of [brand, brand2, size, material]) assert.equal((await request('DELETE', `/clothing-options/${option.id}`)).status, 204);
    assert.equal((await request('POST', '/clothes', optionInput)).status, 422);
    assert.equal((await request('DELETE', `/clothes/${item.id}`)).status, 204);
  });
  await t.test('服装尺码与鞋码：分组维护、二级分类继承、跨组更换与批量修改', async () => {
    const tops = await data(await request('POST', '/categories', { name: '尺码测试服装' }), categorySchema, 201);
    const footwear = await data(await request('POST', '/categories', { name: '尺码测试鞋子' }), categorySchema, 201);
    const shoes = await data(await request('PATCH', `/categories/${footwear.id}/size-kind`, { version: footwear.version, sizeKind: 'shoe-size' }), categorySchema);
    assert.equal(tops.sizeKind, 'clothing-size');
    assert.equal(shoes.sizeKind, 'shoe-size');
    const child = await data(await request('POST', '/categories', { name: '尺码测试运动鞋', parentId: shoes.id }), categorySchema, 201);
    assert.equal(child.sizeKind, 'shoe-size');
    const renamed = await data(await request('PATCH', `/categories/${shoes.id}`, { version: shoes.version, name: '改名后的鞋类' }), categorySchema);
    assert.equal(renamed.sizeKind, 'shoe-size');
    const list = await data(await request('GET', '/categories'), z.array(categorySchema));
    assert.equal(list.find(item => item.id === child.id)!.sizeKind, 'shoe-size');
    assert.equal((await request('PATCH', `/categories/${tops.id}/size-kind`, { version: tops.version, sizeKind: 'shoe-size' }, tokenB)).status, 404);
    assert.equal((await request('PATCH', `/categories/${tops.id}/size-kind`, { version: 999, sizeKind: 'shoe-size' })).status, 409);
    const medium = await data(await request('POST', '/clothing-options', { kind: 'clothing-size', name: 'M' }), clothingOptionSchema, 201);
    const large = await data(await request('POST', '/clothing-options', { kind: 'clothing-size', name: 'L' }), clothingOptionSchema, 201);
    const shoe38 = await data(await request('POST', '/clothing-options', { kind: 'shoe-size', name: '38' }), clothingOptionSchema, 201);
    const shoe39 = await data(await request('POST', '/clothing-options', { kind: 'shoe-size', name: '39' }), clothingOptionSchema, 201);
    assert.equal((await request('POST', '/clothing-options', { kind: 'size', name: '旧类型' })).status, 400);
    assert.deepEqual((await data(await request('GET', '/clothing-options?kind=clothing-size'), z.array(clothingOptionSchema))).map(item => item.id), [medium.id, large.id]);
    const sorted = [shoe39, shoe38].map(item => ({ id: item.id, version: item.version }));
    assert.equal((await request('POST', '/clothing-options/reorder', { kind: 'shoe-size', items: sorted })).status, 204);
    assert.deepEqual((await data(await request('GET', '/clothing-options?kind=shoe-size'), z.array(clothingOptionSchema))).map(item => item.id), [shoe39.id, shoe38.id]);
    const input = { primaryAssetId: asset.assetId, categoryId: tops.id, sizeId: medium.id, name: '按分类选择尺码' };
    assert.equal((await request('POST', '/clothes', { ...input, sizeId: shoe38.id })).status, 422);
    assert.equal((await request('POST', '/clothes', { ...input, categoryId: child.id })).status, 422);
    assert.equal((await request('POST', '/clothes', { ...input, categoryId: null, status: 'draft' })).status, 422);
    const clothing = await data(await request('POST', '/clothes', input), clothingSchema, 201);
    const edited = await data(await request('PATCH', `/clothes/${clothing.id}`, { version: clothing.version, notes: '保留同组尺码' }), clothingSchema);
    assert.equal(edited.sizeId, medium.id);
    assert.equal((await request('PATCH', `/categories/${tops.id}/size-kind`, { version: tops.version, sizeKind: 'shoe-size' })).status, 409);
    const switched = await data(await request('PATCH', `/clothes/${clothing.id}`, { version: edited.version, categoryId: child.id }), clothingSchema);
    assert.equal(switched.sizeId, null);
    assert.equal(switched.sizeLabel, '');
    const sizedShoe = await data(await request('PATCH', `/clothes/${clothing.id}`, { version: switched.version, sizeId: shoe38.id }), clothingSchema);
    assert.equal(sizedShoe.sizeLabel, '38');
    assert.equal((await request('PATCH', `/clothes/${clothing.id}`, { version: sizedShoe.version, sizeId: medium.id })).status, 422);
    const sameGroup = await data(await request('PATCH', `/clothes/${clothing.id}`, { version: sizedShoe.version, categoryId: renamed.id }), clothingSchema);
    assert.equal(sameGroup.sizeId, shoe38.id);
    assert.equal((await request('POST', '/clothes/batch', { action: 'change-category', items: [{ id: sameGroup.id, version: sameGroup.version }], parameters: { categoryId: tops.id } })).status, 200);
    const batched = await data(await request('GET', `/clothes/${clothing.id}`), clothingSchema);
    assert.equal(batched.sizeId, null);
    const correctSize = await data(await request('PATCH', `/clothes/${clothing.id}`, { version: batched.version, sizeId: large.id }), clothingSchema);
    assert.equal(correctSize.sizeLabel, 'L');
    assert.equal((await request('DELETE', `/clothes/${clothing.id}`)).status, 204);
    for (const item of [medium, large, shoe38, shoe39]) assert.equal((await request('DELETE', `/clothing-options/${item.id}`)).status, 204);
    for (const item of [child, renamed, tops]) assert.equal((await request('DELETE', `/categories/${item.id}`)).status, 204);
  });
  assert.equal((await request('POST', '/auth/logout')).status, 204);
  assert.equal((await request('GET', '/me')).status, 401);
  assert.equal((await request('DELETE', '/me', { confirmation: 'DELETE_MY_ACCOUNT' }, tokenB)).status, 202);
  assert.equal((await request('GET', '/me', undefined, tokenB)).status, 401);
  await maintenance();
  assert.equal((await pool.query('SELECT id FROM users WHERE id=$1', [users[1]])).rows.length, 0);
});
test('邀请码准入：一次性、失效回滚、并发人数限制', async () => {
  const fixtures = [];
  for (const index of [0, 1, 2]) {
    const registrationToken = randomBytes(32).toString('base64url');
    const invitationCode = randomBytes(16).toString('hex');
    await pool.query("INSERT INTO registrations(token_hash,wechat_openid,expires_at) VALUES($1,$2,now()+interval '5 minutes')", [createHash('sha256').update(registrationToken).digest('hex'), `invitation-test-${index}`]);
    await pool.query("INSERT INTO invitations(code_hash,expires_at) VALUES($1,now()+interval '1 hour')", [createHash('sha256').update(invitationCode).digest('hex')]);
    fixtures.push({ registrationToken, invitationCode });
  }
  assert.equal((await request('POST', '/auth/invitations/redeem', { ...fixtures[0], invitationCode: 'invalid' })).status, 403);
  const joined = await data(await request('POST', '/auth/invitations/redeem', fixtures[0]), loginSchema, 201);
  assert('token' in joined);
  const joinedCategories = await data(await request('GET', '/categories', undefined, joined.token), z.array(categorySchema));
  assert.deepEqual(joinedCategories.map(item => item.name), ['上衣', '外套', '裤子', '裙子', '连衣裙', '鞋靴', '箱包', '配饰', '眼镜', '帽子', '其他']);
  assert(joinedCategories.every(item => item.parentId === null));
  const shoeRoot = joinedCategories.find(item => item.name === '鞋靴')!;
  assert.equal(shoeRoot.sizeKind, 'shoe-size');
  const customRoot = await data(await request('POST', '/categories', { name: '运动装备' }, joined.token), categorySchema, 201);
  assert.equal(customRoot.parentId, null);
  const customChild = await data(await request('POST', '/categories', { name: '登山鞋', parentId: shoeRoot.id }, joined.token), categorySchema, 201);
  assert.equal(customChild.parentId, shoeRoot.id);
  assert.equal(customChild.sizeKind, 'shoe-size');
  assert.equal((await request('POST', '/auth/invitations/redeem', fixtures[0])).status, 401);
  const competing = await Promise.all(fixtures.slice(1).map(input => request('POST', '/auth/invitations/redeem', input)));
  assert.deepEqual(competing.map(response => response.status).sort(), [201, 403]);
  assert.equal((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM users WHERE status='active'")).rows[0].count, 3);
});
test('维护项迁移：旧文字按用户、类别去重，保留关联与未填写值', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA legacy_options');
    await client.query('SET LOCAL search_path TO legacy_options');
    for (const filename of ['V1__init_schema.sql', 'V2__ai_clothing_processing.sql', 'V3__clothing_category_hierarchy.sql']) await client.query(await readFile(`server/migrations/${filename}`, 'utf8'));
    const owner = await client.query<{ id: string }>("INSERT INTO users(wechat_openid) VALUES('legacy-a'),('legacy-b') RETURNING id");
    const ids: string[] = [];
    for (const user of owner.rows) {
      const image = await client.query<{ id: string }>("INSERT INTO media_assets(user_id,kind,storage_key,mime_type,width,height,byte_size) VALUES($1,'original',$2,'image/png',1,1,1) RETURNING id", [user.id, randomUUID()]);
      for (const brand of ['  同名品牌  ', '同名品牌', '   ']) {
        const clothing = await client.query<{ id: string }>("INSERT INTO clothes(user_id,name,primary_asset_id,status,brand,size_label,material) VALUES($1,'旧衣物',$2,'draft',$3,$4,$5) RETURNING id", [user.id, image.rows[0].id, brand, brand.trim() ? '同名品牌' : '', brand.trim() ? '棉 95% / 氨纶 5%' : '']);
        ids.push(clothing.rows[0].id);
      }
    }
    await client.query(await readFile('server/migrations/V4__clothing_options.sql', 'utf8'));
    const options = await client.query<{ id: string; user_id: string; kind: string; name: string }>('SELECT id,user_id,kind,name FROM clothing_options');
    assert.equal(options.rows.length, 6);
    const migrated = await client.query<{ id: string; brand_id: string | null; size_id: string | null; material_id: string | null }>('SELECT id,brand_id,size_id,material_id FROM clothes ORDER BY created_at,id');
    for (const [index, user] of owner.rows.entries()) {
      const expected = options.rows.filter(option => option.user_id === user.id);
      for (const id of ids.slice(index * 3, index * 3 + 2)) {
        const clothing = migrated.rows.find(item => item.id === id)!;
        assert.equal(clothing.brand_id, expected.find(option => option.kind === 'brand')!.id);
        assert.equal(clothing.size_id, expected.find(option => option.kind === 'size')!.id);
        assert.equal(clothing.material_id, expected.find(option => option.kind === 'material')!.id);
        assert.notEqual(clothing.brand_id, clothing.size_id);
      }
      const empty = migrated.rows.find(item => item.id === ids[index * 3 + 2])!;
      assert.deepEqual([empty.brand_id, empty.size_id, empty.material_id], [null, null, null]);
    }
    assert.equal(options.rows.find(option => option.kind === 'material')!.name, '棉 95% / 氨纶 5%');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
test('尺码分组迁移：保留旧资料，拆分服装与鞋子共用的尺码', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA legacy_size_groups');
    await client.query('SET LOCAL search_path TO legacy_size_groups');
    for (const filename of ['V1__init_schema.sql', 'V2__ai_clothing_processing.sql', 'V3__clothing_category_hierarchy.sql', 'V4__clothing_options.sql']) await client.query(await readFile(`server/migrations/${filename}`, 'utf8'));
    const users = await client.query<{ id: string }>("INSERT INTO users(wechat_openid) VALUES('size-a'),('size-b') RETURNING id");
    const fixtures = [];
    for (const user of users.rows) {
      const categories = await client.query<{ id: string; name: string }>("INSERT INTO categories(user_id,name) VALUES($1,'上装'),($1,'鞋子') RETURNING id,name", [user.id]);
      const top = categories.rows.find(item => item.name === '上装')!;
      const shoe = categories.rows.find(item => item.name === '鞋子')!;
      const child = await client.query<{ id: string }>("INSERT INTO categories(user_id,name,parent_id) VALUES($1,'运动鞋',$2) RETURNING id", [user.id, shoe.id]);
      const image = await client.query<{ id: string }>("INSERT INTO media_assets(user_id,kind,storage_key,mime_type,width,height,byte_size) VALUES($1,'original',$2,'image/png',1,1,1) RETURNING id", [user.id, randomUUID()]);
      const size = await client.query<{ id: string }>("INSERT INTO clothing_options(user_id,kind,name) VALUES($1,'size','38') RETURNING id", [user.id]);
      await client.query("INSERT INTO clothing_options(user_id,kind,name) VALUES($1,'size','M'),($1,'size','36')", [user.id]);
      const clothes = await client.query<{ id: string; category_id: string }>("INSERT INTO clothes(user_id,name,primary_asset_id,status,category_id,size_id) VALUES($1,'旧服装',$2,'draft',$3,$5),($1,'旧鞋子',$2,'draft',$4,$5) RETURNING id,category_id", [user.id, image.rows[0].id, top.id, child.rows[0].id, size.rows[0].id]);
      fixtures.push({ userId: user.id, sizeId: size.rows[0].id, clothes: clothes.rows, topId: top.id, shoeId: shoe.id, childId: child.rows[0].id });
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query(await readFile('server/migrations/V5__size_groups.sql', 'utf8'));
    for (const fixture of fixtures) {
      const options = await client.query<{ id: string; kind: string; name: string }>('SELECT id,kind,name FROM clothing_options WHERE user_id=$1', [fixture.userId]);
      assert.equal(options.rows.length, 4);
      assert.equal(options.rows.find(item => item.name === 'M')!.kind, 'clothing-size');
      assert.equal(options.rows.find(item => item.name === '36')!.kind, 'shoe-size');
      const clothingSize = options.rows.find(item => item.name === '38' && item.kind === 'clothing-size')!;
      const shoeSize = options.rows.find(item => item.name === '38' && item.kind === 'shoe-size')!;
      assert.equal(clothingSize.id, fixture.sizeId);
      assert.notEqual(shoeSize.id, clothingSize.id);
      const clothes = await client.query<{ category_id: string; size_id: string; version: number }>('SELECT category_id,size_id,version FROM clothes WHERE user_id=$1', [fixture.userId]);
      assert.equal(clothes.rows.find(item => item.category_id === fixture.topId)!.size_id, clothingSize.id);
      assert.equal(clothes.rows.find(item => item.category_id === fixture.childId)!.size_id, shoeSize.id);
      assert.equal(clothes.rows.find(item => item.category_id === fixture.childId)!.version, 2);
      const shoeCategories = await client.query<{ size_kind: string }>('SELECT size_kind FROM categories WHERE user_id=$1 AND id=ANY($2::uuid[])', [fixture.userId, [fixture.shoeId, fixture.childId]]);
      assert(shoeCategories.rows.every(item => item.size_kind === 'shoe-size'));
    }
    assert.equal((await client.query("SELECT id FROM clothing_options WHERE kind='size'")).rows.length, 0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
test('搭配分类迁移：旧搭配和穿搭记录保留，分类初始为空', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA legacy_outfit_categories');
    await client.query('SET LOCAL search_path TO legacy_outfit_categories');
    for (const filename of ['V1__init_schema.sql', 'V2__ai_clothing_processing.sql', 'V3__clothing_category_hierarchy.sql', 'V4__clothing_options.sql', 'V5__size_groups.sql']) await client.query(await readFile(`server/migrations/${filename}`, 'utf8'));
    const owner = await client.query<{ id: string }>("INSERT INTO users(wechat_openid) VALUES('legacy-outfit-owner') RETURNING id");
    const outfit = await client.query<{ id: string }>("INSERT INTO outfits(user_id,name,occasion,background_color,favorite,version) VALUES($1,'旧搭配','旧场景','#FFFFFF',true,3) RETURNING id", [owner.rows[0].id]);
    await client.query("INSERT INTO wear_records(user_id,worn_on,source_outfit_id) VALUES($1,'2026-11-01',$2)", [owner.rows[0].id, outfit.rows[0].id]);
    await client.query(await readFile('server/migrations/V6__outfit_categories.sql', 'utf8'));
    const saved = await client.query<{ name: string; occasion: string; favorite: boolean; version: number; category_id: string | null }>('SELECT name,occasion,favorite,version,category_id FROM outfits WHERE id=$1', [outfit.rows[0].id]);
    assert.deepEqual(saved.rows[0], { name: '旧搭配', occasion: '旧场景', favorite: true, version: 3, category_id: null });
    assert.equal((await client.query('SELECT source_outfit_id FROM wear_records')).rows[0].source_outfit_id, outfit.rows[0].id);
    assert.equal((await client.query('SELECT id FROM outfit_categories')).rows.length, 0);
  } finally {
    await client.query('ROLLBACK'); client.release();
  }
});
test('迁移重复执行保持历史，篡改校验和阻止启动', async () => {
  await migrate();
  const history = await pool.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version=1');
  await pool.query("UPDATE schema_migrations SET checksum='tampered' WHERE version=1");
  await assert.rejects(migrate(), /迁移历史不匹配/);
  await pool.query('UPDATE schema_migrations SET checksum=$1 WHERE version=1', [history.rows[0].checksum]);
  await migrate();
});


test('小程序共享契约不依赖浏览器 URL 全局对象', async () => {
  const bundle = await build({
    entryPoints: ['miniprogram/api/contracts.ts'], bundle: true, write: false,
    platform: 'browser', format: 'cjs', target: 'es2020'
  });
  const context = { module: { exports: {} }, URL: undefined };
  runInNewContext(`${bundle.outputFiles[0].text}\nmodule.exports = { valid: signedUrlSchema.safeParse({ assetId: '019a78b9-4506-7444-9677-b1b7d8f25c30', url: 'http://127.0.0.1:3006/api/media/content/test?signature=test', expiresAt: '2026-11-12T00:00:00.000Z' }).success, invalid: signedUrlSchema.shape.url.safeParse('javascript:alert(1)').success };`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.module.exports)), { valid: true, invalid: false });
});

test('小程序错误响应在动态编译不可用时正常结束请求与上传', async () => {
  const bundle = await build({
    stdin: { contents: "export { RequestScope } from './miniprogram/utils/request'; export { z } from 'zod';", resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'browser', format: 'cjs', target: 'es2015'
  });
  const context = {
    module: { exports: {} }, testAssert: assert,
    Function: function () { return () => undefined; },
    wx: {
      getStorageSync: () => '',
      request(options: { url: string; success: (response: { statusCode: number; data: unknown }) => void }) {
        queueMicrotask(() => options.success(options.url.endsWith('/success')
          ? { statusCode: 200, data: { data: 'ok' } }
          : { statusCode: 409, data: { error: { code: 'VERSION_CONFLICT', message: '内容已更新' } } }));
        return { abort() {} };
      },
      uploadFile(options: { success: (response: { statusCode: number; data: string }) => void }) {
        queueMicrotask(() => options.success({ statusCode: 413, data: JSON.stringify({ error: { code: 'FILE_TOO_LARGE', message: '图片过大' } }) }));
        return { abort() {} };
      }
    }
  };
  await runInNewContext(`${bundle.outputFiles[0].text}
    (async () => {
      const { RequestScope, z } = module.exports;
      const scope = new RequestScope();
      await testAssert.rejects(scope.request('PATCH', '/conflict', z.undefined(), { version: 1, favorite: true }), error => error.code === 'VERSION_CONFLICT' && error.message === '内容已更新');
      testAssert.equal((await scope.request('GET', '/success', z.object({ data: z.string() }))).data, 'ok');
      await testAssert.rejects(scope.upload('/photo.jpg', 'avatar', z.undefined()), error => error.code === 'FILE_TOO_LARGE' && error.message === '图片过大');
      scope.close();
    })();`, context);
});

test('批量衣物：标签修改、删除、草稿、归属与整批回滚', async t => {
  const tokenB = randomBytes(32).toString('base64url');
  const foreignOwner = (await pool.query<{ id: string }>('INSERT INTO users(wechat_openid) VALUES($1) RETURNING id', [randomUUID()])).rows[0].id;
  await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [foreignOwner, createHash('sha256').update(tokenB).digest('hex')]);
  const token = randomBytes(32).toString('base64url');
  const owner = (await pool.query<{ id: string }>('INSERT INTO users(wechat_openid,nickname) VALUES($1,$2) RETURNING id', [randomUUID(), '批量测试'])).rows[0].id;
  await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [owner, createHash('sha256').update(token).digest('hex')]);
  const call = (method: string, path: string, body?: unknown) => request(method, path, body, token);
  const category = await data(await call('POST', '/categories', { name: '批量上衣' }), categorySchema, 201);
  const shoeCategory = await data(await call('POST', '/categories', { name: '批量鞋' }), categorySchema, 201);
  const shoes = await data(await call('PATCH', `/categories/${shoeCategory.id}/size-kind`, { version: shoeCategory.version, sizeKind: 'shoe-size' }), categorySchema);
  const child = await data(await call('POST', '/categories', { name: '批量衬衫', parentId: category.id }), categorySchema, 201);
  const asset = (await pool.query<{ id: string }>("INSERT INTO media_assets(user_id,kind,storage_key,mime_type,width,height,byte_size) VALUES($1,'original',$2,'image/png',1,1,1) RETURNING id", [owner, randomUUID()])).rows[0].id;
  const occasion = await data(await call('POST', '/tags', { name: '批量通勤', kind: 'occasion' }), tagSchema, 201);
  const occasion2 = await data(await call('POST', '/tags', { name: '批量旅行', kind: 'occasion' }), tagSchema, 201);
  const style = await data(await call('POST', '/tags', { name: '批量简约', kind: 'style' }), tagSchema, 201);
  const foreignTag = await data(await request('POST', '/tags', { name: '他人的批量标签', kind: 'style' }, tokenB), tagSchema, 201);
  const brand = await data(await call('POST', '/clothing-options', { kind: 'brand', name: '批量品牌' }), clothingOptionSchema, 201);
  const size = await data(await call('POST', '/clothing-options', { kind: 'clothing-size', name: '批量M' }), clothingOptionSchema, 201);
  const material = await data(await call('POST', '/clothing-options', { kind: 'material', name: '批量棉' }), clothingOptionSchema, 201);
  const foreignBrand = await data(await request('POST', '/clothing-options', { kind: 'brand', name: '他人批量品牌' }, tokenB), clothingOptionSchema, 201);
  async function pair() {
    const items = await Promise.all(['active', 'draft'].map(async status => data(await call('POST', '/clothes', { primaryAssetId: asset, categoryId: category.id, name: '批量原名', status, colors: ['blue'], seasons: ['summer'], tagIds: [occasion.id, style.id], notes: '保留备注' }), clothingSchema, 201)));
    return items.sort((a, b) => a.id.localeCompare(b.id));
  }
  const read = (id: string) => call('GET', `/clothes/${id}`).then(response => data(response, clothingSchema));
  const batch = (items: { id: string; version: number }[], input: object) => call('POST', '/clothes/batch', { ...input, items: items.map(item => ({ id: item.id, version: item.version })) });
  await t.test('所有标签字段、清空、分类跨尺码组与草稿状态保留', async () => {
    const original = await pair();
    const parameters = { colors: ['white', 'black'], seasons: ['spring', 'autumn'], pattern: 'striped', brandId: brand.id, sizeId: size.id, materialId: material.id };
    assert.equal((await batch(original, { action: 'update-attributes', parameters })).status, 200);
    const edited = await Promise.all(original.map(item => read(item.id)));
    for (const [index, item] of edited.entries()) {
      for (const key of ['colors', 'seasons', 'pattern', 'brandId', 'sizeId', 'materialId'] as const) assert.deepEqual(item[key], parameters[key]);
      assert.equal(item.status, original[index].status);
      assert.equal(item.name, original[index].name);
      assert.equal(item.notes, '保留备注');
      assert.deepEqual(item.tagIds.sort(), [occasion.id, style.id].sort());
      assert.equal(item.version, original[index].version + 1);
    }
    assert.equal((await batch(edited, { action: 'change-category', parameters: { categoryId: child.id } })).status, 200);
    const categorized = await Promise.all(original.map(item => read(item.id)));
    assert(categorized.every(item => item.categoryId === child.id && item.sizeId === size.id));
    assert.equal((await batch(categorized, { action: 'change-category', parameters: { categoryId: shoes.id } })).status, 200);
    const switched = await Promise.all(original.map(item => read(item.id)));
    assert(switched.every(item => item.sizeId === null));
    assert.equal((await batch(switched, { action: 'update-attributes', parameters: { colors: [], seasons: [], pattern: null, brandId: null, sizeId: null, materialId: null } })).status, 200);
    for (const current of await Promise.all(original.map(item => read(item.id)))) {
      assert.deepEqual(current.colors, []);
      assert.deepEqual(current.seasons, []);
      assert.equal(current.pattern, null);
      assert.equal(current.brandId, null);
      assert.equal(current.materialId, null);
    }
  });
  await t.test('场景和风格多选增减、替换及清空互不覆盖', async () => {
    const original = await pair();
    assert.equal((await batch(original, { action: 'add-tags', parameters: { tagIds: [occasion2.id, style.id] } })).status, 200);
    const added = await Promise.all(original.map(item => read(item.id)));
    assert(added.every(item => item.tagIds.length === 3));
    assert.equal((await batch(added, { action: 'remove-tags', parameters: { tagIds: [occasion.id, occasion2.id] } })).status, 200);
    const removed = await Promise.all(original.map(item => read(item.id)));
    assert(removed.every(item => item.tagIds.length === 1 && item.tagIds[0] === style.id));
    assert.equal((await batch(removed, { action: 'replace-tags', parameters: { kind: 'occasion', tagIds: [occasion2.id] } })).status, 200);
    const replaced = await Promise.all(original.map(item => read(item.id)));
    for (const item of replaced) assert.deepEqual(item.tagIds.sort(), [style.id, occasion2.id].sort());
    assert.equal((await batch(replaced, { action: 'replace-tags', parameters: { kind: 'style', tagIds: [] } })).status, 200);
    for (const item of await Promise.all(original.map(item => read(item.id)))) assert.deepEqual(item.tagIds, [occasion2.id]);
  });
  await t.test('无效标签、归属、版本冲突和不同尺码组整批回滚', async () => {
    const items = await pair();
    assert.equal((await batch(items, { action: 'update-attributes', parameters: { brandId: foreignBrand.id } })).status, 422);
    assert.equal((await batch(items, { action: 'replace-tags', parameters: { kind: 'occasion', tagIds: [style.id] } })).status, 422);
    assert.equal((await batch(items, { action: 'remove-tags', parameters: { tagIds: [foreignTag.id] } })).status, 404);
    assert.equal((await batch(items, { action: 'update-attributes', parameters: {} })).status, 400);
    assert.equal((await batch(items, { action: 'update-attributes', parameters: { status: 'active' } })).status, 400);
    assert.equal((await batch([items[0], items[0]], { action: 'delete' })).status, 400);
    assert.equal((await request('POST', '/clothes/batch', { action: 'delete', items: items.map(item => ({ id: item.id, version: item.version })) }, tokenB)).status, 404);
    assert.equal((await batch([items[0], { ...items[1], version: 999 }], { action: 'update-attributes', parameters: { colors: ['red'] } })).status, 409);
    for (const item of items) assert.deepEqual(await read(item.id), item);
    await data(await call('PATCH', `/clothes/${items[1].id}`, { version: items[1].version, categoryId: shoes.id }), clothingSchema);
    const mixed = await Promise.all(items.map(item => read(item.id)));
    assert.equal((await batch(mixed, { action: 'update-attributes', parameters: { sizeId: size.id } })).status, 422);
    assert.deepEqual(await read(items[0].id), mixed[0]);
  });
  await t.test('排队与处理中禁止修改、单删和批删，整批回滚', async () => {
    for (const status of ['queued', 'running']) {
      const items = await pair();
      const job = (await pool.query<{ id: string }>("INSERT INTO image_jobs(user_id,input_asset_id,clothing_id,kind,status) VALUES($1,$2,$3,'process',$4) RETURNING id", [owner, asset, items[1].id, status])).rows[0].id;
      assert.equal((await batch(items, { action: 'update-attributes', parameters: { colors: ['red'] } })).status, 409);
      assert.equal((await batch(items, { action: 'delete' })).status, 409);
      assert.equal((await call('DELETE', `/clothes/${items[1].id}`)).status, 409);
      assert.deepEqual(await read(items[0].id), items[0]);
      await pool.query("UPDATE image_jobs SET status='failed' WHERE id=$1", [job]);
      assert.equal((await batch(items, { action: 'delete' })).status, 200);
      assert.equal((await call('GET', `/clothes/${items[0].id}`)).status, 404);
      assert.equal((await pool.query('SELECT clothing_id FROM image_jobs WHERE id=$1', [job])).rows[0].clothing_id, null);
    }
  });
  await t.test('引用阻止整批删除，版本冲突不部分删除，未核对可单删', async () => {
    const items = await pair();
    assert.equal((await batch([items[0], { ...items[1], version: 999 }], { action: 'delete' })).status, 409);
    assert.deepEqual(await read(items[0].id), items[0]);
    items[1] = await data(await call('PATCH', `/clothes/${items[1].id}`, { version: items[1].version, status: 'active' }), clothingSchema);
    const list = await data(await call('POST', '/packing-lists', { name: '批删引用测试', clothingIds: [items[1].id] }), packingSchema, 201);
    assert.equal((await batch(items, { action: 'delete' })).status, 409);
    assert.deepEqual(await read(items[0].id), items[0]);
    assert.equal((await call('DELETE', `/packing-lists/${list.id}`)).status, 204);
    assert.equal((await batch(items, { action: 'delete' })).status, 200);
    const draft = await data(await call('POST', '/clothes', { primaryAssetId: asset, status: 'draft' }), clothingSchema, 201);
    assert.equal((await call('DELETE', `/clothes/${draft.id}`)).status, 204);
    assert.equal((await call('GET', `/clothes/${draft.id}`)).status, 404);
  });
});

test('套装定位未完成：零单品可见、补充描述重试、幂等与历史状态修正', async t => {
  const { clothingImportDetailSchema, clothingImportSchema } = await import('../miniprogram/api/contracts.js');
  const tokenB = randomBytes(32).toString('base64url');
  const foreignOwner = (await pool.query<{ id: string }>('INSERT INTO users(wechat_openid) VALUES($1) RETURNING id', [randomUUID()])).rows[0].id;
  await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [foreignOwner, createHash('sha256').update(tokenB).digest('hex')]);
  t.after(async () => { await pool.query('DELETE FROM users WHERE id=$1', [foreignOwner]); });
  const token = randomBytes(32).toString('base64url');
  const owner = (await pool.query<{ id: string }>('INSERT INTO users(wechat_openid) VALUES($1) RETURNING id', [randomUUID()])).rows[0].id;
  await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [owner, createHash('sha256').update(token).digest('hex')]);
  const form = new FormData();
  form.set('purpose', 'clothing');
  form.set('file', new Blob([await sharp({ create: { width: 64, height: 64, channels: 3, background: '#999' } }).png().toBuffer()]), 'layered.png');
  const asset = await data(await fetch(`${base}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }), mediaSchema, 201);
  const targets = ['灰色开衫', '碎花连衣裙'].map(name => ({ name, description: name, box: { left: 0.1, top: 0.1, width: 0.8, height: 0.8 }, visibility: 'occluded' }));
  const fixture = { count: 1, calls: 0, prompts: Array<string>() };
  const provider = express().use(express.json({ limit: '2mb' })).post('/chat/completions', (req, res) => {
    const body = z.object({ reasoning_effort: z.literal('medium'), messages: z.tuple([z.object({ content: z.string() }), z.object({ content: z.tuple([z.object({ type: z.literal('text'), text: z.string() }), z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string() }) })]) })]) }).parse(req.body);
    assert(body.messages[0].content.includes('逐层检查外搭、内搭与下装'));
    assert(body.messages[0].content.includes('即使商品标题只写其中一件'));
    fixture.prompts.push(z.object({ userPrompt: z.string() }).parse(JSON.parse(body.messages[1].content[0].text)).userPrompt);
    fixture.calls++;
    res.json({ choices: [{ message: { content: JSON.stringify({ name: '开衫与连衣裙', targets: targets.slice(0, fixture.count) }) } }] });
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address(); assert(address && typeof address !== 'string');
  const previous = { url: config.NEW_API_BASE_URL, key: config.NEW_API_KEY };
  config.NEW_API_BASE_URL = `http://127.0.0.1:${address.port}`; config.NEW_API_KEY = 'local-protocol-fixture';
  t.after(async () => {
    config.NEW_API_BASE_URL = previous.url; config.NEW_API_KEY = previous.key;
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    await pool.query('DELETE FROM users WHERE id=$1', [owner]);
  });
  const started = await data(await request('POST', '/clothing-imports', { inputAssetId: asset.assetId, mode: 'set' }, token, randomUUID()), clothingImportDetailSchema, 202);
  await processNextImageJob();
  const failed = await data(await request('GET', `/clothing-imports/${started.id}`, undefined, token), clothingImportDetailSchema);
  assert.equal(failed.status, 'needs-attention'); assert.equal(failed.pending, false); assert.equal(failed.itemCount, 0);
  assert.equal(failed.jobs[0].status, 'failed'); assert.equal(failed.jobs[0].errorCode, 'DETECTION_INSUFFICIENT_ITEMS');
  assert.equal(failed.jobs[0].result?.detection?.targets.length, 1);
  assert.deepEqual((await data(await request('GET', '/clothing-imports?empty=true', undefined, token), z.array(clothingImportSchema))).map(item => item.id), [started.id]);
  assert(!(await data(await request('GET', '/clothing-imports?empty=true', undefined, tokenB), z.array(clothingImportSchema))).some(item => item.id === started.id));
  const path = `/clothing-imports/${started.id}/redetect`;
  assert.equal((await request('POST', path, { version: failed.version }, tokenB, randomUUID())).status, 404);
  assert.equal((await request('POST', path, { version: failed.version + 1 }, token, randomUUID())).status, 409);
  assert.equal((await request('POST', path, { version: failed.version, userPrompt: '字'.repeat(301) }, token, randomUUID())).status, 400);
  await pool.query("UPDATE image_jobs SET processing_state=jsonb_set(processing_state,'{detection,delivery}','\"unknown\"') WHERE id=$1", [failed.jobs[0].id]);
  const blocked = await request('POST', path, { version: failed.version }, token, randomUUID());
  assert.equal(blocked.status, 409); assert.equal(z.object({ error: z.object({ code: z.string() }) }).parse(await blocked.json()).error.code, 'PROVIDER_PENDING');
  await pool.query("UPDATE image_jobs SET processing_state=jsonb_set(processing_state,'{detection,delivery}','\"completed\"') WHERE id=$1", [failed.jobs[0].id]);
  const key = randomUUID();
  const retryInput = { version: failed.version, userPrompt: '  识别灰色开衫和里面的碎花连衣裙  ' };
  const retried = await Promise.all([request('POST', path, retryInput, token, key), request('POST', path, retryInput, token, key)]);
  const retry = await data(retried[0], clothingImportDetailSchema, 202);
  assert.deepEqual(await data(retried[1], clothingImportDetailSchema, 202), retry);
  assert.equal(retry.jobs.length, 2); assert.equal(retry.status, 'processing');
  assert.equal((await request('POST', path, { version: retry.version }, token, randomUUID())).status, 409);
  fixture.count = 0;
  await processNextImageJob();
  const empty = await data(await request('GET', `/clothing-imports/${started.id}`, undefined, token), clothingImportDetailSchema);
  assert.equal(empty.status, 'needs-attention'); assert.equal(empty.itemCount, 0); assert.equal(empty.jobs[1].result?.detection?.targets.length, 0);
  assert.deepEqual(fixture.prompts, ['', retryInput.userPrompt.trim()]);
  fixture.count = 2;
  await data(await request('POST', path, { version: empty.version }, token, randomUUID()), clothingImportDetailSchema, 202);
  await processNextImageJob();
  const recovered = await data(await request('GET', `/clothing-imports/${started.id}`, undefined, token), clothingImportDetailSchema);
  assert.equal(recovered.itemCount, 2); assert.equal(recovered.status, 'processing'); assert.equal(fixture.calls, 3);
  assert.equal((await data(await request('GET', '/clothing-imports?empty=true', undefined, token), z.array(clothingImportSchema))).length, 0);
  assert.equal((await request('POST', `/image-jobs/${failed.jobs[0].id}/retry`, {}, token, randomUUID())).status, 409);
  assert.equal((await request('POST', path, { version: recovered.version }, token, randomUUID())).status, 409);
  await data(await request('POST', `/clothing-imports/${started.id}/cancel`, undefined, token), clothingImportDetailSchema, 202);
  assert.equal((await request('POST', path, { version: recovered.version }, token, randomUUID())).status, 409);
  assert.equal((await data(await request('GET', '/clothing-imports?empty=true', undefined, token), z.array(clothingImportSchema))).length, 0);
  assert.equal((await pool.query('SELECT id FROM clothes WHERE user_id=$1', [owner])).rowCount, 0);

  const legacy = (await pool.query<{ id: string }>("INSERT INTO clothing_imports(user_id,input_asset_id,mode,status,name,save_as_set) VALUES($1,$2,'set','review','历史套装',true) RETURNING id", [owner, asset.assetId])).rows[0];
  const result = { detection: { name: '历史识别', targets: targets.slice(0, 1) } };
  const legacyJob = (await pool.query<{ id: string }>("INSERT INTO image_jobs(user_id,input_asset_id,kind,status,import_id,result,processing_state) VALUES($1,$2,'locate','succeeded',$3,$4,$5) RETURNING id", [owner, asset.assetId, legacy.id, JSON.stringify(result), JSON.stringify({ detection: { delivery: 'completed' } })])).rows[0];
  const migration = await readFile('server/migrations/V12__unfinished_clothing_imports.sql', 'utf8');
  await pool.query(migration);
  const fixed = await data(await request('GET', `/clothing-imports/${legacy.id}`, undefined, token), clothingImportDetailSchema);
  assert.equal(fixed.status, 'needs-attention'); assert.equal(fixed.version, 2); assert.equal(fixed.name, '历史套装'); assert.equal(fixed.inputAssetId, asset.assetId);
  assert.equal(fixed.jobs[0].status, 'failed'); assert.deepEqual(fixed.jobs[0].result, result);
  assert.deepEqual((await pool.query('SELECT processing_state FROM image_jobs WHERE id=$1', [legacyJob.id])).rows[0].processing_state, { detection: { delivery: 'completed' } });
  assert.equal((await data(await request('GET', `/clothing-imports/${started.id}`, undefined, token), clothingImportDetailSchema)).status, 'cancelled');
  await pool.query(migration);
  assert.deepEqual(await data(await request('GET', `/clothing-imports/${legacy.id}`, undefined, token), clothingImportDetailSchema), fixed);
  await migrate();
});

test('双图修补：底图与原图顺序、资料保留、归属、幂等及失败重试', async t => {
  const tokenB = randomBytes(32).toString('base64url');
  const foreignOwner = (await pool.query<{ id: string }>('INSERT INTO users(wechat_openid) VALUES($1) RETURNING id', [randomUUID()])).rows[0].id;
  await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [foreignOwner, createHash('sha256').update(tokenB).digest('hex')]);
  t.after(async () => { await pool.query('DELETE FROM users WHERE id=$1', [foreignOwner]); });
  const token = randomBytes(32).toString('base64url');
  const owner = (await pool.query<{ id: string }>('INSERT INTO users(wechat_openid) VALUES($1) RETURNING id', [randomUUID()])).rows[0].id;
  await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [owner, createHash('sha256').update(token).digest('hex')]);
  const category = await data(await request('POST', '/categories', { name: '修补连衣裙' }, token), categorySchema, 201);
  const form = new FormData();
  const original = await sharp({ create: { width: 96, height: 128, channels: 3, background: '#33445a' } }).png().toBuffer();
  form.set('purpose', 'clothing'); form.set('file', new Blob([original]), 'original.png');
  const asset = await data(await fetch(`${base}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }), mediaSchema, 201);
  const baseImage = await sharp(Buffer.from('<svg width="128" height="128"><rect x="30" y="25" width="68" height="90" fill="#33445a"/></svg>')).png().toBuffer();
  const output = await sharp(Buffer.from('<svg width="128" height="128"><rect x="30" y="25" width="68" height="90" fill="#33445a"/><rect x="32" y="10" width="8" height="20" fill="#33445a"/><rect x="88" y="10" width="8" height="20" fill="#33445a"/></svg>')).png().toBuffer();
  const editAssetId = randomUUID();
  await writeFile(join(testMedia, `${editAssetId}.png`), baseImage);
  await pool.query("INSERT INTO media_assets(id,user_id,kind,storage_key,mime_type,width,height,byte_size,parent_asset_id) VALUES($1,$2,'cutout',$3,'image/png',128,128,$4,$5)", [editAssetId, owner, `${editAssetId}.png`, baseImage.length, asset.assetId]);
  const clothing = await data(await request('POST', '/clothes', { name: '保留我的裙子名称', categoryId: category.id, primaryAssetId: editAssetId, itemType: '吊带连衣裙', colors: ['blue'], seasons: ['summer'], pattern: 'printed', visibleFeatures: ['碎花'], notes: '手动修改的备注' }, token), clothingSchema, 201);
  const suggestions = recognitionSchema.parse({ name: '旧识别名称', rootCategoryId: category.id, categoryId: category.id, subcategoryName: '吊带裙', itemType: '吊带裙', colorDescription: '蓝色', pattern: 'printed', visibleFeatures: ['碎花'], colors: ['blue'], seasons: ['summer'], styleTagIds: [], occasionTagIds: [], inputIssues: ['occluded'], cutoutReadiness: 'retake' });
  await pool.query("INSERT INTO image_jobs(user_id,input_asset_id,clothing_id,kind,status,result) VALUES($1,$2,$3,'process','succeeded',$4)", [owner, asset.assetId, clothing.id, JSON.stringify({ cutoutAssetId: editAssetId, suggestions, subcategoryReviewed: true })]);
  const fixture = { fail: true, opaque: false, calls: 0, recognition: 0, hints: Array<string>() };
  const multer = (await import('multer')).default;
  const provider = express().post('/images/edits', multer().array('image[]', 2), (req, res) => {
    const body = z.object({ prompt: z.string(), background: z.literal('transparent') }).parse(req.body);
    const files = z.array(z.object({ buffer: z.instanceof(Buffer), originalname: z.string() })).length(2).parse(req.files);
    assert.deepEqual(files.map(file => file.buffer), [baseImage, original]);
    assert(body.prompt.includes('图一是当前处理后的单品图'));
    assert(body.prompt.includes('图二是原始照片'));
    assert(!body.prompt.includes('分割遮罩'));
    fixture.hints.push(body.prompt.split('用户修补意见：')[1]);
    fixture.calls++;
    if (fixture.fail) { res.status(503).json({ error: 'temporary' }); return; }
    if (fixture.opaque) { res.json({ data: [{ b64_json: original.toString('base64') }] }); return; }
    res.json({ data: [{ b64_json: output.toString('base64') }] });
  }).post('/chat/completions', (_req, res) => { fixture.recognition++; res.status(500).end(); }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address(); assert(address && typeof address !== 'string');
  const previous = { url: config.NEW_API_BASE_URL, key: config.NEW_API_KEY };
  config.NEW_API_BASE_URL = `http://127.0.0.1:${address.port}`; config.NEW_API_KEY = 'local-protocol-fixture';
  t.after(async () => {
    config.NEW_API_BASE_URL = previous.url; config.NEW_API_KEY = previous.key;
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    await pool.query('DELETE FROM image_jobs WHERE user_id=$1', [owner]);
    await pool.query('DELETE FROM clothes WHERE user_id=$1', [owner]);
    await pool.query('DELETE FROM users WHERE id=$1', [owner]);
  });
  const input = { inputAssetId: asset.assetId, clothingId: clothing.id, kind: 'cutout', editAssetId, userPrompt: '  仅补齐两根细肩带，衣身不变  ' };
  for (const invalid of [{ ...input, userPrompt: '   ' }, { ...input, editAssetId: asset.assetId }, { ...input, kind: 'process' }, { ...input, refreshRecognition: true }, { ...input, clothingId: undefined }]) {
    assert.equal((await request('POST', '/image-jobs', invalid, token, randomUUID())).status, 400);
  }
  assert.equal((await request('POST', '/image-jobs', input, tokenB, randomUUID())).status, 404);
  const unrelated = await data(await request('POST', '/clothes', { name: '其他衣物', categoryId: category.id, primaryAssetId: asset.assetId }, token), clothingSchema, 201);
  assert.equal((await request('POST', '/image-jobs', { ...input, clothingId: unrelated.id }, token, randomUUID())).status, 422);
  form.set('file', new Blob([original]), 'other-original.png');
  const otherAsset = await data(await fetch(`${base}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }), mediaSchema, 201);
  assert.equal((await request('POST', '/image-jobs', { ...input, inputAssetId: otherAsset.assetId }, token, randomUUID())).status, 422);
  const key = randomUUID();
  const started = await data(await request('POST', '/image-jobs', input, token, key), jobSchema, 202);
  assert.equal(started.editAssetId, editAssetId); assert.equal(started.userPrompt, input.userPrompt.trim());
  assert.deepEqual(await data(await request('POST', '/image-jobs', input, token, key), jobSchema, 202), started);
  assert.equal((await request('POST', '/image-jobs', { ...input, userPrompt: '另一条意见' }, token, randomUUID())).status, 409);
  await processNextImageJob();
  const failed = await data(await request('GET', `/image-jobs/${started.id}`, undefined, token), jobSchema);
  assert.equal(failed.status, 'failed'); assert.equal(failed.result?.canRetry, true); assert.equal(failed.result?.steps?.recognition.skipReason, 'not-requested');
  assert.deepEqual(await data(await request('GET', `/clothes/${clothing.id}`, undefined, token), clothingSchema), { ...clothing, processingJobId: failed.id, processingStatus: failed.status, processingPhase: failed.phase });
  fixture.fail = false;
  const retry = await data(await request('POST', `/image-jobs/${failed.id}/retry`, {}, token, randomUUID()), jobSchema, 202);
  assert.equal(retry.editAssetId, editAssetId);
  await processNextImageJob();
  const completed = await data(await request('GET', `/image-jobs/${retry.id}`, undefined, token), jobSchema);
  assert.equal(completed.status, 'succeeded'); assert.equal(completed.result?.outcome, 'complete'); assert.equal(completed.result?.steps?.recognition.status, 'skipped');
  assert.deepEqual(completed.result?.suggestions, suggestions); assert.equal(completed.result?.subcategoryReviewed, true); assert(completed.result?.cutoutAssetId);
  const updated = await data(await request('GET', `/clothes/${clothing.id}`, undefined, token), clothingSchema);
  assert.deepEqual(updated, { ...clothing, updatedAt: updated.updatedAt, version: clothing.version + 1, primaryAssetId: completed.result.cutoutAssetId, processingJobId: completed.id, processingStatus: completed.status, processingPhase: completed.phase });
  assert.equal(fixture.calls, 2); assert.equal(fixture.recognition, 0); assert.deepEqual(fixture.hints, [JSON.stringify({ userPrompt: input.userPrompt.trim() }), JSON.stringify({ userPrompt: input.userPrompt.trim() })]);
  assert.equal((await data(await request('POST', '/image-jobs', input, token, key), jobSchema, 202)).id, started.id);
  assert.equal(fixture.calls, 2);
  await pool.query("UPDATE media_assets SET created_at=now()-interval '2 days' WHERE id=$1", [editAssetId]);
  await maintenance();
  assert.equal((await pool.query('SELECT id FROM media_assets WHERE id=$1', [editAssetId])).rowCount, 1);
  fixture.opaque = true;
  const opaque = await data(await request('POST', '/image-jobs', input, token, randomUUID()), jobSchema, 202);
  await processNextImageJob();
  const badOutput = await data(await request('GET', `/image-jobs/${opaque.id}`, undefined, token), jobSchema);
  assert.equal(badOutput.status, 'failed'); assert.equal(badOutput.result?.steps?.cutout.errorCode, 'INVALID_TRANSPARENCY');
  assert.equal((await data(await request('GET', `/clothes/${clothing.id}`, undefined, token), clothingSchema)).primaryAssetId, updated.primaryAssetId);
});

test('多件录入与套装：延迟启动、并行阶段、部分重试、确认事务及双向归属', async t => {
  const tokenB = randomBytes(32).toString('base64url');
  const foreignOwner = (await pool.query<{ id: string }>('INSERT INTO users(wechat_openid) VALUES($1) RETURNING id', [randomUUID()])).rows[0].id;
  await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [foreignOwner, createHash('sha256').update(tokenB).digest('hex')]);
  const token = randomBytes(32).toString('base64url');
  const owner = (await pool.query<{ id: string }>('INSERT INTO users(wechat_openid) VALUES($1) RETURNING id', [randomUUID()])).rows[0].id;
  await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [owner, createHash('sha256').update(token).digest('hex')]);
  const { clothingImportDetailSchema, clothingSetSchema } = await import('../miniprogram/api/contracts.js');
  const top = await data(await request('POST', '/categories', { name: '套装测试上衣' }, token), categorySchema, 201);
  const other = await data(await request('POST', '/categories', { name: '套装测试裤子' }, tokenB), categorySchema, 201);
  const form = new FormData();
  form.set('purpose', 'clothing');
  const source = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#345678' } }).png().toBuffer();
  form.set('file', new Blob([source]), 'set.png');
  const asset = await data(await fetch(`${base}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }), mediaSchema, 201);
  assert.equal((await pool.query('SELECT id FROM image_jobs WHERE user_id=$1', [owner])).rows.length, 0);
  assert.equal((await pool.query('SELECT id FROM clothes WHERE user_id=$1', [owner])).rows.length, 0);
  const target = (name: string, left: number) => ({ name, description: `${name}，仅可见衣料`, box: { left, top: 0.1, width: 0.4, height: 0.8 }, visibility: 'occluded' });
  const fixture = { active: 0, peak: 0, recognition: 0, cutout: 0, covers: 0, detection: 0, failHint: true, failHintImage: false, inputs: Array<{ userPrompt: string; hasTarget: boolean; imageCount: number }>(), prompts: Array<string>(), failInner: true, failCover: true, cancelImportId: '', replaceCoverImportId: '', replacementAssetId: '', cancelCoverImportId: '', targets: Array<string | undefined>() };
  const mask = await sharp(Buffer.from('<svg width="1024" height="1024"><rect width="1024" height="1024" fill="black"/><rect x="200" y="150" width="450" height="600" fill="white"/></svg>')).png().toBuffer();
  const generated = await sharp(Buffer.from('<svg width="64" height="64"><rect x="12" y="8" width="40" height="48" fill="#a15b72"/></svg>')).png().toBuffer();
  const multer = (await import('multer')).default;
  const providerApp = express().use(express.json({ limit: '10mb' }));
  providerApp.post('/chat/completions', async (req, res) => {
    const body = z.object({ reasoning_effort: z.literal('medium'), max_completion_tokens: z.number(), messages: z.array(z.object({ content: z.unknown() })) }).parse(req.body);
    const system = z.string().parse(body.messages[0].content);
    if (fixture.cancelImportId) {
      const id = fixture.cancelImportId;
      fixture.cancelImportId = '';
      await data(await request('POST', `/clothing-imports/${id}/cancel`, undefined, token), clothingImportDetailSchema, 202);
    }
    if (system.includes('套装') && system.includes('targets')) {
      fixture.detection++;
      res.json({ choices: [{ message: { content: JSON.stringify({ name: '蓝灰两件套', targets: [target('开衫', 0.05), target('背心', 0.5)] }) } }] });
      return;
    }
    const content = z.array(z.object({ text: z.string().optional() }).passthrough()).parse(body.messages[1].content);
    const context = z.object({ userPrompt: z.string(), target: z.object({ name: z.string() }).optional(), allowedCategories: z.array(z.object({ id: z.string() })) }).parse(JSON.parse(content[0].text!));
    fixture.targets.push(context.target?.name);
    fixture.inputs.push({ userPrompt: context.userPrompt, hasTarget: Boolean(context.target), imageCount: content.length - 1 });
    assert(system.includes('它不是已证实的衣物属性'));
    assert(context.allowedCategories.some(item => item.id === top.id));
    assert(!context.allowedCategories.some(item => item.id === other.id));
    fixture.active++; fixture.recognition++; fixture.peak = Math.max(fixture.peak, fixture.active);
    await new Promise(resolve => setTimeout(resolve, 60));
    fixture.active--;
    if (context.userPrompt && fixture.failHint || context.target?.name === '背心' && fixture.failInner) { res.status(503).json({ error: 'temporary' }); return; }
    res.json({ choices: [{ message: { content: JSON.stringify({ name: context.userPrompt ? '提示定位的背心' : context.target?.name || '单品', rootCategoryId: top.id, categoryId: top.id, subcategoryName: null, itemType: '针织衫', colorDescription: '蓝灰', pattern: 'solid', visibleFeatures: ['纽扣'], colors: ['blue'], seasons: ['autumn'], styleTagIds: [], occasionTagIds: [], inputIssues: ['occluded'], cutoutReadiness: 'needs-review' }) } }] });
  });
  providerApp.post('/images/edits', multer().single('image'), async (req, res) => {
    const body = z.object({ prompt: z.string(), background: z.string() }).parse(req.body);
    fixture.prompts.push(body.prompt);
    const isCover = body.prompt.includes('整套透明展示图');
    const isMask = body.prompt.includes('分割遮罩');
    assert(isMask || isCover || body.prompt.includes('合理补全指定单品'));
    assert.equal(body.background, isMask ? 'opaque' : 'transparent');
    if (isCover) {
      fixture.covers++;
      assert(body.prompt.includes('开衫') && body.prompt.includes('背心'));
      if (fixture.replaceCoverImportId) {
        const record = await data(await request('GET', `/clothing-imports/${fixture.replaceCoverImportId}`, undefined, token), clothingImportDetailSchema);
        await data(await request('PATCH', `/clothing-imports/${record.id}`, { version: record.version, name: '手动修改名称', saveAsSet: true, coverAssetId: fixture.replacementAssetId, items: record.items.map(item => ({ id: item.id, included: item.included })) }, token), clothingImportDetailSchema);
        fixture.replaceCoverImportId = '';
      }
      if (fixture.cancelCoverImportId) {
        await data(await request('POST', `/clothing-imports/${fixture.cancelCoverImportId}/cancel`, undefined, token), clothingImportDetailSchema, 202);
        fixture.cancelCoverImportId = '';
      }
    }
    fixture.active++; fixture.cutout++; fixture.peak = Math.max(fixture.peak, fixture.active);
    await new Promise(resolve => setTimeout(resolve, 60)); fixture.active--;
    if (isCover && fixture.failCover || body.prompt.includes('userPrompt') && fixture.failHintImage) { res.status(503).json({ error: 'temporary' }); return; }
    res.json({ data: [{ b64_json: (isMask ? mask : generated).toString('base64') }] });
  });
  const provider = providerApp.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address(); assert(address && typeof address !== 'string');
  const previous = { url: config.NEW_API_BASE_URL, key: config.NEW_API_KEY };
  config.NEW_API_BASE_URL = `http://127.0.0.1:${address.port}`; config.NEW_API_KEY = 'local-protocol-fixture';
  t.after(async () => {
    config.NEW_API_BASE_URL = previous.url; config.NEW_API_KEY = previous.key;
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    await request('DELETE', '/me', { confirmation: 'DELETE_MY_ACCOUNT' }, token);
    await maintenance();
    assert.equal((await pool.query('SELECT id FROM users WHERE id=$1', [owner])).rows.length, 0);
    await pool.query('DELETE FROM categories WHERE id=$1', [other.id]);
  });
  const importKey = randomUUID();
  const started = await data(await request('POST', '/clothing-imports', { inputAssetId: asset.assetId, mode: 'set' }, token, importKey), clothingImportDetailSchema, 202);
  assert.equal(started.items.length, 0); assert(started.pending); assert.equal(fixture.detection, 0);
  assert.deepEqual(await data(await request('POST', '/clothing-imports', { inputAssetId: asset.assetId, mode: 'set' }, token, importKey), clothingImportDetailSchema, 202), started);
  assert.equal((await request('GET', `/clothing-imports/${started.id}`, undefined, tokenB)).status, 404);
  assert.equal((await request('POST', '/clothing-imports', { inputAssetId: asset.assetId, mode: 'single' }, tokenB, randomUUID())).status, 404);
  await processNextImageJob();
  const located = await data(await request('GET', `/clothing-imports/${started.id}`, undefined, token), clothingImportDetailSchema);
  assert.equal(located.items.length, 2); assert.equal(fixture.detection, 1);
  assert.equal(located.jobs.filter(job => job.kind === 'set-cover').length, 1);
  assert.equal((await request('POST', `/clothing-imports/${started.id}/confirm`, { version: located.version, items: located.items.map(item => ({ id: item.clothing!.id, version: item.clothing!.version })) }, token, randomUUID())).status, 409);
  await processNextImageJob();
  const processed = await data(await request('GET', `/clothing-imports/${started.id}`, undefined, token), clothingImportDetailSchema);
  assert.equal(processed.pending, false); assert.equal(processed.status, 'review');
  assert.equal(fixture.recognition, 2); assert.equal(fixture.cutout, 3); assert.equal(fixture.covers, 1); assert(fixture.peak >= 5, `并发请求峰值 ${fixture.peak}`);
  const failedCover = processed.jobs.find(job => job.kind === 'set-cover')!;
  assert.equal(failedCover.status, 'failed'); assert.equal(failedCover.result?.canRetry, true);
  assert.equal(processed.coverAssetId, asset.assetId);
  const ids = processed.items.map(item => item.clothing!.id);
  const partial = processed.jobs.find(job => job.result?.outcome === 'partial'); assert(partial?.result?.cutoutAssetId, JSON.stringify(processed.jobs));
  assert.equal(partial.result.steps?.recognition.status, 'failed'); assert.equal(partial.result.steps?.cutout.status, 'succeeded');
  const outputAsset = (await pool.query<{ storage_key: string }>('SELECT storage_key FROM media_assets WHERE id=$1', [partial.result.cutoutAssetId])).rows[0];
  const pixels = await sharp(join(testMedia, outputAsset.storage_key)).raw().toBuffer({ resolveWithObject: true });
  assert.equal(pixels.info.width, 1024); assert.equal(pixels.info.height, 1024);
  assert(pixels.data.some((value, index) => index % 4 === 3 && value === 0));
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    if (pixels.data[offset + 3] < 250) continue;
    assert(Math.abs(pixels.data[offset] - 0xa1) <= 1); assert(Math.abs(pixels.data[offset + 1] - 0x5b) <= 1); assert(Math.abs(pixels.data[offset + 2] - 0x72) <= 1);
  }
  const manual = await data(await request('PATCH', `/clothes/${partial.clothingId}`, { version: processed.items.find(item => item.clothing!.id === partial.clothingId)!.clothing!.version, name: '手动命名背心' }, token), clothingSchema);
  fixture.failInner = false;
  await data(await request('POST', `/image-jobs/${partial.id}/retry`, {}, token, randomUUID()), jobSchema, 202);
  await processNextImageJob();
  assert.equal(fixture.cutout, 3); assert.equal(fixture.recognition, 3);
  fixture.failCover = false;
  await data(await request('POST', `/image-jobs/${failedCover.id}/retry`, {}, token, randomUUID()), jobSchema, 202);
  await processNextImageJob();
  assert.equal(fixture.cutout, 4); assert.equal(fixture.covers, 2); assert.equal(fixture.recognition, 3);
  const withCover = await data(await request('GET', `/clothing-imports/${started.id}`, undefined, token), clothingImportDetailSchema);
  const completedCover = [...withCover.jobs].reverse().find(job => job.kind === 'set-cover')!;
  assert.equal(completedCover.status, 'succeeded'); assert.equal(completedCover.result?.steps?.recognition.status, 'skipped');
  assert.equal(withCover.coverAssetId, completedCover.result?.cutoutAssetId);
  assert.notEqual(withCover.coverAssetId, asset.assetId);
  const hint = '只识别里面的深灰色背心，排除外面的开衫';
  await pool.query("UPDATE clothing_import_items SET target=jsonb_set(target,'{visibility}','\"retake\"') WHERE id=$1", [partial.importItemId]);
  const hintedInput = { inputAssetId: asset.assetId, clothingId: manual.id, kind: 'process', refreshRecognition: true, userPrompt: `  ${hint}  ` };
  assert.equal((await request('POST', '/image-jobs', { ...hintedInput, userPrompt: '字'.repeat(301) }, token, randomUUID())).status, 400);
  assert.equal((await request('POST', '/image-jobs', { ...hintedInput, kind: 'cutout' }, token, randomUUID())).status, 400);
  assert.equal((await request('POST', '/image-jobs', hintedInput, tokenB, randomUUID())).status, 404);
  const hintKey = randomUUID();
  const hinted = await data(await request('POST', '/image-jobs', hintedInput, token, hintKey), jobSchema, 202);
  assert.equal(hinted.userPrompt, hint);
  assert.equal(hinted.matchesPrimaryAsset, true);
  assert.equal((await data(await request('POST', '/image-jobs', hintedInput, token, hintKey), jobSchema, 202)).id, hinted.id);
  assert.equal((await data(await request('POST', '/image-jobs', hintedInput, token, randomUUID()), jobSchema, 202)).id, hinted.id);
  assert.equal((await request('POST', '/image-jobs', { ...hintedInput, userPrompt: '改为外套' }, token, hintKey)).status, 409);
  assert.equal((await request('POST', '/image-jobs', { ...hintedInput, userPrompt: '改为外套' }, token, randomUUID())).status, 409);
  const beforeHint = { recognition: fixture.recognition, cutout: fixture.cutout };
  await processNextImageJob();
  const hintPartial = await data(await request('GET', `/image-jobs/${hinted.id}`, undefined, token), jobSchema);
  assert.equal(hintPartial.result?.steps?.recognition.status, 'failed');
  assert.equal(hintPartial.result?.steps?.cutout.status, 'succeeded', '补充描述覆盖旧目标的补拍判断');
  assert.deepEqual(fixture.inputs.at(-1), { userPrompt: hint, hasTarget: false, imageCount: 1 });
  assert(fixture.prompts.at(-1)!.includes(JSON.stringify({ userPrompt: hint })));
  assert(!fixture.prompts.at(-1)!.includes('"box"'), '新线索不沿用旧目标框');
  fixture.failHint = false;
  const hintRetry = await data(await request('POST', `/image-jobs/${hinted.id}/retry`, {}, token, randomUUID()), jobSchema, 202);
  assert.equal(hintRetry.userPrompt, hint);
  await processNextImageJob();
  assert.equal(fixture.recognition, beforeHint.recognition + 2);
  assert.equal(fixture.cutout, beforeHint.cutout + 1, '重试识别复用已成功单品图');
  assert.equal((await data(await request('GET', `/clothes/${manual.id}`, undefined, token), clothingSchema)).name, '提示定位的背心', '主动重识别回填套装成员资料');
  fixture.failHintImage = true;
  const changedHint = await data(await request('POST', '/image-jobs', { ...hintedInput, userPrompt: `${hint}，优先看领口` }, token, randomUUID()), jobSchema, 202);
  await processNextImageJob();
  const changedPartial = await data(await request('GET', `/image-jobs/${changedHint.id}`, undefined, token), jobSchema);
  assert.equal(changedPartial.result?.steps?.recognition.status, 'succeeded');
  assert.equal(changedPartial.result?.steps?.cutout.status, 'failed');
  assert.equal(changedPartial.matchesPrimaryAsset, true, '图片失败后，旧处理图仍可关联真实原图');
  assert.equal(changedPartial.userPrompt, `${hint}，优先看领口`);
  assert.equal(fixture.recognition, beforeHint.recognition + 3);
  assert.equal(fixture.cutout, beforeHint.cutout + 2, '修改描述后重新调用两个阶段');
  fixture.failHintImage = false;
  await data(await request('POST', `/image-jobs/${changedHint.id}/retry`, {}, token, randomUUID()), jobSchema, 202);
  await processNextImageJob();
  assert.equal(fixture.recognition, beforeHint.recognition + 3, '重试图片不重复识别');
  assert.equal(fixture.cutout, beforeHint.cutout + 3);
  const hintedClothing = await data(await request('GET', `/clothes/${manual.id}`, undefined, token), clothingSchema);
  await data(await request('PATCH', `/clothes/${manual.id}`, { version: hintedClothing.version, name: '手动命名背心' }, token), clothingSchema);
  const retriedBeforePhoto = await data(await request('GET', `/clothing-imports/${started.id}`, undefined, token), clothingImportDetailSchema);
  const extraPhotoForm = new FormData(); extraPhotoForm.set('purpose', 'clothing'); extraPhotoForm.set('file', new Blob([source]), 'supplement.png');
  const extraPhoto = await data(await fetch(`${base}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: extraPhotoForm }), mediaSchema, 201);
  await data(await request('PATCH', `/clothes/${manual.id}`, { version: retriedBeforePhoto.items.find(item => item.clothing!.id === manual.id)!.clothing!.version, primaryAssetId: extraPhoto.assetId }, token), clothingSchema);
  const reprocessKey = randomUUID();
  const reprocessBody = { inputAssetId: extraPhoto.assetId, clothingId: manual.id, kind: 'process' };
  const reprocess = await data(await request('POST', '/image-jobs', reprocessBody, token, reprocessKey), jobSchema, 202);
  assert.equal(reprocess.importId, started.id); assert.equal(reprocess.importItemId, partial.importItemId);
  assert.equal((await data(await request('POST', '/image-jobs', reprocessBody, token, reprocessKey), jobSchema, 202)).id, reprocess.id);
  const pendingPhoto = await data(await request('GET', `/clothing-imports/${started.id}`, undefined, token), clothingImportDetailSchema);
  assert(pendingPhoto.pending); assert.equal(pendingPhoto.status, 'processing');
  assert.equal((await request('POST', `/clothing-imports/${started.id}/confirm`, { version: pendingPhoto.version, items: pendingPhoto.items.map(item => ({ id: item.clothing!.id, version: item.clothing!.version })) }, token, randomUUID())).status, 409);
  await processNextImageJob();
  assert.equal(fixture.targets.at(-1), undefined, '补拍必须识别新照片，不能沿用旧图目标区域');
  const retried = await data(await request('GET', `/clothing-imports/${started.id}`, undefined, token), clothingImportDetailSchema);
  assert.equal(retried.pending, false);
  assert.equal(retried.jobs.find(job => job.id === reprocess.id)!.result!.steps!.cutout.status, 'succeeded');
  assert.deepEqual(retried.items.map(item => item.clothing!.id), ids);
  // Classification was never applied in the failed first attempt, so preserve edits made before retry too.
  assert.equal(retried.items.find(item => item.clothing!.id === manual.id)!.clothing!.name, '手动命名背心');
  assert.equal((await request('PATCH', `/clothes/${ids[0]}`, { version: retried.items[0].clothing!.version, status: 'active' }, token)).status, 409);
  const invalid = await data(await request('PATCH', `/clothes/${ids[1]}`, { version: retried.items[1].clothing!.version, categoryId: null }, token), clothingSchema);
  const badConfirm = { version: retried.version, items: [{ id: ids[0], version: retried.items[0].clothing!.version }, { id: ids[1], version: invalid.version }] };
  assert.equal((await request('POST', `/clothing-imports/${started.id}/confirm`, badConfirm, token, randomUUID())).status, 400);
  assert.equal((await data(await request('GET', `/clothes/${ids[0]}`, undefined, token), clothingSchema)).status, 'draft');
  await data(await request('PATCH', `/clothes/${ids[1]}`, { version: invalid.version, categoryId: top.id }, token), clothingSchema);
  const ready = await data(await request('GET', `/clothing-imports/${started.id}`, undefined, token), clothingImportDetailSchema);
  const confirmKey = randomUUID();
  const confirmInput = { version: ready.version, items: ready.items.map(item => ({ id: item.clothing!.id, version: item.clothing!.version })) };
  const confirmed = await data(await request('POST', `/clothing-imports/${ready.id}/confirm`, confirmInput, token, confirmKey), clothingImportDetailSchema);
  assert.equal(confirmed.status, 'confirmed');
  assert.deepEqual(await data(await request('POST', `/clothing-imports/${ready.id}/confirm`, confirmInput, token, confirmKey), clothingImportDetailSchema), confirmed);
  const set = (await data(await request('GET', '/clothing-sets', undefined, token), z.array(clothingSetSchema)))[0];
  assert.equal(set.coverAssetId, completedCover.result?.cutoutAssetId); assert.equal(set.memberCount, 2);
  assert.equal((await request('GET', `/clothing-sets/${set.id}`, undefined, tokenB)).status, 404);
  const member = await data(await request('GET', `/clothes/${ids[0]}`, undefined, token), clothingSchema);
  assert.equal(member.clothingSet?.id, set.id); assert.equal(member.clothingSet?.members[0].id, ids[1]); assert.equal(member.importId, null);
  const renamed = await data(await request('PATCH', `/clothing-sets/${set.id}`, { version: set.version, name: '审核后的两件套', coverAssetId: asset.assetId, memberIds: ids }, token), clothingSetSchema);
  assert(renamed.version > set.version);
  assert.equal((await request('PATCH', `/clothing-sets/${set.id}`, { version: set.version, name: '旧版本', coverAssetId: asset.assetId, memberIds: ids }, token)).status, 409);
  assert.equal((await request('PATCH', `/clothing-sets/${set.id}`, { version: renamed.version, name: '越权', coverAssetId: null, memberIds: ids }, tokenB)).status, 404);
  assert.equal((await request('DELETE', `/clothes/${ids[0]}`, undefined, token)).status, 204);
  assert.equal((await request('GET', `/clothing-sets/${set.id}`, undefined, token)).status, 404);
  assert.equal((await data(await request('GET', `/clothes/${ids[1]}`, undefined, token), clothingSchema)).setId, null);
  const extra = await data(await request('POST', '/clothes', { name: '关联单品甲', categoryId: top.id, primaryAssetId: asset.assetId }, token, randomUUID()), clothingSchema, 201);
  const extraB = await data(await request('POST', '/clothes', { name: '关联单品乙', categoryId: top.id, primaryAssetId: asset.assetId }, token, randomUUID()), clothingSchema, 201);
  const manualSet = await data(await request('POST', '/clothing-sets', { name: '手动组合', coverAssetId: null, memberIds: [ids[1], extra.id] }, token), clothingSetSchema, 201);
  const replacedCover = await data(await request('PATCH', `/clothing-sets/${manualSet.id}`, { version: manualSet.version, name: manualSet.name, coverAssetId: extraPhoto.assetId, memberIds: [ids[1], extra.id] }, token), clothingSetSchema);
  const currentExtra = await data(await request('GET', `/clothes/${extra.id}`, undefined, token), clothingSchema);
  const archivedExtra = await data(await request('PATCH', `/clothes/${extra.id}`, { version: currentExtra.version, status: 'archived', primaryAssetId: extraPhoto.assetId }, token), clothingSchema);
  const retained = await data(await request('GET', `/clothing-sets/${manualSet.id}`, undefined, token), clothingSetSchema);
  assert.equal(retained.coverAssetId, replacedCover.coverAssetId); assert.equal(retained.members.find(item => item.id === extra.id)!.status, 'archived');
  await data(await request('PATCH', `/clothing-sets/${manualSet.id}`, { version: retained.version, name: retained.name, coverAssetId: retained.coverAssetId, memberIds: [ids[1], extra.id] }, token), clothingSetSchema);
  const moveInput = { name: '移动后的套装', coverAssetId: asset.assetId, memberIds: [ids[1], extraB.id] };
  assert.equal((await request('POST', '/clothing-sets', moveInput, token)).status, 409);
  const moved = await data(await request('POST', '/clothing-sets', { ...moveInput, moveMembers: true }, token), clothingSetSchema, 201);
  assert.equal((await request('GET', `/clothing-sets/${manualSet.id}`, undefined, token)).status, 404);
  assert.equal((await data(await request('GET', `/clothes/${extra.id}`, undefined, token), clothingSchema)).setId, null);
  assert.equal((await request('DELETE', `/clothing-sets/${moved.id}`, undefined, token)).status, 204);
  assert.equal((await data(await request('GET', `/clothes/${extra.id}`, undefined, token), clothingSchema)).status, archivedExtra.status);
  assert.equal((await data(await request('GET', `/clothes/${extraB.id}`, undefined, token), clothingSchema)).setId, null);
  await pool.query("UPDATE media_assets SET created_at=now()-interval '2 days' WHERE user_id=$1", [owner]);
  await maintenance();
  assert.equal((await pool.query('SELECT id FROM media_assets WHERE id=$1', [asset.assetId])).rows.length, 1);
  for (const scenario of ['replace-cover', 'cancel-cover']) {
    const record = await data(await request('POST', '/clothing-imports', { inputAssetId: asset.assetId, mode: 'set' }, token, randomUUID()), clothingImportDetailSchema, 202);
    await processNextImageJob();
    fixture.replaceCoverImportId = scenario === 'replace-cover' ? record.id : '';
    fixture.replacementAssetId = extraPhoto.assetId;
    fixture.cancelCoverImportId = scenario === 'cancel-cover' ? record.id : '';
    await processNextImageJob();
    const result = await data(await request('GET', `/clothing-imports/${record.id}`, undefined, token), clothingImportDetailSchema);
    assert.equal(result.pending, false);
    if (scenario === 'replace-cover') {
      assert.equal(result.coverAssetId, extraPhoto.assetId); assert.equal(result.name, '手动修改名称');
      await data(await request('POST', `/clothing-imports/${record.id}/cancel`, undefined, token), clothingImportDetailSchema, 202);
    }
    if (scenario === 'cancel-cover') {
      assert.equal(result.status, 'cancelled'); assert.equal(result.coverAssetId, asset.assetId);
      assert(result.items.every(item => item.clothing === null));
      assert(result.jobs.every(job => job.status !== 'running' && job.status !== 'queued'));
    }
  }
  const singleEdit = await data(await request('POST', '/clothing-imports', { inputAssetId: asset.assetId, mode: 'single' }, token, randomUUID()), clothingImportDetailSchema, 202);
  const singleDraft = singleEdit.items[0].clothing!;
  assert(singleDraft.singleImport);
  assert.equal((await request('PATCH', `/clothes/${singleDraft.id}`, { version: singleDraft.version, categoryId: top.id, status: 'active' }, token)).status, 409);
  assert.equal((await data(await request('GET', `/clothing-imports/${singleEdit.id}`, undefined, token), clothingImportDetailSchema)).status, 'queued');
  await processNextImageJob();
  const singleHint = await data(await request('POST', '/image-jobs', { inputAssetId: asset.assetId, clothingId: singleDraft.id, kind: 'process', userPrompt: hint, refreshRecognition: true }, token, randomUUID()), jobSchema, 202);
  await processNextImageJob();
  const singleHintResult = await data(await request('GET', `/image-jobs/${singleHint.id}`, undefined, token), jobSchema);
  assert.equal(singleHintResult.result?.outcome, 'complete');
  assert(fixture.prompts.at(-1)!.includes('分割遮罩') && fixture.prompts.at(-1)!.includes(hint), '单件遮罩同样使用补充描述');
  const singleReady = await data(await request('GET', `/clothes/${singleDraft.id}`, undefined, token), clothingSchema);
  assert.equal((await request('PATCH', `/clothes/${singleReady.id}`, { version: singleReady.version, categoryId: other.id, status: 'active' }, token)).status, 404);
  assert.equal((await data(await request('GET', `/clothing-imports/${singleEdit.id}`, undefined, token), clothingImportDetailSchema)).status, 'review');
  const singleSaved = await data(await request('PATCH', `/clothes/${singleReady.id}`, { version: singleReady.version, name: '直接确认的单件', categoryId: top.id, newSubcategory: { parentId: top.id, name: '单件独立品类' }, status: 'active' }, token), clothingSchema);
  assert.equal(singleSaved.status, 'active'); assert.equal(singleSaved.importId, null); assert.equal(singleSaved.singleImport, false); assert.equal(singleSaved.setId, null);
  assert.equal(singleSaved.categoryName, '套装测试上衣 / 单件独立品类');
  assert.equal((await data(await request('GET', `/clothing-imports/${singleEdit.id}`, undefined, token), clothingImportDetailSchema)).status, 'confirmed');
  assert.equal((await request('PATCH', `/clothes/${singleSaved.id}`, { version: singleSaved.version, name: '越权保存' }, tokenB)).status, 404);
  const single = await data(await request('POST', '/clothing-imports', { inputAssetId: asset.assetId, mode: 'single' }, token, randomUUID()), clothingImportDetailSchema, 202);
  assert.equal(single.items.length, 1); assert.equal(single.jobs[0].kind, 'process');
  const calls = fixture.recognition + fixture.cutout + fixture.detection;
  assert.equal((await request('POST', `/clothing-imports/${single.id}/cancel`, undefined, tokenB)).status, 404);
  assert.equal((await request('GET', `/clothes/${single.items[0].clothing!.id}`, undefined, token)).status, 200);
  const cancelled = await data(await request('POST', `/clothing-imports/${single.id}/cancel`, undefined, token), clothingImportDetailSchema, 202);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.pending, false);
  assert(cancelled.items.every(item => item.clothing === null));
  assert(cancelled.jobs.every(job => job.status === 'cancelled'));
  assert.equal((await request('GET', `/clothes/${single.items[0].clothing!.id}`, undefined, token)).status, 404);
  await data(await request('POST', `/clothing-imports/${single.id}/cancel`, undefined, token), clothingImportDetailSchema, 202);
  assert.equal(await processNextImageJob(), false);
  assert.equal(fixture.recognition + fixture.cutout + fixture.detection, calls);
  for (const stage of ['queued', 'locating', 'located', 'processing', 'review']) {
    const record = await data(await request('POST', '/clothing-imports', { inputAssetId: asset.assetId, mode: 'set' }, token, randomUUID()), clothingImportDetailSchema, 202);
    if (stage === 'locating') fixture.cancelImportId = record.id;
    if (stage !== 'queued') await processNextImageJob();
    const before = await data(await request('GET', `/clothing-imports/${record.id}`, undefined, token), clothingImportDetailSchema);
    const draftIds = before.items.map(item => item.clothing!.id);
    assert.equal(draftIds.length, stage === 'queued' || stage === 'locating' ? 0 : 2);
    if (stage === 'processing') fixture.cancelImportId = record.id;
    if (stage === 'processing' || stage === 'review') await processNextImageJob();
    if (stage === 'queued' || stage === 'located' || stage === 'review') {
      await data(await request('POST', `/clothing-imports/${record.id}/cancel`, undefined, token), clothingImportDetailSchema, 202);
    }
    const removed = await data(await request('GET', `/clothing-imports/${record.id}`, undefined, token), clothingImportDetailSchema);
    assert.equal(removed.status, 'cancelled'); assert.equal(removed.pending, false);
    assert(removed.items.every(item => item.clothing === null));
    assert(removed.jobs.every(job => job.status !== 'queued' && job.status !== 'running'));
    for (const id of draftIds) assert.equal((await request('GET', `/clothes/${id}`, undefined, token)).status, 404);
    assert.equal(await processNextImageJob(), false);
  }
  assert.equal((await data(await request('GET', `/clothes/${singleSaved.id}`, undefined, token), clothingSchema)).status, 'active');
  assert.equal((await data(await request('GET', `/clothes/${ids[1]}`, undefined, token), clothingSchema)).status, 'active');
  assert.equal((await request('POST', `/clothing-imports/${singleEdit.id}/cancel`, undefined, token)).status, 404);
});
