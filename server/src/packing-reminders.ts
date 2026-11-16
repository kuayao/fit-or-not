import { z } from 'zod';
import type { PackingList } from '../../miniprogram/api/contracts.js';
import { config } from './config.js';
import { pool, transaction } from './db.js';
import type { Database } from './db.js';

export function packingReminderAt(startOn: string, timing: PackingList['reminders'][number]['timing']) {
  return new Date(Date.parse(`${startOn}T19:00:00+08:00`) - (timing === 'two-days-before' ? 2 : 1) * 86400000).toISOString();
}
export function packingRemindersAvailable() {
  return Boolean(config.WECHAT_APP_SECRET && config.WECHAT_PACKING_TEMPLATE_ID);
}

export async function syncPackingReminders(db: Database, userId: string, id: string, startOn: string | null, current: Pick<PackingList, 'startOn' | 'reminders'>, subscriptions: number) {
  const available = subscriptions + current.reminders.filter(item => ['scheduled', 'sending'].includes(item.status)).length;
  await db.query("UPDATE packing_reminders SET status='cancelled' WHERE user_id=$1 AND packing_list_id=$2 AND status IN ('scheduled','sending')", [userId, id]);
  if (!startOn) return;
  const times = (['day-before', 'two-days-before'] as const).map(timing => ({ timing, scheduledAt: packingReminderAt(startOn, timing) })).filter(item => Date.parse(item.scheduledAt) > Date.now() && !(current.startOn === startOn && current.reminders.some(reminder => reminder.timing === item.timing && reminder.status === 'unknown')));
  for (const reminder of times.slice(0, available)) {
    await db.query(`INSERT INTO packing_reminders(user_id,packing_list_id,timing,scheduled_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(packing_list_id,timing) DO UPDATE SET scheduled_at=EXCLUDED.scheduled_at,status='scheduled',error_code=NULL,sent_at=NULL`, [userId, id, reminder.timing, reminder.scheduledAt]);
  }
}

const tokenSchema = z.union([
  z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }),
  z.object({ errcode: z.number() })
]);
const sendSchema = z.object({ errcode: z.number() });
const accessToken = { value: '', expiresAt: 0 };

async function getAccessToken() {
  if (accessToken.expiresAt > Date.now()) return accessToken.value;
  const response = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ grant_type: 'client_credential', appid: config.WECHAT_APP_ID, secret: config.WECHAT_APP_SECRET, force_refresh: false })
  });
  if (!response.ok) throw new Error('WECHAT_TOKEN_HTTP_ERROR');
  const payload: unknown = await response.json();
  const result = tokenSchema.parse(payload);
  if ('errcode' in result) throw new Error(`WECHAT_TOKEN_${result.errcode}`);
  accessToken.value = result.access_token;
  accessToken.expiresAt = Date.now() + Math.max(0, result.expires_in - 120) * 1000;
  return accessToken.value;
}

type ReminderDelivery = {
  id: string; name: string; startOn: string | null; departureTime: string | null; endedAt: string | null; userStatus: string;
  scheduledAt: string; timing: PackingList['reminders'][number]['timing']; openid: string; total: number; unpacked: number; status: string;
};
const deliveryColumns = `p.id,p.name,p.start_on AS "startOn",p.departure_time AS "departureTime",p.ended_at AS "endedAt",u.status AS "userStatus",
  r.scheduled_at::text AS "scheduledAt",r.timing,u.wechat_openid AS openid,r.status,
  (SELECT count(*)::integer FROM packing_items i WHERE i.user_id=p.user_id AND i.packing_list_id=p.id) AS total,
  (SELECT count(*)::integer FROM packing_items i WHERE i.user_id=p.user_id AND i.packing_list_id=p.id AND NOT i.packed) AS unpacked`;

function skipReminder(item: ReminderDelivery) {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  return Boolean(item.endedAt || item.userStatus !== 'active' || !item.startOn || !item.departureTime || item.startOn < today ||
    Date.parse(`${item.startOn}T${item.departureTime}:00+08:00`) <= Date.now() ||
    Date.now() - Date.parse(item.scheduledAt) > 6 * 3600000 || (item.total > 0 && item.unpacked === 0));
}

export async function processNextPackingReminder() {
  if (!packingRemindersAvailable()) return false;
  const reminder = await transaction(async client => {
    const result = await client.query<ReminderDelivery>(`SELECT ${deliveryColumns} FROM packing_lists p
      JOIN packing_reminders r ON p.user_id=r.user_id AND p.id=r.packing_list_id JOIN users u ON u.id=p.user_id
      WHERE r.status='scheduled' AND r.scheduled_at<=now()
      ORDER BY r.scheduled_at,p.id,r.timing FOR UPDATE OF p SKIP LOCKED LIMIT 1`);
    if (!result.rows.length) return null;
    const skipped = skipReminder(result.rows[0]);
    const claimed = await client.query("UPDATE packing_reminders SET status=$3,error_code=NULL WHERE packing_list_id=$1 AND timing=$2 AND status='scheduled' RETURNING packing_list_id", [result.rows[0].id, result.rows[0].timing, skipped ? 'skipped' : 'sending']);
    return claimed.rows.length ? { id: result.rows[0].id, timing: result.rows[0].timing, scheduledAt: result.rows[0].scheduledAt, skipped } : null;
  });
  if (!reminder) return false;
  if (reminder.skipped) return true;
  const token = await getAccessToken().catch(async () => {
    await pool.query("UPDATE packing_reminders SET status='failed',error_code='WECHAT_TOKEN_UNAVAILABLE' WHERE packing_list_id=$1 AND timing=$2 AND scheduled_at=$3 AND status='sending'", [reminder.id, reminder.timing, reminder.scheduledAt]);
    console.error(JSON.stringify({ event: 'packing_reminder_failed', packingListId: reminder.id, code: 'WECHAT_TOKEN_UNAVAILABLE' }));
    return '';
  });
  if (!token) return true;
  await transaction(async client => {
    const result = await client.query<ReminderDelivery>(`SELECT ${deliveryColumns} FROM packing_reminders r
      JOIN packing_lists p ON p.user_id=r.user_id AND p.id=r.packing_list_id JOIN users u ON u.id=p.user_id
      WHERE p.id=$1 AND r.timing=$2 AND r.scheduled_at=$3 FOR UPDATE OF p`, [reminder.id, reminder.timing, reminder.scheduledAt]);
    if (!result.rows.length || result.rows[0].status !== 'sending') return;
    const item = result.rows[0];
    if (skipReminder(item)) {
      await client.query("UPDATE packing_reminders SET status='skipped' WHERE packing_list_id=$1 AND timing=$2", [item.id, item.timing]);
      return;
    }
    const delivery = await (async () => {
      try {
        const response = await fetch(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
          body: JSON.stringify({
            touser: item.openid, template_id: config.WECHAT_PACKING_TEMPLATE_ID,
            page: `pages/packing-detail/packing-detail?id=${item.id}`, miniprogram_state: config.WECHAT_MESSAGE_ENV, lang: 'zh_CN',
            data: {
              thing1: { value: [...item.name.replace(/\s+/g, ' ')].slice(0, 20).join('') },
              time8: { value: `${item.startOn} ${item.departureTime}` },
              thing6: { value: item.total ? `还有${item.unpacked}件衣物未收拾` : '尚未添加出行衣物' }
            }
          })
        });
        if (!response.ok) return { status: 'unknown', code: 'WECHAT_HTTP_ERROR' };
        const payload: unknown = await response.json();
        const result = sendSchema.parse(payload);
        if ([40001, 40014, 42001].includes(result.errcode)) accessToken.expiresAt = 0;
        return result.errcode === 0 ? { status: 'sent', code: null } : { status: 'failed', code: `WECHAT_${result.errcode}` };
      } catch {
        return { status: 'unknown', code: 'WECHAT_RESULT_UNKNOWN' };
      }
    })();
    await client.query("UPDATE packing_reminders SET status=$3,error_code=$4,sent_at=CASE WHEN $3='sent' THEN now() END WHERE packing_list_id=$1 AND timing=$2", [item.id, item.timing, delivery.status, delivery.code]);
    console.log(JSON.stringify({ event: 'packing_reminder_processed', packingListId: item.id, timing: item.timing, status: delivery.status, code: delivery.code }));
  });
  return true;
}
