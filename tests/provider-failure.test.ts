import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { providerFailure } from '../server/src/provider-failure.js';

test('真实连接错误：连接拒绝、TLS 握手中断与发送后断连分开处理', { timeout: 10000 }, async t => {
  const server = createServer().listen(0, '127.0.0.1');
  t.after(() => { server.close(); });
  await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await assert.rejects(fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(3000) }), error => {
    assert.equal(providerFailure(error).notSent, true);
    assert.equal(providerFailure(error).code, 'ECONNREFUSED');
    return true;
  });
  const http = createHttpServer(request => request.socket.destroy()).listen(0, '127.0.0.1');
  t.after(() => { http.closeAllConnections(); http.close(); });
  await once(http, 'listening');
  const httpAddress = http.address(); assert(httpAddress && typeof httpAddress !== 'string');
  await assert.rejects(fetch(`http://127.0.0.1:${httpAddress.port}`, { method: 'POST', body: 'already-sent', signal: AbortSignal.timeout(3000) }), error => {
    assert.equal(providerFailure(error).notSent, false);
    return true;
  });
  await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  assert.equal(providerFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' }) })).notSent, true);
  assert.equal(providerFailure(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })).notSent, false);
  assert.equal(providerFailure(new DOMException('timeout', 'TimeoutError')).notSent, false);
  assert.equal(providerFailure(new AggregateError([Object.assign(new Error(), { code: 'ECONNREFUSED' }), Object.assign(new Error(), { code: 'ENETUNREACH' })])).notSent, true);
  assert.equal(providerFailure(new AggregateError([Object.assign(new Error(), { code: 'ECONNREFUSED' }), new Error('unknown')])).notSent, false);
});
