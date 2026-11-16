import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { after, before, beforeEach, mock, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import express from 'express';
import pg from 'pg';
import sharp from 'sharp';
import { build } from 'esbuild';
import { z } from 'zod';
import { recommendationSchema, recommendationOutfitSchema, signedUrlSchema, weatherSchema } from '../miniprogram/api/contracts.js';
import type { Clothing, Recommendation, RecommendationOutfit } from '../miniprogram/api/contracts.js';

const homeBundle = await build({ entryPoints: ['miniprogram/pages/home/home.ts'], bundle: true, platform: 'browser', format: 'cjs', target: 'es2015', write: false });
assert.equal(process.env.DB_HOST, '127.0.0.1');
assert.equal(process.env.DB_PORT, '55436');
const databaseName = `fit_or_not_recommendations_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
await admin.query(`CREATE DATABASE "${databaseName}"`);
process.env.DB_NAME = databaseName;
process.env.NODE_ENV = 'test';
const mediaDir = await mkdtemp(join(tmpdir(), 'fit-or-not-recommendations-'));
process.env.MEDIA_DIR = mediaDir;
const { app } = await import('../server/src/app.js');
const { pool } = await import('../server/src/db.js');
const { migrate } = await import('../server/src/migrate.js');
const { config } = await import('../server/src/config.js');
await migrate();
const original = { key: config.NEW_API_KEY, url: config.NEW_API_BASE_URL, amap: config.AMAP_KEY, timeout: config.AI_RECOMMENDATION_TIMEOUT_MS };
const nativeFetch = globalThis.fetch;
const events = new EventEmitter();
type Selection = { summary: string; items: { clothingId: string; reason: string }[]; outfits: { name: string; reason: string; clothingIds: string[] }[] };
const selections: Selection[] = [];
const fixture = { mode: 'normal', calls: 0, delay: 0, temperature: 19, high: 22, low: 15, rain: false, wind: '2', weatherFailed: false, ids: Array<string>(), payload: '' };
const supplier = express();
supplier.use(express.json());
supplier.get('/amap/weather/weatherInfo', (req, res) => {
  if (fixture.weatherFailed) { res.json({ status: '0', infocode: '10016' }); return; }
  const now = new Date(Date.now() + 8 * 3600000).toISOString();
  const reporttime = now.slice(0, 19).replace('T', ' ');
  if (req.query.extensions === 'base') {
    res.json({ status: '1', lives: [{ city: '测试市', weather: fixture.rain ? '小雨' : '晴', temperature: String(fixture.temperature), winddirection: '东北', windpower: fixture.wind, humidity: '62', reporttime }] });
    return;
  }
  res.json({ status: '1', forecasts: [{ city: '测试市', reporttime, casts: Array.from({ length: 3 }, (_, index) => ({ date: new Date(Date.now() + 8 * 3600000 + index * 86400000).toISOString().slice(0, 10), dayweather: fixture.rain ? '小雨' : '晴', nightweather: '晴', daytemp: String(fixture.high), nighttemp: String(fixture.low) })) }] });
});
supplier.post('/chat/completions', async (req, res) => {
  fixture.calls++;
  const request = z.object({ model: z.string(), messages: z.array(z.object({ role: z.string(), content: z.string() })) }).parse(req.body);
  fixture.payload = request.messages[1].content;
  const input = z.object({ clothes: z.array(z.object({ clothingId: z.uuid(), name: z.string() })) }).parse(JSON.parse(fixture.payload));
  fixture.ids = input.clothes.map(item => item.clothingId);
  events.emit('request');
  await setTimeout(fixture.delay);
  if (fixture.mode === 'failed') { res.status(503).json({ error: 'supplier unavailable' }); return; }
  const ids = fixture.ids;
  const normal = {
    summary: '早晚偏凉，适合薄外套与长裤。',
    items: ids.slice(0, 3).map(id => ({ clothingId: id, reason: '适合今天的温度。' })),
    outfits: [{ name: '今天这样穿', reason: '适合今天的温差。', clothingIds: ids.slice(0, 3) }, { name: '另一套组合', reason: '轻薄叠穿。', clothingIds: ids.slice(0, 3).reverse() }]
  };
  const selected = fixture.mode === 'empty' ? { summary: '暂时没有适合今天气温的衣物。', items: [], outfits: [] }
    : fixture.mode === 'foreign' ? { ...normal, items: [{ clothingId: randomUUID(), reason: '测试' }] }
      : fixture.mode === 'duplicate' ? { ...normal, outfits: [{ name: '重复', reason: '测试', clothingIds: [ids[0], ids[0]] }] }
        : fixture.mode === 'single' ? { ...normal, outfits: [] }
          : normal;
  res.json({ choices: [{ message: { content: fixture.mode === 'malformed' ? '```json\n{}\n```' : JSON.stringify(selections[0] ?? selected) } }] });
});
const provider = supplier.listen(0, '127.0.0.1');
await once(provider, 'listening');
const providerAddress = provider.address();
assert(providerAddress && typeof providerAddress !== 'string');
const providerBase = `http://127.0.0.1:${providerAddress.port}`;
config.NEW_API_BASE_URL = providerBase;
config.NEW_API_KEY = 'local-protocol-test';
config.AMAP_KEY = 'local-protocol-test';
mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
  if (url.hostname === 'restapi.amap.com' && url.searchParams.get('key') === 'local-protocol-test') {
    return nativeFetch(`${providerBase}/amap/${url.pathname.slice('/v3/'.length)}${url.search}`, init);
  }
  return nativeFetch(input, init);
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}/api`;
config.PUBLIC_BASE_URL = base.slice(0, -4);
const tokenA = randomBytes(32).toString('hex'), tokenB = randomBytes(32).toString('hex');
const userIds: string[] = [], clothingIds: string[] = [], assetIds: string[] = [];
const sequence = { city: 600000 };
const city = () => String(sequence.city++);
beforeEach(() => {
  fixture.mode = 'normal'; fixture.delay = 0; fixture.temperature = 19; fixture.high = 22; fixture.low = 15; fixture.rain = false; fixture.wind = '2'; fixture.weatherFailed = false;
  selections.length = 0;
  config.NEW_API_KEY = 'local-protocol-test'; config.NEW_API_BASE_URL = providerBase; config.AMAP_KEY = 'local-protocol-test'; config.AI_RECOMMENDATION_TIMEOUT_MS = original.timeout;
});
before(async () => {
  const photo = await sharp('miniprogram/assets/icons/shirt.svg').resize(240, 240).png().toBuffer();
  for (const [index, token] of [tokenA, tokenB].entries()) {
    const user = await pool.query<{ id: string }>('INSERT INTO users(wechat_openid,nickname) VALUES($1,$2) RETURNING id', [`recommendation-${randomUUID()}`, `推荐测试${index}`]);
    userIds.push(user.rows[0].id);
    await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '2 hours')", [user.rows[0].id, createHash('sha256').update(token).digest('hex')]);
  }
  for (const [index, name] of ['米色薄外套', '白色短袖上衣', '蓝色长裤', '灰色草稿', '归档鞋子'].entries()) {
    const category = await pool.query<{ id: string }>('INSERT INTO categories(user_id,name) VALUES($1,$2) RETURNING id', [userIds[0], name]);
    const storageKey = `${randomUUID()}.png`;
    await writeFile(join(mediaDir, storageKey), photo);
    const asset = await pool.query<{ id: string }>("INSERT INTO media_assets(user_id,kind,storage_key,mime_type,width,height,byte_size) VALUES($1,'original',$2,'image/png',240,240,$3) RETURNING id", [userIds[0], storageKey, photo.length]);
    assetIds.push(asset.rows[0].id);
    const clothing = await pool.query<{ id: string }>(`INSERT INTO clothes(user_id,name,category_id,primary_asset_id,status,colors,seasons,item_type,visible_features)
      VALUES($1,$2,$3,$4,$5,ARRAY['blue'],ARRAY['spring','autumn'],$6,$7) RETURNING id`, [userIds[0], name, category.rows[0].id, asset.rows[0].id, index === 3 ? 'draft' : index === 4 ? 'archived' : 'active', ['薄外套','短袖T恤','直筒长裤','草稿','鞋子'][index], index === 0 ? ['长袖','薄款'] : []]);
    clothingIds.push(clothing.rows[0].id);
  }
});
after(async () => {
  mock.restoreAll();
  for (const instance of [server, provider]) {
    instance.closeAllConnections();
    await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  }
  await pool.end();
  await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
  await rm(mediaDir, { recursive: true });
});
function request(method: string, path: string, body?: unknown, token = tokenA) {
  return nativeFetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function recommend(cityCode = city(), token = tokenA) {
  const response = await request('POST', '/recommendations', { cityCode }, token);
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return z.object({ data: recommendationSchema }).parse(body).data;
}
async function refreshWeather(cityCode: string) {
  const response = await request('GET', `/weather?cityCode=${cityCode}&refresh=true`);
  assert.equal(response.status, 200);
  return z.object({ data: weatherSchema }).parse(await response.json()).data;
}
async function createWardrobe(items: { type: string | null; seasons?: Clothing['seasons']; features?: string[] }[]) {
  const token = randomBytes(32).toString('hex');
  const user = await pool.query<{ id: string }>('INSERT INTO users(wechat_openid) VALUES($1) RETURNING id', [randomUUID()]);
  const category = await pool.query<{ id: string }>("INSERT INTO categories(user_id,name) VALUES($1,'其他') RETURNING id", [user.rows[0].id]);
  await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '2 hours')", [user.rows[0].id, createHash('sha256').update(token).digest('hex')]);
  const storageKey = `${randomUUID()}.png`;
  const photo = await sharp('miniprogram/assets/icons/shirt.svg').resize(240, 240).png().toBuffer();
  await writeFile(join(mediaDir, storageKey), photo);
  const asset = await pool.query<{ id: string }>("INSERT INTO media_assets(user_id,kind,storage_key,mime_type,width,height,byte_size) VALUES($1,'original',$2,'image/png',240,240,$3) RETURNING id", [user.rows[0].id, storageKey, photo.length]);
  const ids: string[] = [];
  for (const item of items) {
    const clothing = await pool.query<{ id: string }>(`INSERT INTO clothes(user_id,name,primary_asset_id,status,item_type,seasons,visible_features,category_id)
      VALUES($1,$2,$3,'active',$4,$5,$6,$7) RETURNING id`, [user.rows[0].id, item.type ?? '资料不全', asset.rows[0].id, item.type, item.seasons ?? [], item.features ?? [], category.rows[0].id]);
    ids.push(clothing.rows[0].id);
  }
  return { token, userId: user.rows[0].id, ids };
}
function selectFixture(items: string[], outfits: string[][]) {
  selections[0] = { summary: '按今天气温选择衣物。', items: items.map(clothingId => ({ clothingId, reason: '适合今天的温度。' })),
    outfits: outfits.map(clothingIds => ({ name: '天气组合', reason: '适合今天的温度。', clothingIds })) };
}
test('推荐入口：登录、参数、客户端不能注入天气或身份', async () => {
  assert.equal((await nativeFetch(`${base}/recommendations`, { method: 'POST' })).status, 401);
  for (const body of [{}, { cityCode: '杭州' }, { cityCode: '330100', userId: userIds[1] }, { cityCode: '330100', temperature: 25 }]) assert.equal((await request('POST', '/recommendations', body)).status, 400);
});
test('真实 PG/HTTP：推荐只引用自己的可用入橱衣物，图片和详情可访问', async () => {
  const result = await recommend();
  assert.equal(result.status, 'ready');
  assert.equal(result.items.length, 3);
  assert.deepEqual(new Set(fixture.ids), new Set(clothingIds.slice(0, 3)));
  assert(!fixture.payload.includes('occasion'));
  for (const item of result.items) assert.equal(item.name, ['米色薄外套', '白色短袖上衣', '蓝色长裤'][clothingIds.indexOf(item.clothingId)]);
  const detail = await request('GET', `/recommendations/${result.id}/outfits/${result.outfits[0].id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(z.object({ data: recommendationOutfitSchema }).parse(await detail.json()).data, result.outfits[0]);
  const signedResponse = await request('POST', '/media/signed-urls', { assetIds: result.items.map(item => item.primaryAssetId), variant: 'thumbnail' });
  const signed = z.object({ data: z.array(signedUrlSchema) }).parse(await signedResponse.json()).data;
  for (const image of signed) assert.equal((await nativeFetch(image.url)).status, 200);
  assert.equal((await request('GET', `/recommendations/${result.id}/outfits/${result.outfits[0].id}`, undefined, tokenB)).status, 404);
});
test('缓存：同日重开、天气更新时间和 1 度变化复用结果，缓存存于数据库', async () => {
  const cityCode = city();
  const first = await recommend(cityCode), calls = fixture.calls;
  assert.deepEqual(await recommend(cityCode), first);
  fixture.temperature++;
  await refreshWeather(cityCode);
  assert.deepEqual(await recommend(cityCode), first);
  fixture.temperature--;
  const rows = await pool.query<{ result: unknown }>('SELECT result FROM weather_recommendations WHERE id=$1', [first.id]);
  assert.deepEqual(rows.rows[0].result, first);
  assert.equal(fixture.calls, calls);
});
test('并发：相同条件同时请求只调用一次模型', async () => {
  const cityCode = city(), calls = fixture.calls;
  fixture.delay = 80;
  const values = await Promise.all([recommend(cityCode), recommend(cityCode), recommend(cityCode)]);
  fixture.delay = 0;
  assert.deepEqual(values[0], values[1]); assert.deepEqual(values[1], values[2]);
  assert.equal(fixture.calls, calls + 1);
});
test('缓存失效：升降温 3 度、降雨和大风变化触发新推荐', async () => {
  const cityCode = city();
  const first = await recommend(cityCode);
  fixture.temperature += 3;
  await refreshWeather(cityCode);
  const warmer = await recommend(cityCode);
  assert.notEqual(warmer.id, first.id);
  fixture.rain = true;
  await refreshWeather(cityCode);
  const rainy = await recommend(cityCode);
  assert.notEqual(rainy.id, warmer.id);
  fixture.wind = '5-6';
  await refreshWeather(cityCode);
  assert.notEqual((await recommend(cityCode)).id, rainy.id);
  fixture.temperature -= 3; fixture.rain = false; fixture.wind = '2';
});
test('缓存失效：跨日、城市切换、模型切换', async () => {
  const cityCode = city(), first = await recommend(cityCode);
  assert.notEqual((await recommend(city())).id, first.id);
  await pool.query("UPDATE weather_recommendations SET weather_date=weather_date-1 WHERE id=$1", [first.id]);
  const nextDay = await recommend(cityCode);
  assert.notEqual(nextDay.id, first.id);
  assert.equal((await pool.query('SELECT id FROM weather_recommendations WHERE id=$1', [first.id])).rowCount, 0);
  const model = config.AI_RECOMMENDATION_MODEL;
  config.AI_RECOMMENDATION_MODEL = 'test-recommendation-model';
  assert.notEqual((await recommend(cityCode)).id, nextDay.id);
  config.AI_RECOMMENDATION_MODEL = model;
});
test('缓存失效：衣物修改、归档、重新入橱、删除；失效搭配不能查看', async () => {
  const cityCode = city(), first = await recommend(cityCode);
  await pool.query("UPDATE clothes SET name='更新后的长裤',version=version+1 WHERE id=$1", [clothingIds[2]]);
  const changed = await recommend(cityCode);
  assert.notEqual(changed.id, first.id);
  assert(changed.items.some(item => item.name === '更新后的长裤'));
  fixture.mode = 'single';
  await pool.query("UPDATE clothes SET status='archived',version=version+1 WHERE id=$1", [clothingIds[2]]);
  assert.equal((await request('GET', `/recommendations/${changed.id}/outfits/${changed.outfits[0].id}`)).status, 409);
  const archived = await recommend(cityCode);
  assert(!archived.items.some(item => item.clothingId === clothingIds[2]));
  await pool.query("UPDATE clothes SET name='蓝色长裤',status='active',version=version+1 WHERE id=$1", [clothingIds[2]]);
  fixture.mode = 'normal';
  const active = await recommend(cityCode);
  assert.notEqual(active.id, archived.id);
  const extra = await pool.query<{ id: string }>("INSERT INTO clothes(user_id,name,primary_asset_id,status) VALUES($1,'待入橱草稿',$2,'draft') RETURNING id", [userIds[0], assetIds[0]]);
  assert.deepEqual(await recommend(cityCode), active);
  await pool.query('DELETE FROM clothes WHERE id=$1', [extra.rows[0].id]);
  assert.deepEqual(await recommend(cityCode), active);
  const added = await pool.query<{ id: string }>("INSERT INTO clothes(user_id,name,primary_asset_id,category_id,status) SELECT user_id,'新增薄上衣',primary_asset_id,category_id,'active' FROM clothes WHERE id=$1 RETURNING id", [clothingIds[0]]);
  const expanded = await recommend(cityCode);
  assert.notEqual(expanded.id, active.id); assert(fixture.ids.includes(added.rows[0].id));
  await pool.query('DELETE FROM clothes WHERE id=$1', [added.rows[0].id]);
  const deleted = await recommend(cityCode);
  assert.notEqual(deleted.id, expanded.id); assert(!fixture.ids.includes(added.rows[0].id));
});
test('生成期间衣橱变化：拒绝保存过时结果，下一次可重新推荐', async () => {
  const cityCode = city();
  fixture.delay = 120;
  const called = once(events, 'request');
  const pending = request('POST', '/recommendations', { cityCode });
  await called;
  await pool.query('UPDATE clothes SET version=version+1 WHERE id=$1', [clothingIds[0]]);
  assert.equal((await pending).status, 409);
  fixture.delay = 0;
  assert.equal((await recommend(cityCode)).status, 'ready');
});
test('空衣橱：成功空态、不调用 AI、不泄露他人衣物', async () => {
  const calls = fixture.calls;
  const result = await recommend(city(), tokenB);
  assert.equal(result.status, 'empty-wardrobe'); assert.deepEqual(result.items, []); assert.deepEqual(result.outfits, []);
  assert.equal(fixture.calls, calls);
});
test('无匹配：保存成功空态；衣物不足时可只有单品', async () => {
  fixture.mode = 'empty';
  const cityCode = city(), first = await recommend(cityCode), calls = fixture.calls;
  assert.equal(first.status, 'no-matches'); assert.deepEqual(first.items, []); assert.deepEqual(first.outfits, []);
  assert.deepEqual(await recommend(cityCode), first); assert.equal(fixture.calls, calls);
  fixture.mode = 'single';
  const single = await recommend();
  assert.equal(single.status, 'ready'); assert(single.items.length); assert.deepEqual(single.outfits, []);
  fixture.mode = 'normal';
});
test('模型异常：越权 ID、重复单品和格式错误被拒绝，失败不进入缓存', async () => {
  for (const mode of ['foreign', 'duplicate', 'malformed', 'failed']) {
    fixture.mode = mode;
    const cityCode = city(), response = await request('POST', '/recommendations', { cityCode });
    assert.equal(response.status, 502, mode);
    assert.equal((await pool.query('SELECT id FROM weather_recommendations WHERE user_id=$1 AND city_code=$2', [userIds[0], cityCode])).rowCount, 0);
  }
  fixture.mode = 'normal';
});
test('AI 超时：停止等待，不缓存失败，重试可恢复', async () => {
  config.AI_RECOMMENDATION_TIMEOUT_MS = 30; fixture.delay = 150;
  const cityCode = city();
  assert.equal((await request('POST', '/recommendations', { cityCode })).status, 502);
  config.AI_RECOMMENDATION_TIMEOUT_MS = original.timeout; fixture.delay = 0;
  assert.equal((await recommend(cityCode)).status, 'ready');
});
test('未配置 AI：新生成明确返回 503，已有当天缓存仍可读取', async () => {
  const cityCode = city(), first = await recommend(cityCode);
  const key = config.NEW_API_KEY; config.NEW_API_KEY = '';
  assert.deepEqual(await recommend(cityCode), first);
  assert.equal((await request('POST', '/recommendations', { cityCode: city() })).status, 503);
  config.NEW_API_KEY = key;
});
test('天气失败：新城市不调用 AI；同日旧天气可读取已生成缓存', async () => {
  const cityCode = city(), first = await recommend(cityCode), calls = fixture.calls;
  fixture.weatherFailed = true;
  assert.equal((await request('POST', '/recommendations', { cityCode: city() })).status, 502);
  const stale = await refreshWeather(cityCode);
  assert.equal(stale.stale, true);
  assert.deepEqual(await recommend(cityCode), first);
  assert.equal(fixture.calls, calls);
  await pool.query('DELETE FROM weather_recommendations WHERE id=$1', [first.id]);
  assert.equal((await request('POST', '/recommendations', { cityCode })).status, 503);
  fixture.weatherFailed = false;
});
test('迁移幂等：重复启动保留用户、衣物和推荐缓存', async () => {
  const first = await recommend();
  await migrate();
  assert.equal((await pool.query('SELECT id FROM clothes WHERE user_id=$1', [userIds[0]])).rowCount, 5);
  assert.equal((await pool.query('SELECT id FROM weather_recommendations WHERE id=$1', [first.id])).rowCount, 1);
});
test('冷天晴天：排除短裤凉鞋与夏季下装，短袖仅可搭配保暖层', async () => {
  fixture.temperature = 10; fixture.high = 14; fixture.low = 6;
  const wardrobe = await createWardrobe([
    { type: '短袖T恤', seasons: ['summer'] }, { type: '短裤', seasons: ['summer'] }, { type: '凉鞋', seasons: ['summer'] },
    { type: '羽绒服', seasons: ['winter'] }, { type: '直筒长裤', seasons: ['winter'] }, { type: '棉麻长裤', seasons: ['summer'] }
  ]);
  const [tee, shorts, sandals, coat, pants, summerPants] = wardrobe.ids;
  selectFixture([tee, coat, pants], [[tee, pants], [tee, coat, pants]]);
  const result = await recommend(city(), wardrobe.token);
  assert.equal(result.status, 'ready');
  assert.deepEqual(new Set(fixture.ids), new Set([tee, coat, pants]));
  for (const id of [shorts, sandals, summerPants]) assert(!fixture.ids.includes(id));
  assert.deepEqual(result.items.map(item => item.clothingId), [coat, pants]);
  assert.deepEqual(result.outfits.map(outfit => outfit.items.map(item => item.clothingId)), [[tee, coat, pants]]);
  const input = z.object({ weather: z.object({ current: z.object({ weather: z.literal('晴') }) }), weatherRules: z.object({ cold: z.literal(true) }) }).parse(JSON.parse(fixture.payload));
  assert.equal(input.weatherRules.cold, true);
});
test('缺少保暖层：薄外套、围巾和未知资料不能凑成冷天穿搭，补充资料后重新生成', async () => {
  fixture.temperature = 10; fixture.high = 14; fixture.low = 6;
  const wardrobe = await createWardrobe([{ type: '短袖T恤' }, { type: '长裤' }, { type: null }, { type: '薄外套', features: ['薄款'] }, { type: '保暖围巾' }]);
  const [tee, pants, unknown, thinCoat, scarf] = wardrobe.ids;
  selectFixture([tee], [[tee, pants], [tee, pants, thinCoat], [tee, pants, scarf]]);
  const cityCode = city(), first = await recommend(cityCode, wardrobe.token), calls = fixture.calls;
  assert(!fixture.ids.includes(unknown));
  assert.equal(first.status, 'no-matches'); assert.deepEqual(first.items, []); assert.deepEqual(first.outfits, []);
  assert.deepEqual(await recommend(cityCode, wardrobe.token), first); assert.equal(fixture.calls, calls);
  await pool.query("UPDATE clothes SET item_type='毛衣',version=version+1 WHERE id=$1", [unknown]);
  selectFixture([unknown], [[tee, pants, unknown]]);
  const updated = await recommend(cityCode, wardrobe.token);
  assert.equal(updated.status, 'ready'); assert.notEqual(updated.id, first.id); assert.equal(updated.outfits.length, 1);
});
test('筛选后全不适合：保留无匹配状态而非空衣橱，不调用 AI', async () => {
  fixture.temperature = 8; fixture.high = 12; fixture.low = 4;
  const wardrobe = await createWardrobe([{ type: '短裤' }, { type: '凉鞋' }, { type: null }]);
  const cityCode = city(), calls = fixture.calls;
  config.NEW_API_KEY = '';
  const result = await recommend(cityCode, wardrobe.token);
  assert.equal(result.status, 'no-matches'); assert.deepEqual(result.items, []); assert.deepEqual(result.outfits, []);
  assert.deepEqual(await recommend(cityCode, wardrobe.token), result); assert.equal(fixture.calls, calls);
});
test('高温：按气温保留夏装，排除羽绒服和冬季厚衣，不按月份筛选', async () => {
  fixture.temperature = 30; fixture.high = 33; fixture.low = 24;
  const wardrobe = await createWardrobe([{ type: '羽绒服', seasons: ['winter'] }, { type: '厚款毛衣' },
    { type: '短袖T恤', seasons: ['summer'] }, { type: '短裤', seasons: ['summer'] }, { type: '凉鞋' }]);
  const [coat, sweater, tee, shorts, sandals] = wardrobe.ids;
  selectFixture([tee, shorts, sandals], [[tee, shorts, sandals]]);
  const result = await recommend(city(), wardrobe.token);
  assert.deepEqual(new Set(fixture.ids), new Set([tee, shorts, sandals]));
  assert(!fixture.ids.includes(coat)); assert(!fixture.ids.includes(sweater));
  assert.equal(result.items.length, 3); assert.equal(result.outfits.length, 1);
});
test('更冷天气：加绒裤和保暖围巾不能代替上身保暖层', async () => {
  fixture.temperature = 4; fixture.high = 7; fixture.low = 0;
  const wardrobe = await createWardrobe([{ type: '短袖T恤' }, { type: '毛衣' }, { type: '加绒长裤' }, { type: '保暖围巾' }, { type: '羽绒服' }]);
  const [tee, sweater, pants, scarf, coat] = wardrobe.ids;
  selectFixture([coat], [[tee, sweater, pants], [tee, pants, scarf], [tee, coat, pants]]);
  const result = await recommend(city(), wardrobe.token);
  assert.deepEqual(result.outfits.map(outfit => outfit.items.map(item => item.clothingId)), [[tee, coat, pants]]);
});
test('缓存温度边界：不足 3 度但跨筛选规则时重算，同规则内复用', async () => {
  fixture.temperature = 13;
  const wardrobe = await createWardrobe([{ type: '长袖衬衫' }, { type: '长裤' }, { type: '毛衣' }]);
  const [shirt, pants, sweater] = wardrobe.ids;
  selectFixture([shirt, pants, sweater], [[shirt, pants], [shirt, pants, sweater]]);
  const cityCode = city(), first = await recommend(cityCode, wardrobe.token), calls = fixture.calls;
  assert.equal(first.outfits.length, 2);
  fixture.temperature = 12; await refreshWeather(cityCode);
  const colder = await recommend(cityCode, wardrobe.token);
  assert.notEqual(colder.id, first.id); assert.equal(colder.outfits.length, 1); assert.equal(fixture.calls, calls + 1);
  fixture.temperature = 11; await refreshWeather(cityCode);
  assert.deepEqual(await recommend(cityCode, wardrobe.token), colder); assert.equal(fixture.calls, calls + 1);
});
test('低温预报与风力：白天持续偏冷、早晚低温和大风参与筛选', async () => {
  const wardrobe = await createWardrobe([{ type: '长袖衬衫' }, { type: '长裤' }, { type: '毛衣' }, { type: '短裤' }]);
  const [shirt, pants, sweater, shorts] = wardrobe.ids;
  selectFixture([shirt, pants, sweater], [[shirt, pants], [shirt, pants, sweater]]);
  fixture.temperature = 19; fixture.high = 20; fixture.low = 9;
  const cool = await recommend(city(), wardrobe.token);
  assert(!fixture.ids.includes(shorts)); assert.equal(cool.outfits.length, 2);
  fixture.temperature = 16; fixture.high = 15; fixture.low = 10;
  assert.equal((await recommend(city(), wardrobe.token)).outfits.length, 1);
  fixture.temperature = 17; fixture.high = 22; fixture.low = 10; fixture.wind = '5-6';
  assert.equal((await recommend(city(), wardrobe.token)).outfits.length, 1);
});
test('超过 200 件：分页后筛选，较早冬装优先于短袖内搭，相同微秒时间戳不漏衣物', async () => {
  fixture.temperature = 10; fixture.high = 14; fixture.low = 6;
  const wardrobe = await createWardrobe([{ type: '毛衣' }, { type: '长裤' }, { type: '棉服' },
    ...Array.from({ length: 201 }, () => ({ type: '短裤' })), ...Array.from({ length: 201 }, () => ({ type: '短袖T恤' }))]);
  await pool.query("UPDATE clothes SET updated_at='2026-11-14T12:00:00.123456+08:00' WHERE user_id=$1 AND item_type IN ('短裤','短袖T恤')", [wardrobe.userId]);
  await pool.query("UPDATE clothes SET updated_at='2026-11-13T12:00:00.123456+08:00' WHERE id=ANY($1::uuid[])", [wardrobe.ids.slice(0, 3)]);
  selectFixture(wardrobe.ids.slice(0, 3), [wardrobe.ids.slice(0, 3)]);
  const result = await recommend(city(), wardrobe.token);
  assert.equal(fixture.ids.length, 200);
  for (const id of wardrobe.ids.slice(0, 3)) assert(fixture.ids.includes(id));
  for (const id of wardrobe.ids.slice(3, 204)) assert(!fixture.ids.includes(id));
  assert.equal(result.outfits.length, 1);
});
type HomeData = {
  ready: boolean; weatherReady: boolean; loading: boolean; error: string;
  recommendation: Recommendation | null; items: (Recommendation['items'][number] & { imageUrl: string })[];
  outfits: (Omit<RecommendationOutfit, 'items'> & { items: HomeData['items'] })[]; outfitIndex: number; updatedLabel: string;
};
type HomePage = {
  data: HomeData; setData(update: Partial<HomeData>): void; getTabBar(): { setData(update: object): void };
  onLoad(): void; onShow(): void; onHide(): void; onUnload(): void; onCityChange(): void;
  onWeatherChange(event: { detail: { cityCode: string } }): void;
  onOutfitChange(event: { detail: { current: number; source: '' | 'touch' | 'autoplay' } }): void;
  onOutfit(event: { currentTarget: { dataset: { id: string } } }): void;
  onClothing(event: { currentTarget: { dataset: { id: string } } }): void;
};
type WxRequest = {
  url: string; method: string; data?: object; header: Record<string, string>; timeout: number;
  success(result: { statusCode: number; data: unknown }): void; fail(error: { errMsg: string }): void;
};
function createHome(token = tokenA, ignoreAbort = false) {
  const captured = { page: null as HomePage | null, routes: Array<string>(), timeouts: Array<number>(), updates: 0 };
  runInNewContext(homeBundle.outputFiles[0].text, {
    module: { exports: {} }, console, setTimeout, clearTimeout,
    Page(page: HomePage) {
      page.setData = update => { captured.updates++; Object.assign(page.data, update); };
      page.getTabBar = () => ({ setData() {} });
      captured.page = page;
    },
    wx: {
      getStorageSync: () => token,
      navigateTo: (options: { url: string }) => captured.routes.push(options.url),
      reLaunch: (options: { url: string }) => captured.routes.push(options.url),
      request(options: WxRequest) {
        captured.timeouts.push(options.timeout);
        const controller = new AbortController();
        const path = new URL(options.url);
        void nativeFetch(`${base}${path.pathname.slice('/api'.length)}${path.search}`, { method: options.method, headers: { ...options.header, 'Content-Type': 'application/json' }, body: options.data ? JSON.stringify(options.data) : undefined, signal: controller.signal })
          .then(async response => options.success({ statusCode: response.status, data: await response.json() }))
          .catch(() => options.fail({ errMsg: 'request:fail abort' }));
        return { abort() { if (!ignoreAbort) controller.abort(); } };
      }
    }
  });
  assert(captured.page);
  captured.page.onLoad();
  return { page: captured.page, captured };
}
async function waitForHome(page: HomePage) {
  for (const _attempt of Array.from({ length: 500 })) {
    if (!page.data.loading) return;
    await setTimeout(10);
  }
  assert.fail('首页未在测试期限内结束加载');
}
test('真实首页代码 + PG/HTTP：加载、图片、切换、详情路由和重新进入缓存', async () => {
  const wardrobe = await createWardrobe([{ type: '长袖衬衫' }, { type: '短袖T恤' }, { type: '长裤' },
    { type: '半身长裙' }, { type: '薄外套' }, { type: '运动鞋' }]);
  const [shirt, tee, pants, skirt, coat, shoes] = wardrobe.ids;
  selectFixture(wardrobe.ids, [[shirt, pants, coat, shoes], [tee, skirt, coat, shoes]]);
  const { page, captured } = createHome(wardrobe.token);
  const cityCode = city();
  page.onWeatherChange({ detail: { cityCode } });
  assert.equal(page.data.loading, true);
  await waitForHome(page);
  assert.equal(page.data.error, ''); assert.equal(page.data.items.length, 6); assert.equal(page.data.outfits.length, 2);
  assert(page.data.items.every(item => item.imageUrl.startsWith(base)));
  assert(page.data.outfits.every(outfit => outfit.items.every(item => item.imageUrl.startsWith(base))));
  const first = page.data.recommendation;
  assert(first); assert(captured.timeouts.includes(65000));
  const calls = fixture.calls;
  page.onOutfitChange({ detail: { current: 1, source: 'touch' } });
  assert.equal(page.data.outfitIndex, 1); assert.equal(fixture.calls, calls);
  page.onOutfit({ currentTarget: { dataset: { id: first.outfits[1].id } } });
  assert.equal(captured.routes[0], `/pages/recommendation-detail/recommendation-detail?id=${first.id}&outfitId=${first.outfits[1].id}`);
  page.onOutfitChange({ detail: { current: 0, source: 'touch' } });
  assert.equal(page.data.outfitIndex, 0); assert.equal(fixture.calls, calls);
  page.onOutfitChange({ detail: { current: 1, source: '' } });
  assert.equal(page.data.outfitIndex, 0);
  page.onOutfit({ currentTarget: { dataset: { id: first.outfits[0].id } } });
  assert.equal(captured.routes[1], `/pages/recommendation-detail/recommendation-detail?id=${first.id}&outfitId=${first.outfits[0].id}`);
  page.onClothing({ currentTarget: { dataset: { id: shirt } } });
  assert.equal(captured.routes[2], `/pages/clothing-detail/clothing-detail?id=${shirt}`);
  page.onHide(); page.onShow(); await waitForHome(page);
  assert.deepEqual(page.data.recommendation, first); assert.equal(fixture.calls, calls);
  page.onUnload();
});
test('真实首页代码：凌晨生成时间按上海日期展示', async () => {
  const cityCode = city(), first = await recommend(cityCode);
  const generatedAt = new Date(`${first.date}T00:05:00+08:00`).toISOString();
  await pool.query("UPDATE weather_recommendations SET result=jsonb_set(result,'{generatedAt}',to_jsonb($2::text)),generated_at=$2::timestamptz WHERE id=$1", [first.id, generatedAt]);
  const { page } = createHome();
  page.onWeatherChange({ detail: { cityCode } }); await waitForHome(page);
  assert.equal(page.data.updatedLabel, `${first.date.replace(/-/g, '/')} 00:05`);
  page.onUnload();
});
test('真实首页代码：空衣橱、无匹配、失败与保留已加载内容', async () => {
  const empty = createHome(tokenB).page;
  empty.onWeatherChange({ detail: { cityCode: city() } }); await waitForHome(empty);
  assert.equal(empty.data.recommendation?.status, 'empty-wardrobe'); empty.onUnload();
  fixture.mode = 'empty';
  const unmatched = createHome().page;
  unmatched.onWeatherChange({ detail: { cityCode: city() } }); await waitForHome(unmatched);
  assert.equal(unmatched.data.recommendation?.status, 'no-matches'); unmatched.onUnload();
  fixture.mode = 'normal';
  const { page } = createHome();
  const cityCode = city(); page.onWeatherChange({ detail: { cityCode } }); await waitForHome(page);
  const first = page.data.recommendation;
  fixture.mode = 'failed';
  await pool.query('DELETE FROM weather_recommendations WHERE id=$1', [first!.id]);
  page.onHide(); page.onShow(); await waitForHome(page);
  assert(page.data.error); assert.deepEqual(page.data.recommendation, first);
  page.onUnload();
});
test('真实首页代码：城市切换与卸载后，迟到请求不能覆盖界面', async () => {
  fixture.delay = 100;
  const { page, captured } = createHome(tokenA, true);
  const called = once(events, 'request');
  page.onWeatherChange({ detail: { cityCode: city() } }); await called;
  page.onCityChange(); assert.equal(JSON.stringify(page.data.recommendation), 'null'); assert.equal(page.data.weatherReady, false);
  const next = city(); page.onWeatherChange({ detail: { cityCode: next } });
  await waitForHome(page);
  assert.equal(page.data.recommendation?.cityCode, next);
  const anotherCall = once(events, 'request');
  page.onWeatherChange({ detail: { cityCode: city() } }); await anotherCall;
  page.onUnload(); const updates = captured.updates;
  await setTimeout(200);
  assert.equal(captured.updates, updates);
});
test('真实 AI：冷天晴天推荐保暖组合，短袖不单独推荐，结果复用缓存', { skip: process.env.RUN_RECOMMENDATION_AI_TESTS !== 'true' || !original.key }, async () => {
  fixture.temperature = 4; fixture.high = 7; fixture.low = 0;
  const wardrobe = await createWardrobe([{ type: '羽绒服', seasons: ['winter'] }, { type: '毛衣', seasons: ['winter'] },
    { type: '加绒长裤', seasons: ['winter'] }, { type: '短袖T恤', seasons: ['summer'] }, { type: '短裤', seasons: ['summer'] }, { type: '凉鞋', seasons: ['summer'] }]);
  config.NEW_API_KEY = original.key; config.NEW_API_BASE_URL = original.url;
  const [coat, _sweater, pants, tee, shorts, sandals] = wardrobe.ids;
  const cityCode = city(), result = await recommend(cityCode, wardrobe.token);
  assert.equal(result.status, 'ready'); assert(result.outfits.length > 0);
  assert(!result.items.some(item => item.clothingId === tee));
  for (const outfit of result.outfits) {
    assert(outfit.items.some(item => item.clothingId === coat)); assert(outfit.items.some(item => item.clothingId === pants));
  }
  for (const item of [...result.items, ...result.outfits.flatMap(outfit => outfit.items)]) assert(![shorts, sandals].includes(item.clothingId));
  assert.deepEqual(await recommend(cityCode, wardrobe.token), result);
  console.log(JSON.stringify({ event: 'live_cold_recommendation_verified', itemCount: result.items.length, outfitCount: result.outfits.length, cacheReused: true }));
});
test('真实 AI 与高德：用测试衣橱生成推荐并复用当天结果', { skip: process.env.RUN_RECOMMENDATION_AI_TESTS !== 'true' || !original.key || !original.amap }, async () => {
  config.NEW_API_KEY = original.key; config.NEW_API_BASE_URL = original.url; config.AMAP_KEY = original.amap;
  try {
    const first = await recommend('340800');
    assert.equal(first.status, 'ready'); assert(first.items.length > 0);
    for (const item of [...first.items, ...first.outfits.flatMap(outfit => outfit.items)]) assert(clothingIds.slice(0, 3).includes(item.clothingId));
    assert.deepEqual(await recommend('340800'), first);
    console.log(JSON.stringify({ event: 'live_recommendation_verified', itemCount: first.items.length, outfitCount: first.outfits.length, cacheReused: true }));
  } finally { config.NEW_API_KEY = 'local-protocol-test'; config.NEW_API_BASE_URL = providerBase; config.AMAP_KEY = 'local-protocol-test'; }
});
