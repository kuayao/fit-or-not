import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import express from 'express';
import pg from 'pg';
import { z } from 'zod';
import { capabilitiesSchema, packingSchema } from '../miniprogram/api/contracts.js';
import type { PackingList } from '../miniprogram/api/contracts.js';

assert.equal(process.env.DB_HOST, '127.0.0.1');
assert.equal(process.env.DB_PORT, '55436');
const databaseName = `packing_reminders_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
await admin.query(`CREATE DATABASE "${databaseName}"`);
const mediaDir = await mkdtemp(join(tmpdir(), 'packing-reminders-'));
process.env.DB_NAME = databaseName;
process.env.NODE_ENV = 'test';
process.env.MEDIA_DIR = mediaDir;
process.env.WECHAT_APP_SECRET = 'local-reminder-test';
process.env.WECHAT_PACKING_TEMPLATE_ID = 'local-packing-template';
process.env.WECHAT_MESSAGE_ENV = 'trial';
const { pool } = await import('../server/src/db.js');
const { migrate } = await import('../server/src/migrate.js');
const { config } = await import('../server/src/config.js');
const { packingReminderAt, processNextPackingReminder } = await import('../server/src/packing-reminders.js');

await pool.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY,filename text NOT NULL,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
for (const filename of (await readdir('server/migrations')).filter(name => /^V\d+__/.test(name) && Number(name.split('__')[0].slice(1)) <= 14).sort((a, b) => Number(a.split('__')[0].slice(1)) - Number(b.split('__')[0].slice(1)))) {
  const sql = await readFile(`server/migrations/${filename}`, 'utf8');
  await pool.query(sql);
  await pool.query('INSERT INTO schema_migrations(version,filename,checksum) VALUES($1,$2,$3)', [Number(filename.split('__')[0].slice(1)), filename, createHash('sha256').update(sql).digest('hex')]);
}
const owner = (await pool.query<{ id: string }>('INSERT INTO users(wechat_openid) VALUES($1) RETURNING id', [randomUUID()])).rows[0].id;
const other = (await pool.query<{ id: string }>('INSERT INTO users(wechat_openid) VALUES($1) RETURNING id', [randomUUID()])).rows[0].id;
const token = randomUUID();
const otherToken = randomUUID();
for (const [userId, session] of [[owner, token], [other, otherToken]]) await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [userId, createHash('sha256').update(session).digest('hex')]);
const category = (await pool.query<{ id: string }>("INSERT INTO categories(user_id,name) VALUES($1,'上衣') RETURNING id", [owner])).rows[0].id;
const asset = (await pool.query<{ id: string }>("INSERT INTO media_assets(user_id,kind,storage_key,mime_type,width,height,byte_size) VALUES($1,'original',$2,'image/png',1,1,1) RETURNING id", [owner, randomUUID()])).rows[0].id;
const clothes = (await pool.query<{ id: string }>("INSERT INTO clothes(user_id,name,category_id,primary_asset_id,status) VALUES($1,'衬衫',$2,$3,'active'),($1,'外套',$2,$3,'active') RETURNING id", [owner, category, asset])).rows.map(item => item.id);
const legacy = (await pool.query<{ id: string }>("INSERT INTO packing_lists(user_id,name,start_on,end_on) VALUES($1,'原有行程','2099-11-20','2099-11-23') RETURNING id", [owner])).rows[0].id;
await pool.query('INSERT INTO packing_items(user_id,packing_list_id,clothing_id,packed,sort_order) VALUES($1,$2,$3,true,0)', [owner, legacy, clothes[0]]);
const legacyReminder = (await pool.query<{ id: string }>("INSERT INTO packing_lists(user_id,name,start_on,end_on,departure_time) VALUES($1,'旧提醒','2099-11-20','2099-11-23','09:30') RETURNING id", [owner])).rows[0].id;
await pool.query("INSERT INTO packing_reminders(user_id,packing_list_id,timing,scheduled_at) VALUES($1,$2,'departure-day','2099-11-20T00:00:00Z')", [owner, legacyReminder]);
await migrate();
const { app } = await import('../server/src/app.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}/api`;

const messageSchema = z.object({
  touser: z.string(), template_id: z.literal('local-packing-template'), page: z.string(), miniprogram_state: z.literal('trial'),
  data: z.object({ thing1: z.object({ value: z.string() }), time8: z.object({ value: z.string() }), thing6: z.object({ value: z.string() }) })
});
const supplier = express();
supplier.use(express.json());
const fixture = { mode: 'sent', tokenCalls: 0, messages: Array<z.infer<typeof messageSchema>>(), tokenGate: Promise.resolve() };
supplier.post('/cgi-bin/stable_token', async (req, res) => {
  assert.equal(req.body.secret, 'local-reminder-test');
  fixture.tokenCalls++;
  supplier.emit('token-requested');
  await fixture.tokenGate;
  res.json({ access_token: 'local-access-token', expires_in: 7200 });
});
supplier.post('/cgi-bin/message/subscribe/send', (req, res) => {
  assert.equal(req.query.access_token, 'local-access-token');
  fixture.messages.push(messageSchema.parse(req.body));
  if (fixture.mode === 'unknown') { res.destroy(); return; }
  if (fixture.mode === 'rejected') { res.json({ errcode: 43101 }); return; }
  if (fixture.mode === 'invalid-token') { res.json({ errcode: 40001 }); return; }
  res.json({ errcode: 0 });
});
const supplierServer = supplier.listen(0, '127.0.0.1');
await once(supplierServer, 'listening');
const supplierAddress = supplierServer.address();
assert(supplierAddress && typeof supplierAddress !== 'string');
const supplierBase = `http://127.0.0.1:${supplierAddress.port}`;
const nativeFetch = globalThis.fetch;
mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
  return nativeFetch(url.hostname === 'api.weixin.qq.com' ? `${supplierBase}${url.pathname}${url.search}` : input, init);
});
beforeEach(() => { fixture.mode = 'sent'; fixture.messages.length = 0; fixture.tokenGate = Promise.resolve(); });
after(async () => {
  mock.restoreAll();
  await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => supplierServer.close(() => resolve()))]);
  await pool.end();
  await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
  await rm(mediaDir, { recursive: true });
});
const call = (method: string, path: string, body?: object, session = token) => fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
async function packing(response: Response, status = 200) {
  const payload: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(payload));
  return z.object({ data: packingSchema }).parse(payload).data;
}
const create = (name = '提醒测试', clothingIds = clothes, reminderSubscriptions = 0) => call('POST', '/packing-lists', { name, startOn: '2099-11-20', endOn: '2099-11-23', clothingIds, reminderSubscriptions }).then(response => packing(response, 201));
const authorize = (list: PackingList, subscriptions = 1) => patch(list, { reminderSubscriptions: subscriptions });
const patch = (list: PackingList, values: object) => call('PATCH', `/packing-lists/${list.id}`, { version: list.version, name: list.name, startOn: list.startOn, endOn: list.endOn, departureTime: list.departureTime, items: list.items.map(item => ({ clothingId: item.clothingId, packed: item.packed })), ...values });
const makeDue = (id: string, timing = 'day-before') => pool.query("UPDATE packing_reminders SET scheduled_at=now()-interval '1 minute' WHERE packing_list_id=$1 AND timing=$2", [id, timing]);

test('V14 升级保留清单、日期、衣物与勾选；重复迁移不改历史', async () => {
  const list = await packing(await call('GET', `/packing-lists/${legacy}`));
  assert.equal(list.name, '原有行程');
  assert.equal(list.startOn, '2099-11-20');
  assert.equal(list.endOn, '2099-11-23');
  assert.equal(list.version, 1);
  assert.equal(list.endedAt, null);
  assert.equal(list.departureTime, '07:00');
  assert.deepEqual(list.reminders, []);
  assert.equal(list.items[0].clothingId, clothes[0]);
  assert.equal(list.items[0].packed, true);
  const previous = await packing(await call('GET', `/packing-lists/${legacyReminder}`));
  assert.equal(previous.departureTime, '09:30');
  assert.equal(previous.reminders.length, 1);
  assert.equal(previous.reminders[0].timing, 'day-before');
  assert.equal(Date.parse(previous.reminders[0].scheduledAt), Date.parse('2099-11-19T11:00:00Z'));
  await Promise.all([migrate(), migrate()]);
  assert.equal((await pool.query('SELECT version FROM schema_migrations WHERE version IN (13,14,15)')).rowCount, 3);
});

test('结束、历史分页、重新开启及复制；归属、版本与已结束写入限制', async () => {
  const list = await create();
  const pending = await packing(await authorize(list));
  const ended = await packing(await call('PATCH', `/packing-lists/${list.id}/status`, { version: pending.version, ended: true }));
  assert.ok(ended.endedAt);
  assert.equal(ended.reminders[0]?.status, 'cancelled');
  assert.deepEqual(ended.items, list.items);
  const active = z.object({ data: z.array(packingSchema) }).parse(await (await call('GET', '/packing-lists?status=active')).json());
  assert.equal(active.data.some(item => item.id === list.id), false);
  const history = z.object({ data: z.array(packingSchema), pagination: z.object({ total: z.number() }) }).parse(await (await call('GET', '/packing-lists?status=ended&pageSize=1')).json());
  assert.equal(history.data[0].id, list.id);
  assert.equal(history.pagination.total, 1);
  assert.equal((await patch(ended, { name: '不可写' })).status, 409);
  assert.equal((await call('PATCH', `/packing-lists/${list.id}/status`, { version: list.version, ended: false })).status, 409);
  assert.equal((await call('PATCH', `/packing-lists/${list.id}/status`, { version: ended.version, ended: false }, otherToken)).status, 404);
  const copied = await packing(await call('POST', `/packing-lists/${list.id}/copy`, { name: '新行程', startOn: null, endOn: null }), 201);
  assert.equal(copied.startOn, null);
  assert.equal(copied.departureTime, '07:00');
  assert.equal(copied.endedAt, null);
  assert.deepEqual(copied.reminders, []);
  assert.equal(copied.items.length, 2);
  assert.equal(copied.items.every(item => !item.packed), true);
  const reopened = await packing(await call('PATCH', `/packing-lists/${list.id}/status`, { version: ended.version, ended: false }));
  assert.equal(reopened.endedAt, null);
  assert.equal(reopened.reminders[0]?.status, 'cancelled');
});

test('北京时间调度、时刻校验、修改日期重排、清空日期取消提醒', async () => {
  assert.equal(packingReminderAt('2099-11-20', 'day-before'), '2099-11-19T11:00:00.000Z');
  assert.equal(packingReminderAt('2099-11-20', 'two-days-before'), '2099-11-18T11:00:00.000Z');
  assert.equal(packingReminderAt('2027-01-01', 'two-days-before'), '2026-12-30T11:00:00.000Z');
  const list = await create();
  assert.equal(list.departureTime, '07:00');
  assert.equal((await authorize(list, 3)).status, 400);
  assert.equal((await patch(list, { departureTime: '25:10' })).status, 400);
  const scheduled = await packing(await authorize(list));
  assert.equal(scheduled.departureTime, '07:00');
  assert.equal(Date.parse(scheduled.reminders[0].scheduledAt), Date.parse('2099-11-19T11:00:00Z'));
  const moved = await packing(await patch(scheduled, { startOn: '2099-11-21' }));
  assert.equal(Date.parse(moved.reminders[0].scheduledAt), Date.parse('2099-11-20T11:00:00Z'));
  const cleared = await packing(await patch(moved, { startOn: null }));
  assert.equal(cleared.reminders[0]?.status, 'cancelled');
  const past = await packing(await patch(cleared, { startOn: '2020-01-01', endOn: '2020-01-02' }));
  assert.equal((await packing(await authorize(past))).reminders.every(item => item.status === 'cancelled'), true);
});

test('未配置显示不可用；配置好后授权信息与模板 ID 可读取', async () => {
  config.WECHAT_PACKING_TEMPLATE_ID = '';
  const unavailable = z.object({ data: capabilitiesSchema }).parse(await (await call('GET', '/capabilities')).json());
  assert.equal(unavailable.data.packingReminder.available, false);
  assert.deepEqual((await create()).reminders, []);
  config.WECHAT_PACKING_TEMPLATE_ID = 'local-packing-template';
  const available = z.object({ data: capabilitiesSchema }).parse(await (await call('GET', '/capabilities')).json());
  assert.equal(available.data.packingReminder.available, true);
});

test('保存时自动安排两天、各发一次；第一次后收齐跳过第二次', async () => {
  const both = await create('自动排程', clothes, 2);
  assert.equal(both.reminders.length, 2);
  assert.equal(Date.parse(both.reminders[0].scheduledAt), Date.parse('2099-11-18T11:00:00Z'));
  assert.equal(Date.parse(both.reminders[1].scheduledAt), Date.parse('2099-11-19T11:00:00Z'));
  const unchanged = await packing(await authorize(both));
  assert.equal(unchanged.reminders.length, 2);
  await makeDue(both.id, 'two-days-before');
  await Promise.all([processNextPackingReminder(), processNextPackingReminder()]);
  assert.equal(fixture.messages.length, 1);
  assert.equal(await processNextPackingReminder(), false);
  await makeDue(both.id);
  await Promise.all([processNextPackingReminder(), processNextPackingReminder()]);
  assert.equal(fixture.messages.length, 2);
  assert.equal(await processNextPackingReminder(), false);
  assert.equal((await packing(await call('GET', `/packing-lists/${both.id}`))).reminders.every(item => item.status === 'sent'), true);

  const pending = await create('收齐后跳过', clothes, 2);
  await makeDue(pending.id, 'two-days-before');
  await processNextPackingReminder();
  const latest = await packing(await call('GET', `/packing-lists/${pending.id}`));
  await packing(await patch(latest, { items: latest.items.map(item => ({ clothingId: item.clothingId, packed: true })) }));
  await makeDue(pending.id);
  await processNextPackingReminder();
  assert.equal(fixture.messages.length, 3);
  assert.equal((await packing(await call('GET', `/packing-lists/${pending.id}`))).reminders.find(item => item.timing === 'day-before')?.status, 'skipped');
});

test('真实队列只认领一次，字段正确、时刻真实、长名称截断', async () => {
  const list = await packing(await authorize(await create('这是一个超过二十个字符的真实测试行程名称用于验证截断')));
  await makeDue(list.id);
  await Promise.all([processNextPackingReminder(), processNextPackingReminder()]);
  assert.equal(fixture.messages.length, 1);
  const message = fixture.messages[0];
  assert.equal([...message.data.thing1.value].length, 20);
  assert.equal(message.data.time8.value, '2099-11-20 07:00');
  assert.equal(message.data.thing6.value, '还有2件衣物未收拾');
  assert.equal(message.page, `pages/packing-detail/packing-detail?id=${list.id}`);
  assert.equal((await packing(await call('GET', `/packing-lists/${list.id}`))).reminders[0]?.status, 'sent');
  assert.equal(await processNextPackingReminder(), false);
});

test('收齐、取消、结束、过期时不发送；空清单提醒补充衣物', async () => {
  const ready = await packing(await authorize(await create()));
  await packing(await patch(ready, { items: ready.items.map(item => ({ clothingId: item.clothingId, packed: true })) }));
  await makeDue(ready.id);
  await processNextPackingReminder();
  assert.equal((await packing(await call('GET', `/packing-lists/${ready.id}`))).reminders[0]?.status, 'skipped');
  const cancelled = await packing(await authorize(await create()));
  await packing(await patch(cancelled, { startOn: null }));
  await makeDue(cancelled.id);
  assert.equal(await processNextPackingReminder(), false);
  const ended = await packing(await authorize(await create()));
  await packing(await call('PATCH', `/packing-lists/${ended.id}/status`, { version: ended.version, ended: true }));
  await makeDue(ended.id);
  assert.equal(await processNextPackingReminder(), false);
  const expired = await packing(await authorize(await create()));
  await pool.query("UPDATE packing_reminders SET scheduled_at=now()-interval '7 hours' WHERE packing_list_id=$1", [expired.id]);
  await processNextPackingReminder();
  assert.equal(fixture.messages.length, 0);
  const empty = await packing(await authorize(await create('空行李箱', [])));
  await makeDue(empty.id);
  await processNextPackingReminder();
  assert.equal(fixture.messages[0].data.thing6.value, '尚未添加出行衣物');
});

test('明确拒收和网络结果未知均不自动重发；未知结果不可重复开启', async () => {
  fixture.mode = 'rejected';
  const rejected = await packing(await authorize(await create()));
  await makeDue(rejected.id);
  await processNextPackingReminder();
  assert.equal((await packing(await call('GET', `/packing-lists/${rejected.id}`))).reminders[0]?.status, 'failed');
  assert.equal(await processNextPackingReminder(), false);
  fixture.mode = 'unknown';
  const uncertain = await packing(await authorize(await create()));
  await makeDue(uncertain.id);
  await processNextPackingReminder();
  const latest = await packing(await call('GET', `/packing-lists/${uncertain.id}`));
  assert.equal(latest.reminders[0]?.status, 'unknown');
  const saved = await packing(await authorize(latest));
  assert.equal(saved.reminders.find(item => item.timing === 'day-before')?.status, 'unknown');
  assert.equal(await processNextPackingReminder(), false);
  assert.equal(fixture.messages.length, 2);
});

test('获取微信凭证期间结束行程，发送前再次检查并取消', async () => {
  fixture.mode = 'invalid-token';
  const invalid = await packing(await authorize(await create()));
  await makeDue(invalid.id);
  await processNextPackingReminder();
  fixture.mode = 'sent';
  const gate = { resolve: () => {} };
  fixture.tokenGate = new Promise<void>(resolve => { gate.resolve = resolve; });
  const list = await packing(await authorize(await create()));
  await makeDue(list.id);
  const tokenRequested = once(supplier, 'token-requested');
  const processing = processNextPackingReminder();
  try {
    await tokenRequested;
    await packing(await call('PATCH', `/packing-lists/${list.id}/status`, { version: list.version, ended: true }));
  } finally {
    gate.resolve();
  }
  await processing;
  assert.equal(fixture.messages.length, 1);
  assert.equal((await packing(await call('GET', `/packing-lists/${list.id}`))).reminders[0]?.status, 'cancelled');
});

async function runPage(pageName: string, body: string, id = '') {
  const bundle = await build({ entryPoints: [`miniprogram/pages/${pageName}/${pageName}.ts`], bundle: true, platform: 'neutral', format: 'iife', target: 'es2020', write: false });
  await runInNewContext(`
    var page;
    var calls = [];
    var updates = [];
    var subscription = 'accept';
    var subscriptions = 0;
    var navigation = '';
    function Page(options) { page = options; }
    var wx = {
      getStorageSync() { return token; }, showToast() {},
      navigateTo(options) { navigation = options.url; },
      async requestSubscribeMessage(options) {
        subscriptions++;
        if (subscription === 'error') throw new Error('网络错误');
        return { [options.tmplIds[0]]: subscription };
      },
      request(options) {
        const controller = new AbortController();
        const url = new URL(options.url);
        calls.push(url.pathname);
        Promise.resolve().then(async () => {
          try {
            const response = await fetch(base.slice(0, -4) + url.pathname + url.search, { method: options.method, headers: { ...options.header, 'Content-Type': 'application/json' }, body: options.data === undefined ? undefined : JSON.stringify(options.data), signal: controller.signal });
            options.success({ statusCode: response.status, data: await response.json() });
          } catch (error) { options.fail({ errMsg: error.message }); }
        });
        return { abort() { controller.abort(); } };
      }
    };
    ${bundle.outputFiles[0].text}
    page.setData = function(values) {
      updates.push(values);
      for (const [path, value] of Object.entries(values)) {
        const keys = path.replaceAll('[', '.').replaceAll(']', '').split('.');
        keys.slice(0, -1).reduce((obj, key) => obj[key], this.data)[keys.at(-1)] = value;
      }
    };
    (async () => { page.id = id; ${body} page.onUnload(); })();
  `, { assert, token, base, id, fetch, URL, AbortController, console, setTimeout, clearTimeout });
}

test('创建页确认日期范围仅更新草稿，最终创建才申请一次授权', async () => {
  await runPage('packing-lists', `
    await page.load(true);
    page.onAdd();
    page.onInput({ detail: { value: '页面自动提醒' } });
    page.onOpenDate();
    page.onDate({ detail: { startOn: '2099-11-20', endOn: '2099-11-23' } });
    assert.equal(subscriptions, 0);
    assert.equal(page.reminderSubscriptions, 0);
    assert.equal(page.data.draft.endOn, '2099-11-23');
    await page.onCreate();
    assert.equal(page.data.formError, '');
    assert.equal(subscriptions, 1);
    assert.ok(navigation);
    const response = await fetch(base + '/packing-lists/' + navigation.split('id=')[1], { headers: { Authorization: 'Bearer ' + token } });
    const saved = (await response.json()).data;
    assert.equal(saved.departureTime, '07:00');
    assert.equal(saved.reminders.length, 1);
    assert.equal(saved.reminders[0].timing, 'day-before');
    assert.equal(saved.startOn, '2099-11-20');
    assert.equal(saved.endOn, '2099-11-23');
    assert.equal(saved.reminders.every(item => item.status === 'scheduled'), true);
  `);
});

test('拒绝授权或授权网络错误仍保存清单，不创建虚假提醒；未选日期不申请', async () => {
  for (const choice of ['reject', 'error']) {
    await runPage('packing-lists', `
      await page.load(true);
      page.onAdd();
      page.onInput({ detail: { value: '授权失败也保存' } });
      subscription = '${choice}';
      page.onOpenDate();
      page.onDate({ detail: { startOn: '2099-11-20', endOn: '2099-11-23' } });
    assert.equal(subscriptions, 0);
      await page.onCreate();
      assert.equal(page.data.formError, '');
      assert.ok(navigation);
      const response = await fetch(base + '/packing-lists/' + navigation.split('id=')[1], { headers: { Authorization: 'Bearer ' + token } });
      assert.equal((await response.json()).data.reminders.length, 0);
    `);
  }
  await runPage('packing-lists', `
    await page.load(true);
    page.onAdd();
    page.onInput({ detail: { value: '日期待定' } });
    await page.onCreate();
    assert.equal(subscriptions, 0);
    assert.ok(navigation);
  `);
});

test('详情改期自动重排，不再选择提醒日；已有授权足够时不重复索取，勾选不重载', async () => {
  const list = await create('自动改期', clothes, 2);
  await runPage('packing-detail', `
    await page.load();
    assert.equal(page.data.error, '');
    assert.equal(typeof page.onOpenReminder, 'undefined');
    page.onEditList();
    page.onOpenDate();
    page.onDate({ detail: { startOn: '2099-11-21', endOn: '2099-11-24' } });
    assert.equal(subscriptions, 0);
    await page.onSave();
    assert.equal(page.data.error, '');
    assert.equal(subscriptions, 0);
    assert.equal(page.data.reminders.filter(item => item.status === 'scheduled').length, 2);
    assert.equal(Date.parse(page.data.reminders[0].scheduledAt), Date.parse('2099-11-19T11:00:00Z'));
    assert.equal(Date.parse(page.data.reminders[1].scheduledAt), Date.parse('2099-11-20T11:00:00Z'));
    const image = page.data.items[0].imageUrl;
    calls.length = 0;
    updates.length = 0;
    await page.onToggle({ currentTarget: { dataset: { id: page.data.items[0].clothingId } } });
    assert.equal(page.data.items[0].packed, true);
    assert.equal(page.data.items[0].imageUrl, image);
    assert.equal(calls.length, 1);
    assert.equal(updates.some(update => 'loading' in update), false);
    await page.onChangeStatus();
    assert.ok(page.data.endedAt);
    assert.equal(page.data.reminders.every(item => item.status === 'cancelled'), true);
    calls.length = 0;
    await page.onToggle({ currentTarget: { dataset: { id: page.data.items[0].clothingId } } });
    assert.equal(calls.length, 0);
  `, list.id);
});

test('已有无提醒清单修改日期并保存，自动授权与建立提醒', async () => {
  const list = await create();
  await runPage('packing-detail', `
    await page.load();
    assert.equal(page.data.reminders.length, 0);
    page.onEditList();
    page.onOpenDate();
    page.onDate({ detail: { startOn: '2099-11-21', endOn: '2099-11-24' } });
    assert.equal(subscriptions, 0);
    await page.onSave();
    assert.equal(subscriptions, 1);
    assert.equal(page.data.error, '');
    assert.equal(page.data.reminders.filter(item => item.status === 'scheduled').length, 1);
  `, list.id);
});


test('详情只保存实际更改的日期才申请，取消日期草稿和修改名称不申请', async () => {
  const list = await create();
  await runPage('packing-detail', `
    await page.load();
    page.onEditList();
    page.onOpenDate();
    page.onCloseDate();
    assert.equal(page.data.dateOpen, false);
    await page.onSave();
    assert.equal(subscriptions, 0);
    page.onEditList();
    page.onInput({ detail: { value: '只修改名称' } });
    await page.onSave();
    assert.equal(subscriptions, 0);
    assert.equal(page.data.name, '只修改名称');
    page.onEditList();
    page.onOpenDate();
    page.onDate({ detail: { startOn: page.data.startOn, endOn: page.data.endOn } });
    await page.onSave();
    assert.equal(subscriptions, 0);
    page.onEditList();
    page.onClearDates();
    await page.onSave();
    assert.equal(subscriptions, 0);
    assert.equal(page.data.startOn, '');
  `, list.id);
});

test('范围日历支持跨月、反向选取、当天往返及取消重开，单日期模式保持原行为', async () => {
  const bundle = await build({ entryPoints: ['miniprogram/components/app-date-sheet/app-date-sheet.ts'], bundle: true, platform: 'neutral', format: 'iife', target: 'es2020', write: false });
  runInNewContext(`
    var component;
    var events = [];
    function Component(options) { component = options; }
    ${bundle.outputFiles[0].text}
    Object.assign(component, component.methods);
    component.properties = { visible: true, range: true, startOn: '', endOn: '', value: '', min: '0001-01-01', max: '9999-12-31' };
    component.setData = function(values) { Object.assign(this.data, values); };
    component.triggerEvent = function(name, detail) { events.push({ name, detail }); };
    function open() { Object.values(component.observers)[0].call(component); }
    function select(date) { component.onDate({ currentTarget: { dataset: { date } } }); }
    open();
    component.onConfirm();
    assert.equal(events.length, 0);
    select('2099-11-30');
    component.onConfirm();
    assert.equal(events.length, 0);
    component.renderMonth('2099-11');
    component.onNavigate({ currentTarget: { dataset: { offset: 1 } } });
    assert.equal(component.data.month, '2099-12');
    select('2099-12-03');
    component.onConfirm();
    assert.equal(events.at(-1).detail.startOn, '2099-11-30');
    assert.equal(events.at(-1).detail.endOn, '2099-12-03');
    select('2099-12-08');
    assert.equal(component.data.draftEnd, '');
    select('2099-12-05');
    assert.equal(component.data.draftStart, '2099-12-05');
    assert.equal(component.data.draftEnd, '2099-12-08');
    select('2099-12-10');
    select('2099-12-10');
    component.onConfirm();
    assert.equal(events.at(-1).detail.startOn, events.at(-1).detail.endOn);
    component.properties.startOn = '2099-11-20';
    component.properties.endOn = '2099-11-23';
    open();
    select('2099-12-10');
    component.onClose();
    open();
    assert.equal(component.data.draftStart, '2099-11-20');
    assert.equal(component.data.draftEnd, '2099-11-23');
    component.onToday();
    assert.equal(component.data.draftStart, component.data.today);
    assert.equal(component.data.draftEnd, '');
    component.properties.range = false;
    component.properties.value = '2099-12-20';
    open();
    assert.equal(component.data.draft, '2099-12-20');
    select('2099-12-21');
    component.onConfirm();
    assert.equal(events.at(-1).detail.value, '2099-12-21');
  `, { assert });
});

test('清单可搜索并整套选入，跨单品和搭配去重，确认前不写入且保留已有收拾状态', async () => {
  const response = await call('POST', '/clothing-sets', { name: '出行套装', coverAssetId: null, memberIds: clothes });
  assert.equal(response.status, 201);
  const set = z.object({ data: z.object({ id: z.string() }) }).parse(await response.json()).data;
  const outfit = await call('POST', '/outfits', { name: '同款出行搭配', items: clothes.map((clothingId, index) => ({ clothingId, x: 0, y: 0, width: 0.5, height: 0.5, rotation: 0, zIndex: index })) });
  assert.equal(outfit.status, 201);
  const list = await packing(await patch(await create('套装选择', [clothes[0]]), { items: [{ clothingId: clothes[0], packed: true }] }));
  await runPage('packing-detail', `
    await page.load();
    await page.onChoose();
    page.onSelect({ currentTarget: { dataset: { id: '${clothes[1]}' } } });
    await page.onAddTab({ currentTarget: { dataset: { tab: 'sets' } } });
    assert.equal(page.data.addTab, 'sets');
    assert.equal(page.data.setError, '');
    assert.equal(page.data.sets.find(item => item.id === '${set.id}').previews.length, 2);
    assert.equal(page.data.sets.find(item => item.id === '${set.id}').remainingCount, 0);
    assert.equal(page.data.sets.find(item => item.id === '${set.id}').members.find(item => item.id === '${clothes[0]}').included, true);
    page.onSetSearchInput({ detail: { value: '找不到的套装' } });
    await page.onSetSearch();
    assert.equal(page.data.sets.length, 0);
    assert.equal(page.data.setsTotal, 0);
    page.onSetSearchInput({ detail: { value: '出行套装' } });
    await page.onSetSearch();
    assert.equal(page.data.sets.length, 1);
    const selection = { currentTarget: { dataset: { id: '${set.id}', source: 'sets' } } };
    await page.onAddGroup(selection);
    assert.equal(page.data.selectedChoices.length, 1);
    page.onSelect({ currentTarget: { dataset: { id: '${clothes[1]}' } } });
    assert.equal(page.data.selectedChoices.length, 0);
    assert.equal(page.data.sets[0].remainingCount, 1);
    await page.onAddGroup(selection);
    await page.onAddGroup(selection);
    assert.equal(page.data.selectedChoices.length, 1);
    assert.equal(page.data.sets[0].remainingCount, 0);
    assert.equal(page.data.sets[0].members.find(item => item.id === '${clothes[1]}').selected, true);
    assert.equal(page.data.choices.find(item => item.id === '${clothes[1]}').selected, true);
    await page.onAddTab({ currentTarget: { dataset: { tab: 'outfits' } } });
    await page.onAddGroup({ currentTarget: { dataset: { id: page.data.outfits.find(item => item.name === '同款出行搭配').id, source: 'outfits' } } });
    assert.equal(page.data.selectedChoices.length, 1);
    const beforeSave = await fetch(base + '/packing-lists/' + id, { headers: { Authorization: 'Bearer ' + token } });
    assert.equal((await beforeSave.json()).data.items.length, 1);
    await page.onSave();
    assert.equal(page.data.error, '');
    assert.equal(page.data.items.length, 2);
    assert.equal(page.data.items.find(item => item.clothingId === '${clothes[0]}').packed, true);
    assert.equal(page.data.items.find(item => item.clothingId === '${clothes[1]}').packed, false);
    assert.equal(subscriptions, 0);
  `, list.id);
  for (const first of clothes) {
    const empty = await create('先选一件再补齐', []);
    await runPage('packing-detail', `
      await page.load();
      await page.onChoose();
      page.onSelect({ currentTarget: { dataset: { id: '${first}' } } });
      await page.onAddTab({ currentTarget: { dataset: { tab: 'sets' } } });
      assert.equal(page.data.sets.find(item => item.id === '${set.id}').remainingCount, 1);
      await page.onAddGroup({ currentTarget: { dataset: { id: '${set.id}', source: 'sets' } } });
      assert.equal(page.data.selectedChoices.length, 2);
      assert.equal(page.data.sets.find(item => item.id === '${set.id}').remainingCount, 0);
      assert.equal(page.data.sets.find(item => item.id === '${set.id}').members.every(item => item.selected), true);
      await page.onSave();
      assert.equal(page.data.items.length, 2);
      assert.equal(new Set(page.data.items.map(item => item.clothingId)).size, 2);
    `, empty.id);
  }
});

test('套装选择遵守100件上限，含已归档成员时整套不选入', async () => {
  const members = (await pool.query<{ id: string }>("INSERT INTO clothes(user_id,name,category_id,primary_asset_id,status) SELECT $1,'套装边界单品',$2,$3,'active' FROM generate_series(1,101) RETURNING id", [owner, category, asset])).rows.map(item => item.id);
  const response = await call('POST', '/clothing-sets', { name: '边界测试套装', coverAssetId: asset, memberIds: members.slice(99) });
  assert.equal(response.status, 201);
  const set = z.object({ data: z.object({ id: z.string() }) }).parse(await response.json()).data;
  const list = await create('容量测试', members.slice(0, 99));
  await runPage('packing-detail', `
    await page.load();
    await page.onChoose();
    await page.onAddTab({ currentTarget: { dataset: { tab: 'sets' } } });
    assert.equal(page.data.sets.find(item => item.id === '${set.id}').previews.length, 1);
    await page.onAddGroup({ currentTarget: { dataset: { id: '${set.id}', source: 'sets' } } });
    assert.equal(page.data.selectedChoices.length, 0);
    assert.equal(page.data.error, '每份清单最多添加 100 件衣物');
  `, list.id);
  await pool.query("UPDATE clothes SET status='archived' WHERE id=$1", [members[100]]);
  const empty = await create('归档套装测试', []);
  await runPage('packing-detail', `
    await page.load();
    await page.onChoose();
    await page.onAddTab({ currentTarget: { dataset: { tab: 'sets' } } });
    await page.onAddGroup({ currentTarget: { dataset: { id: '${set.id}', source: 'sets' } } });
    assert.equal(page.data.selectedChoices.length, 0);
    assert.equal(page.data.addingGroup, '');
    assert.equal(page.data.error, '套装中有衣物已归档或未入橱，请先调整套装');
  `, empty.id);
});

test('清单原地移除衣物保留收拾状态和衣橱原件，防止重复提交并支持移空后重新添加', async () => {
  const list = await packing(await patch(await create('移除衣物'), { items: clothes.map((clothingId, index) => ({ clothingId, packed: index === 0 })) }));
  await runPage('packing-detail', `
    await page.load();
    const remove = id => ({ currentTarget: { dataset: { id } } });
    calls.length = 0;
    updates.length = 0;
    await Promise.all([page.onRemoveItem(remove('${clothes[1]}')), page.onRemoveItem(remove('${clothes[1]}'))]);
    assert.equal(calls.length, 1);
    assert.equal(page.data.items.length, 1);
    assert.equal(page.data.items[0].packed, true);
    assert.equal(page.data.total, 1);
    assert.equal(page.data.packedCount, 1);
    assert.equal(page.data.progress, '100%');
    assert.equal(page.data.groups[0].total, 1);
    assert.equal(page.data.groups[0].packedCount, 1);
    assert.equal(updates.some(update => update.loading === true), false);
    assert.equal(page.data.busy, false);
    assert.equal(page.data.removingId, '');
    assert.equal(page.version, ${list.version + 1});
    const response = await fetch(base + '/packing-lists/' + id, { headers: { Authorization: 'Bearer ' + token } });
    const saved = (await response.json()).data;
    assert.equal(saved.items.length, 1);
    assert.equal(saved.items[0].packed, true);
    assert.equal(saved.startOn, '${list.startOn}');
    await page.onRemoveItem(remove('${clothes[0]}'));
    assert.equal(page.data.total, 0);
    assert.equal(page.data.packedCount, 0);
    assert.equal(page.data.progress, '0%');
    assert.equal(page.data.groups.length, 0);
    await page.onChoose();
    page.setData({ query: '外套' });
    await page.loadChoices(true);
    assert.equal(page.data.choices.find(item => item.id === '${clothes[1]}').included, false);
    page.onSelect(remove('${clothes[1]}'));
    await page.onSave();
    assert.equal(page.data.items.length, 1);
    assert.equal(page.data.items[0].clothingId, '${clothes[1]}');
    assert.equal(page.data.items[0].packed, false);
    assert.equal(subscriptions, 0);
  `, list.id);
  assert.equal((await pool.query('SELECT id FROM clothes WHERE user_id=$1 AND id=ANY($2::uuid[])', [owner, clothes])).rows.length, clothes.length);
});

test('移除衣物版本冲突时保留列表，已结束行程禁止移除', async () => {
  const list = await create('移除冲突');
  await runPage('packing-detail', `
    await page.load();
    page.version--;
    await page.onRemoveItem({ currentTarget: { dataset: { id: '${clothes[0]}' } } });
    assert.equal(page.data.items.length, 2);
    assert.equal(page.data.total, 2);
    assert.equal(page.data.busy, false);
    assert.equal(page.data.removingId, '');
    page.version++;
    await page.onChangeStatus();
    assert.ok(page.data.endedAt);
    calls.length = 0;
    await page.onRemoveItem({ currentTarget: { dataset: { id: '${clothes[0]}' } } });
    assert.equal(calls.length, 0);
    assert.equal(page.data.items.length, 2);
  `, list.id);
});
