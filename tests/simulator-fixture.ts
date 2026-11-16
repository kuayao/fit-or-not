import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { z } from 'zod';
import { categorySchema, clothingSchema, mediaSchema, outfitSchema, packingSchema, wearSchema } from '../miniprogram/api/contracts.js';

assert.equal(process.env.DB_HOST, '127.0.0.1');
assert.equal(process.env.DB_PORT, '55436');
const databaseName = `fit_or_not_ui_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD
});
await admin.query(`CREATE DATABASE "${databaseName}"`);
process.env.DB_NAME = databaseName;
process.env.NODE_ENV = 'test';
process.env.MEDIA_DIR = await mkdtemp(join(tmpdir(), 'fit-or-not-ui-'));
const { pool } = await import('../server/src/db.js');
const { app } = await import('../server/src/app.js');
const { migrate } = await import('../server/src/migrate.js');
const { processNextImageJob } = await import('../server/src/background.js');
await migrate();
const token = randomBytes(32).toString('hex');
const user = await pool.query<{ id: string }>("INSERT INTO users(wechat_openid,nickname) VALUES($1,'开发测试衣橱') RETURNING id", [`ui-${randomUUID()}`]);
await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '2 hours')", [user.rows[0].id, createHash('sha256').update(token).digest('hex')]);
const server = app.listen(3006, '127.0.0.1');
async function post<T>(path: string, body: object, schema: z.ZodType<T>) {
  const response = await fetch(`http://127.0.0.1:3006/api${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert(response.ok, await response.clone().text());
  return z.object({ data: schema }).parse(await response.json()).data;
}
const categories = [];
for (const name of ['上装', '下装', '连衣裙', '外套', '鞋子', '包袋', '配饰']) categories.push(await post('/categories', { name }, categorySchema));
const clothes = [];
for (const [index, name] of ['测试蓝色上装', '测试下装', '测试外套', '待确认草稿'].entries()) {
  const png = await sharp('miniprogram/assets/icons/shirt.svg').resize(480, 640, { fit: 'contain', background: index % 2 ? '#EAE0D2' : '#DDEBF8' }).png().toBuffer();
  const form = new FormData(); form.set('purpose', 'clothing'); form.set('file', new Blob([png]), 'test.png');
  const uploaded = await fetch('http://127.0.0.1:3006/api/media', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const asset = z.object({ data: mediaSchema }).parse(await uploaded.json()).data;
  clothes.push(await post('/clothes', { name, primaryAssetId: asset.assetId, categoryId: categories[index].id, status: index === 3 ? 'draft' : 'active', priceCents: index === 2 ? null : index === 1 ? '0' : '19900', colors: ['blue'], seasons: ['spring', 'autumn'] }, clothingSchema));
}
const outfit = await post('/outfits', { name: '开发测试搭配', items: clothes.slice(0, 2).map((item, index) => ({ clothingId: item.id, x: index * 0.45 + 0.05, y: 0.2, width: 0.4, height: 0.5, rotation: 0, zIndex: index })) }, outfitSchema);
await processNextImageJob();
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const record = await post('/wear-records', { wornOn: day, outfitId: outfit.id }, wearSchema);
const packing = await post('/packing-lists', { name: '开发测试旅行清单', clothingIds: clothes.slice(0, 2).map(item => item.id) }, packingSchema);
await mkdir('.local', { recursive: true });
await writeFile('.local/simulator-fixture.json', JSON.stringify({ token, clothingId: clothes[0].id, outfitId: outfit.id, recordId: record.id, packingId: packing.id, day }), { mode: 0o600 });
console.log('模拟器测试库已就绪；会话和路由保存在 .local/simulator-fixture.json。停止进程后清理测试库与测试文件。');
async function stop() {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
  await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
  await rm(process.env.MEDIA_DIR!, { recursive: true });
  await rm('.local/simulator-fixture.json');
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
