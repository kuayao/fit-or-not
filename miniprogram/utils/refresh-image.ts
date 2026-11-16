import { z } from 'zod';
import { signAssets } from '../api/client';
import { errorMessage } from './request';
import type { RequestScope } from './request';

export async function refreshExpiredImage(scope: RequestScope, event: WechatMiniprogram.ImageError, apply: (oldUrl: string, url: string) => void, report: (message: string) => void) {
  const source = z.string().parse(event.currentTarget.dataset.url);
  const signed = source.match(/\/api\/media\/content\/([0-9a-f-]{36})\?[^#]*\bexpires=(\d+)/);
  if (!signed || Number(signed[2]) * 1000 > Date.now()) return;
  try {
    const result = await signAssets(scope, [signed[1]], /[?&]variant=preview(?:&|$)/.test(source) ? 'preview' : 'original');
    if (scope.active) apply(source, result.data[0].url);
  } catch (error) { const message = errorMessage(error); if (message) report(message); }
}
