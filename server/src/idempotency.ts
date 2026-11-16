import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { transaction } from './db.js';
import { HttpError } from './errors.js';

export async function idempotent(userId: string, route: string, header: string | undefined, input: unknown, operation: (client: PoolClient) => Promise<unknown>) {
  const key = z.string().min(1).max(128).parse(header);
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${userId}:${route}:${key}`]);
    const existing = await client.query<{ request_hash: string; response: unknown }>('SELECT request_hash,response FROM idempotency_keys WHERE user_id=$1 AND route=$2 AND request_key=$3', [userId, route, key]);
    if (existing.rows.length) {
      if (existing.rows[0].request_hash !== hash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '同一请求编号不能用于不同内容');
      return existing.rows[0].response;
    }
    const response = await operation(client);
    await client.query('INSERT INTO idempotency_keys(user_id,route,request_key,request_hash,response) VALUES($1,$2,$3,$4,$5)', [userId, route, key, hash, JSON.stringify(response)]);
    return response;
  });
}
