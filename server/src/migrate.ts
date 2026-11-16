import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pool } from './db.js';

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("SET lock_timeout='10s'");
    await client.query('SELECT pg_advisory_lock(732461801)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, filename text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir('server/migrations')).filter(name => /^V\d+__.+\.sql$/.test(name)).sort((a, b) => Number(a.split('__')[0].slice(1)) - Number(b.split('__')[0].slice(1)));
    const migrations = await Promise.all(files.map(async filename => {
      const sql = await readFile(`server/migrations/${filename}`, 'utf8');
      return { filename, version: Number(filename.split('__')[0].slice(1)), checksum: createHash('sha256').update(sql).digest('hex'), sql };
    }));
    if (new Set(migrations.map(item => item.version)).size !== migrations.length) throw new Error('迁移文件存在重复版本');
    const history = await client.query<{ version: number; filename: string; checksum: string }>('SELECT version,filename,checksum FROM schema_migrations ORDER BY version');
    for (const applied of history.rows) {
      const migration = migrations.find(item => item.version === applied.version);
      if (!migration || migration.filename !== applied.filename || migration.checksum !== applied.checksum) throw new Error(`迁移历史不匹配，拒绝启动：${applied.filename}`);
    }
    for (const migration of migrations) {
      if (history.rows.some(item => item.version === migration.version)) continue;
      if (history.rows.some(item => item.version > migration.version)) throw new Error(`迁移顺序不匹配：${migration.filename}`);
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations(version,filename,checksum) VALUES($1,$2,$3)', [migration.version, migration.filename, migration.checksum]);
        await client.query('COMMIT');
        console.log(JSON.stringify({ event: 'migration_applied', filename: migration.filename }));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(732461801)');
    client.release();
  }
}
