import { getImageJob } from '../api/client';
import { requestKey } from './request';
import type { RequestScope } from './request';

export type ImageJobRetryAttempt = { id: string; key: string; confirmUncertain: boolean };

export async function prepareImageJobRetry(scope: RequestScope, id: string) {
  const answer = await wx.showModal({ title: '重新处理这张图片？', confirmText: '重新处理', cancelText: '取消' });
  if (!scope.active || !answer.confirm) return null;
  const job = (await getImageJob(scope, id)).data;
  return { id, key: requestKey(), confirmUncertain: job.providerPending };
}
