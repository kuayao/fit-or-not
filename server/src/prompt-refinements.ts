import { Router } from 'express';
import { z } from 'zod';
import { promptRefinementInputSchema, promptRefinementSchema } from '../../miniprogram/api/contracts.js';
import { readClothing } from './clothes.js';
import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './errors.js';
import { readLimited } from './ai-images.js';
import { PROMPT_REFINEMENT_PROMPT } from './image-prompts.js';

export const promptRefinementsRouter = Router();
promptRefinementsRouter.post('/', async (req, res) => {
  const input = promptRefinementInputSchema.parse(req.body);
  const clothing = await readClothing(pool, res.locals.user.id, input.clothingId);
  if (!config.NEW_API_KEY) throw new HttpError(503, 'SERVICE_NOT_CONFIGURED', '请配置 AI 服务');
  const signal = AbortSignal.timeout(8000);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${config.NEW_API_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${config.NEW_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.AI_RECOGNITION_MODEL, reasoning_effort: 'none', response_format: { type: 'json_object' }, max_completion_tokens: 512,
        messages: [{ role: 'system', content: PROMPT_REFINEMENT_PROMPT }, { role: 'user', content: JSON.stringify({
          mode: input.mode, userPrompt: input.userPrompt,
          clothing: { name: clothing.name, categoryName: clothing.categoryName, itemType: clothing.itemType, colorDescription: clothing.colorDescription, visibleFeatures: clothing.visibleFeatures }
        }) }]
      })
    });
    if (!response.ok) throw new HttpError(502, 'PROMPT_REFINEMENT_FAILED', '描述优化暂不可用，可继续使用原描述');
    const payload: unknown = JSON.parse((await readLimited(response, 64 * 1024)).toString('utf8'));
    const content = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) }).parse(payload).choices[0].message.content;
    const parsed: unknown = JSON.parse(content);
    const result = promptRefinementSchema.parse(parsed);
    console.info(JSON.stringify({ event: 'prompt_refined', requestId: res.locals.requestId, model: config.AI_RECOGNITION_MODEL, mode: input.mode, status: result.status, elapsedMs: Date.now() - startedAt }));
    res.json({ data: result });
  } catch (error) {
    console.error(JSON.stringify({ event: 'prompt_refinement_failed', requestId: res.locals.requestId, elapsedMs: Date.now() - startedAt, errorType: error instanceof Error ? error.name : 'UnknownError' }));
    if (signal.aborted) throw new HttpError(504, 'PROMPT_REFINEMENT_TIMEOUT', '描述优化超时，可继续使用原描述');
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'PROMPT_REFINEMENT_FAILED', '描述优化未完成，可继续使用原描述');
  }
});
