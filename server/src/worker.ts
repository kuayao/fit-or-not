import { setTimeout } from 'node:timers/promises';
import { config } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { processNextImageJob, processNextExport, maintenance } from './background.js';
import { processNextPackingReminder } from './packing-reminders.js';

await migrate();
const lock = await pool.connect();
const acquired = await lock.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(732461803) AS acquired');
if (!acquired.rows[0].acquired) throw new Error('本项目已有任务进程运行');
const lifecycle = { stopping: false, lastMaintenance: 0 };
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { lifecycle.stopping = true; });
await pool.query("UPDATE data_exports SET status='failed',error_code='WORKER_RESTARTED' WHERE status='running'");
await pool.query("UPDATE packing_reminders SET status='unknown',error_code='WORKER_RESTARTED' WHERE status='sending'");
console.log(JSON.stringify({ event: 'worker_ready', mode: config.NODE_ENV }));
try {
  await Promise.all([
    (async () => {
      while (!lifecycle.stopping) {
        if (Date.now() - lifecycle.lastMaintenance > 15000) { await maintenance(); lifecycle.lastMaintenance = Date.now(); }
        const image = await processNextImageJob(); const exported = await processNextExport();
        if (!image && !exported) await setTimeout(1000);
      }
    })(),
    (async () => {
      while (!lifecycle.stopping) {
        if (!await processNextPackingReminder()) await setTimeout(1000);
      }
    })()
  ]);
} finally { await lock.query('SELECT pg_advisory_unlock(732461803)'); lock.release(); await pool.end(); }
