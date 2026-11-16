import pg from 'pg';
import type { PoolClient } from 'pg';
import { config } from './config.js';

pg.types.setTypeParser(1184, value => new Date(value).toISOString());
pg.types.setTypeParser(1082, value => value);
export const pool = new pg.Pool({
  host: config.DB_HOST, port: config.DB_PORT, database: config.DB_NAME,
  user: config.DB_USER, password: config.DB_PASSWORD, max: 5, connectionTimeoutMillis: 5000
});
export type Database = pg.Pool | PoolClient;

export async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
