import { z } from 'zod';
import { API_BASE_URL } from '../config/environment';
import { errorSchema } from '../api/contracts';

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export class CancelledRequest extends Error {}
let sessionToken = z.string().catch('').parse(wx.getStorageSync('sessionToken'));
export function saveSession(token: string) { sessionToken = token; wx.setStorageSync('sessionToken', token); }
export function clearSession() { sessionToken = ''; wx.removeStorageSync('sessionToken'); }
export function hasSession() { return Boolean(sessionToken); }
export function requireSession() {
  if (sessionToken) return true;
  wx.reLaunch({ url: '/pages/welcome/welcome' });
  return false;
}
export class RequestScope {
  active = true;
  hasShown = false;
  private tasks = new Set<WechatMiniprogram.RequestTask | WechatMiniprogram.UploadTask>();

  request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, schema: z.ZodType<T>, body?: object, key?: string, timeout = 15000) {
    if (!this.active) return Promise.reject<T>(new CancelledRequest());
    return new Promise<T>((resolve, reject) => {
      const task = wx.request({
        url: `${API_BASE_URL}${path}`, method: method === 'PATCH' ? 'POST' : method, data: body, timeout,
        header: { Authorization: sessionToken ? `Bearer ${sessionToken}` : '', ...(method === 'PATCH' ? { 'X-HTTP-Method-Override': 'PATCH' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        success: response => {
          this.tasks.delete(task);
          if (!this.active) { reject(new CancelledRequest()); return; }
          if (response.statusCode === 401 && sessionToken) { clearSession(); wx.reLaunch({ url: '/pages/welcome/welcome' }); }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const parsed = errorSchema.safeParse(response.data);
            reject(parsed.success ? new ApiError(parsed.data.error.code, parsed.data.error.message) : new ApiError('HTTP_ERROR', `请求失败（${response.statusCode}）`));
            return;
          }
          const parsed = schema.safeParse(response.statusCode === 204 ? undefined : response.data);
          if (!parsed.success) {
            console.error('response_validation_failed', { method, path, issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })) });
            reject(new ApiError('INVALID_RESPONSE', '服务返回的数据不符合接口约定')); return;
          }
          resolve(parsed.data);
        },
        fail: error => { this.tasks.delete(task); reject(!this.active || error.errMsg.includes('abort') ? new CancelledRequest() : new ApiError('NETWORK_ERROR', '连接失败，请确认本地后端已启动后重试')); }
      });
      this.tasks.add(task);
    });
  }
  upload<T>(filePath: string, purpose: 'clothing' | 'body-photo' | 'avatar', schema: z.ZodType<T>) {
    if (!this.active) return Promise.reject<T>(new CancelledRequest());
    return new Promise<T>((resolve, reject) => {
      const task = wx.uploadFile({
        url: `${API_BASE_URL}/media`, filePath, name: 'file', formData: { purpose }, timeout: 60000,
        header: { Authorization: `Bearer ${sessionToken}` },
        success: response => {
          this.tasks.delete(task);
          if (!this.active) { reject(new CancelledRequest()); return; }
          let payload: unknown;
          try { payload = JSON.parse(response.data); } catch { reject(new ApiError('INVALID_RESPONSE', '图片上传返回的数据无法读取')); return; }
          if (response.statusCode === 401 && sessionToken) { clearSession(); wx.reLaunch({ url: '/pages/welcome/welcome' }); }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const parsed = errorSchema.safeParse(payload);
            reject(parsed.success ? new ApiError(parsed.data.error.code, parsed.data.error.message) : new ApiError('UPLOAD_FAILED', '图片上传失败，请重试'));
            return;
          }
          const parsed = schema.safeParse(payload);
          if (!parsed.success) { reject(new ApiError('INVALID_RESPONSE', '图片上传返回的数据不符合约定')); return; }
          resolve(parsed.data);
        },
        fail: error => { this.tasks.delete(task); reject(!this.active || error.errMsg.includes('abort') ? new CancelledRequest() : new ApiError('UPLOAD_FAILED', '图片上传失败，请检查连接后重试')); }
      });
      this.tasks.add(task);
    });
  }
  close() { this.active = false; for (const task of this.tasks) task.abort(); this.tasks.clear(); }
}
export function errorMessage(error: unknown) {
  if (error instanceof CancelledRequest) return '';
  if (error instanceof ApiError) return error.message;
  if (error instanceof z.ZodError) return '输入不符合要求，请检查必填项和字段格式';
  return '操作失败，请重试';
}
export function queryString(values: Record<string, string | number | boolean | undefined>) {
  return Object.entries(values).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
}
export function requestKey() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
