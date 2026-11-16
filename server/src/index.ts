import { app } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';

await migrate();
const server = app.listen(config.PORT, config.HOST, () => console.log(JSON.stringify({ event: 'listening', url: `http://${config.HOST}:${config.PORT}` })));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => { void pool.end(); }));
