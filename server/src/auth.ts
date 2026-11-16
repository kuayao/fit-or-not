import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { User } from '../../miniprogram/api/contracts.js';
import { config } from './config.js';
import { pool, transaction } from './db.js';
import type { Database } from './db.js';
import { HttpError, notFound } from './errors.js';
import { DEFAULT_CATEGORIES } from './default-categories.js';

declare global {
  namespace Express {
    interface Locals { user: User; sessionId: string; requestId: string; }
  }
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const userColumns = `id,nickname,avatar_asset_id AS "avatarAssetId",city_code AS "cityCode",timezone,preferences,version`;

export async function getUser(db: Database, id: string) {
  const result = await db.query<User>(`SELECT ${userColumns} FROM users WHERE id=$1 AND status='active'`, [id]);
  if (!result.rows.length) notFound();
  return result.rows[0];
}
async function createSession(db: Database, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  await db.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)', [userId, digest(token), expiresAt]);
  return { token, expiresAt, user: await getUser(db, userId) };
}
export const authenticate: RequestHandler = async (req, res, next) => {
  const header = req.get('Authorization');
  if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'SESSION_EXPIRED', '请先使用微信登录');
  const result = await pool.query<{ userId: string; sessionId: string }>(`SELECT s.user_id AS "userId",s.id AS "sessionId" FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL AND u.status='active'`, [digest(header.slice(7))]);
  if (!result.rows.length) throw new HttpError(401, 'SESSION_EXPIRED', '登录已过期，请重新登录');
  res.locals.user = await getUser(pool, result.rows[0].userId);
  res.locals.sessionId = result.rows[0].sessionId;
  next();
};

const wechatResponseSchema = z.object({ openid: z.string().optional(), session_key: z.string().optional(), errcode: z.number().optional() });
export const authRouter = Router();
authRouter.post('/wechat', async (req, res) => {
  const input = z.object({ code: z.string().min(1).max(256) }).strict().parse(req.body);
  if (!config.WECHAT_APP_SECRET) throw new HttpError(503, 'WECHAT_NOT_CONFIGURED', '后端尚未配置微信 AppSecret，请在本机 .env 中填写后重启');
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.search = new URLSearchParams({ appid: config.WECHAT_APP_ID, secret: config.WECHAT_APP_SECRET, js_code: input.code, grant_type: 'authorization_code' }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) }).catch(() => { throw new HttpError(502, 'WECHAT_UNAVAILABLE', '无法连接微信登录服务，请稍后重试'); });
  if (!response.ok) throw new HttpError(502, 'WECHAT_UNAVAILABLE', '微信登录服务暂时不可用，请重试');
  const payload: unknown = await response.json();
  const result = wechatResponseSchema.parse(payload);
  if (result.errcode || !result.openid || !result.session_key) throw new HttpError(401, 'WECHAT_LOGIN_FAILED', '微信登录凭证无效，请重新登录');
  const existing = await pool.query<{ id: string; status: string }>('SELECT id,status FROM users WHERE wechat_openid=$1', [result.openid]);
  if (existing.rows.length) {
    if (existing.rows[0].status !== 'active') throw new HttpError(403, 'MEMBER_DISABLED', '当前账号不可用');
    res.json({ data: await createSession(pool, existing.rows[0].id) });
    return;
  }
  const registrationToken = randomBytes(32).toString('base64url');
  await pool.query("INSERT INTO registrations(token_hash,wechat_openid,expires_at) VALUES($1,$2,now()+interval '5 minutes')", [digest(registrationToken), result.openid]);
  res.json({ data: { requiresInvitation: true, registrationToken } });
});
authRouter.post('/invitations/redeem', async (req, res) => {
  const input = z.object({ registrationToken: z.string().min(1).max(128), invitationCode: z.string().trim().min(1).max(128) }).strict().parse(req.body);
  const session = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(732461802)');
    const registration = await client.query<{ wechat_openid: string }>('DELETE FROM registrations WHERE token_hash=$1 AND expires_at>now() RETURNING wechat_openid', [digest(input.registrationToken)]);
    if (!registration.rows.length) throw new HttpError(401, 'REGISTRATION_EXPIRED', '登录凭证已过期，请重新微信登录');
    const existing = await client.query<{ id: string; status: string }>('SELECT id,status FROM users WHERE wechat_openid=$1', [registration.rows[0].wechat_openid]);
    if (existing.rows.length) {
      if (existing.rows[0].status !== 'active') throw new HttpError(403, 'MEMBER_DISABLED', '当前账号不可用');
      return createSession(client, existing.rows[0].id);
    }
    const invitation = await client.query<{ id: string }>('SELECT id FROM invitations WHERE code_hash=$1 AND expires_at>now() AND consumed_at IS NULL FOR UPDATE', [digest(input.invitationCode)]);
    if (!invitation.rows.length) throw new HttpError(403, 'INVITATION_INVALID', '邀请码无效、已使用或已过期');
    const count = await client.query<{ count: number }>("SELECT count(*)::integer AS count FROM users WHERE status IN ('active','disabled')");
    if (count.rows[0].count >= config.MEMBER_LIMIT) throw new HttpError(403, 'MEMBER_LIMIT', '成员名额已满');
    const created = await client.query<{ id: string }>('INSERT INTO users(wechat_openid) VALUES($1) RETURNING id', [registration.rows[0].wechat_openid]);
    for (const [index, category] of DEFAULT_CATEGORIES.entries()) {
      await client.query('INSERT INTO categories(user_id,name,sort_order,size_kind) VALUES($1,$2,$3,$4)', [created.rows[0].id, category.name, index, category.sizeKind]);
    }
    await client.query('UPDATE invitations SET consumed_by=$1,consumed_at=now() WHERE id=$2', [created.rows[0].id, invitation.rows[0].id]);
    return createSession(client, created.rows[0].id);
  });
  res.status(201).json({ data: session });
});
authRouter.post('/logout', authenticate, async (_req, res) => {
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [res.locals.sessionId]);
  res.sendStatus(204);
});
