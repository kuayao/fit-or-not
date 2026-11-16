import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { servicesRouter } from '../server/src/services.js';
import { app } from '../server/src/app.js';
import { config } from '../server/src/config.js';
import { pool } from '../server/src/db.js';
import { HttpError } from '../server/src/errors.js';
import { paginationSchema, weatherLocationSchema, weatherSchema } from '../miniprogram/api/contracts.js';

const originalKey = config.AMAP_KEY;
config.AMAP_KEY = '';
const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof z.ZodError) { res.status(400).json({ error: { code: 'INVALID_INPUT' } }); return; }
  if (error instanceof HttpError) { res.status(error.status).json({ error: { code: error.code } }); return; }
  res.status(500).end();
};
async function listen(serverApp: express.Express) {
  const server = serverApp.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { server, base: `http://127.0.0.1:${address.port}/api` };
}
const direct = await listen(express().use('/api', servicesRouter).use(handleError));
const proxied = await listen(express().set('trust proxy', ['loopback']).use('/api', servicesRouter).use(handleError));
const production = await listen(app);
after(async () => {
  config.AMAP_KEY = originalKey;
  for (const target of [direct, proxied, production]) {
    target.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => target.server.close(error => error ? reject(error) : resolve()));
  }
  await pool.end();
});
const locationsResponse = z.object({ data: z.array(weatherLocationSchema), pagination: paginationSchema });
const errorResponse = z.object({ error: z.object({ code: z.string() }) });

test('地点目录：中文、拼音和省份限定均可检索县级市', async () => {
  for (const q of ['义乌', 'yiwu', '浙江 义乌']) {
    const response = await fetch(`${direct.base}/weather-locations?q=${encodeURIComponent(q)}`);
    assert.equal(response.status, 200);
    const result = locationsResponse.parse(await response.json());
    const city = result.data.find(city => city.path === '浙江省 · 金华市 · 义乌市');
    assert(city);
    assert.equal(city.name, '义乌市');
    assert.equal(city.cityCode, '330782');
  }
});
test('地点目录：同名地点、分页、稳定身份与成功空列表', async () => {
  const first = locationsResponse.parse(await (await fetch(`${direct.base}/weather-locations?q=朝阳&pageSize=2`)).json());
  const second = locationsResponse.parse(await (await fetch(`${direct.base}/weather-locations?q=朝阳&pageSize=2&page=2`)).json());
  assert(first.pagination.total > 2);
  assert.equal(second.pagination.total, first.pagination.total);
  assert.equal(new Set([...first.data, ...second.data].map(city => city.id)).size, 4);
  const all = locationsResponse.parse(await (await fetch(`${direct.base}/weather-locations?q=朝阳&pageSize=50`)).json());
  assert(all.data.some(city => city.path === '北京市 · 朝阳区'));
  assert(all.data.some(city => city.path === '辽宁省 · 朝阳市'));
  assert(all.data.some(city => city.path === '辽宁省 · 朝阳市 · 朝阳县'));
  const empty = locationsResponse.parse(await (await fetch(`${direct.base}/weather-locations?q=不存在的测试地点xyz`)).json());
  assert.equal(empty.pagination.total, 0);
  assert.deepEqual(empty.data, []);
});
test('IP 识别：不信任直连请求伪造的代理头，拒绝本地及私网地址', async () => {
  const spoofed = await fetch(`${direct.base}/weather?source=ip`, { headers: { 'X-Forwarded-For': '198.51.100.23' } });
  assert.equal(spoofed.status, 400);
  assert.equal(errorResponse.parse(await spoofed.json()).error.code, 'LOCATION_UNAVAILABLE');
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.1.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '2606:4700:4700::1111', '203.0.113.1, 192.168.1.1']) {
    const response = await fetch(`${proxied.base}/weather?source=ip`, { headers: { 'X-Forwarded-For': ip } });
    assert.equal(response.status, 400, ip);
    assert.equal(errorResponse.parse(await response.json()).error.code, 'LOCATION_UNAVAILABLE');
  }
});
test('IP 识别：可信代理的公网地址通过入口，缺少天气密钥时明确返回 503', async () => {
  for (const ip of ['198.51.100.23', '::ffff:198.51.100.23']) {
    const response = await fetch(`${proxied.base}/weather?source=ip`, { headers: { 'X-Forwarded-For': ip } });
    assert.equal(response.status, 503);
    assert.equal(errorResponse.parse(await response.json()).error.code, 'SERVICE_NOT_CONFIGURED');
  }
});
test('天气与地点查询入口：拒绝混传、缺失、越界与无效分页', async () => {
  for (const path of [
    '/weather', '/weather?source=other', '/weather?source=ip&cityCode=330100', '/weather?source=ip&ip=198.51.100.23',
    '/weather?latitude=30', '/weather?latitude=&longitude=120', '/weather?latitude=91&longitude=120',
    '/weather?latitude=30&longitude=-181', '/weather?cityCode=330100&latitude=30&longitude=120', '/weather?cityCode=hangzhou',
    '/weather?cityCode=330100&refresh=false', '/weather?cityCode=330100&refresh=1',
    '/weather-locations?q=', '/weather-locations?q=杭州&page=0', '/weather-locations?q=杭州&pageSize=51'
  ]) {
    const response = await fetch(`${direct.base}${encodeURI(path)}`);
    assert.equal(response.status, 400, path);
    assert.equal(errorResponse.parse(await response.json()).error.code, 'INVALID_INPUT', path);
  }
});
test('生产应用：使用配置的可信代理，天气与地点搜索均要求登录', async () => {
  assert.deepEqual(app.get('trust proxy'), config.TRUST_PROXY);
  for (const path of ['/weather?source=ip', '/weather-locations?q=杭州']) {
    const response = await fetch(`${production.base}${encodeURI(path)}`);
    assert.equal(response.status, 401);
    assert.equal(errorResponse.parse(await response.json()).error.code, 'SESSION_EXPIRED');
  }
});
test('高德真实接口：城市、区县、IP 与 GCJ02 坐标均返回实况及三日预报，缓存复用结果', { skip: process.env.RUN_AMAP_TESTS !== 'true' || !originalKey }, async () => {
  config.AMAP_KEY = originalKey;
  try {
    for (const [path, city, headers] of [
      ['/weather?cityCode=340800', '安庆市', {}],
      ['/weather?cityCode=340802', '迎江区', {}],
      ['/weather?cityCode=340822', '怀宁县', {}],
      ['/weather?cityCode=340882', '潜山市', {}],
      ['/weather?cityCode=330782', '义乌市', {}],
      ['/weather?source=ip', '北京市', { 'X-Forwarded-For': '114.247.50.2' }],
      ['/weather?longitude=116.397428&latitude=39.90923', '东城区', {}]
    ] as const) {
      await setTimeout(1000);
      const response = await fetch(`${proxied.base}${path}`, { headers });
      const payload: unknown = await response.json();
      assert.equal(response.status, 200, JSON.stringify({ path, payload }));
      const result = z.object({ data: weatherSchema }).parse(payload);
      assert.equal(result.data.city, city);
      assert.equal(result.data.source, '高德天气');
      assert.equal(result.data.stale, false);
      assert.match(result.data.updatedAt, /\+08:00$/);
      assert.match(result.data.current.updatedAt, /\+08:00$/);
      assert(result.data.current.weather.length > 0);
      assert(Number.isFinite(result.data.current.temperature));
      assert(result.data.current.windDirection.length > 0);
      assert(result.data.current.windPower.length > 0);
      assert(result.data.current.humidity >= 0 && result.data.current.humidity <= 100);
      assert.deepEqual(result.data.forecast.map(day => day.date), [0, 1, 2].map(offset => new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10)));
      assert.deepEqual(await (await fetch(`${proxied.base}${path}`, { headers })).json(), result);
    }
  } finally {
    config.AMAP_KEY = '';
  }
});
test('高德真实错误处理：手动刷新绕过缓存，失败保留实况及预报并标记 stale，跨日不复用', { skip: process.env.RUN_AMAP_TESTS !== 'true' || !originalKey }, async context => {
  config.AMAP_KEY = originalKey;
  try {
    const initialResponse = await fetch(`${proxied.base}/weather?cityCode=340822`);
    assert.equal(initialResponse.status, 200);
    const initial = z.object({ data: weatherSchema }).parse(await initialResponse.json());
    context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    config.AMAP_KEY = 'invalid-amap-test-key';
    assert.deepEqual(await (await fetch(`${proxied.base}/weather?cityCode=340822`)).json(), initial);
    const refreshed = await fetch(`${proxied.base}/weather?cityCode=340822&refresh=true`);
    assert.equal(refreshed.status, 200);
    assert.deepEqual(z.object({ data: weatherSchema }).parse(await refreshed.json()).data, { ...initial.data, stale: true });
    const denied = await fetch(`${proxied.base}/weather?cityCode=310101`);
    assert.equal(denied.status, 503);
    assert.equal(errorResponse.parse(await denied.json()).error.code, 'AMAP_ACCESS_DENIED');
    context.mock.timers.setTime(Date.now() + 11 * 60000);
    if (new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) === initial.data.forecast[0].date) {
      const stale = z.object({ data: weatherSchema }).parse(await (await fetch(`${proxied.base}/weather?cityCode=340822`)).json());
      assert.deepEqual(stale.data, { ...initial.data, stale: true });
    }
    context.mock.timers.setTime(Date.now() + 86400000);
    const nextDay = await fetch(`${proxied.base}/weather?cityCode=340822`);
    assert.equal(nextDay.status, 503);
    assert.equal(errorResponse.parse(await nextDay.json()).error.code, 'AMAP_ACCESS_DENIED');
  } finally {
    context.mock.timers.reset();
    config.AMAP_KEY = '';
  }
});
