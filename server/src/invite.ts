import { randomBytes } from 'node:crypto';
import { digest } from './auth.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';

await migrate();
const code = randomBytes(9).toString('base64url');
await pool.query("INSERT INTO invitations(code_hash,expires_at) VALUES($1,now()+interval '72 hours')", [digest(code)]);
console.log(`一次性邀请码（72 小时有效）：${code}`);
await pool.end();
