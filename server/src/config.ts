import { resolve } from 'node:path';
import { z } from 'zod';

const env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'), PORT: z.coerce.number().int().min(1).max(65535).default(3006),
  TRUST_PROXY: z.string().default('').transform(value => value.split(',').map(address => address.trim()).filter(Boolean)),
  DB_HOST: z.string().min(1), DB_PORT: z.coerce.number().int().min(1).max(65535),
  DB_NAME: z.string().min(1), DB_USER: z.string().min(1), DB_PASSWORD: z.string().min(1),
  MEDIA_DIR: z.string().min(1), PUBLIC_BASE_URL: z.url(),
  MEDIA_SIGNING_KEY: z.string().min(32), WECHAT_APP_ID: z.string().regex(/^wx[a-f0-9]{16}$/),
  WECHAT_APP_SECRET: z.string().default(''), MEMBER_LIMIT: z.coerce.number().int().positive().default(3),
  WECHAT_PACKING_TEMPLATE_ID: z.string().trim().default(''),
  WECHAT_MESSAGE_ENV: z.enum(['developer', 'trial', 'formal']).default('formal'),
  AMAP_KEY: z.string().trim().default(''),
  NEW_API_BASE_URL: z.url().default('https://newapi.ammmm.us/v1'), NEW_API_KEY: z.string().default(''),
  AI_IMAGE_DOWNLOAD_HOSTS: z.string().default(''),
  AI_CUTOUT_MODEL: z.string().min(1).default('gpt-image-2.6-flare'),
  AI_RECOGNITION_MODEL: z.string().min(1).default('gpt-6-luna'),
  AI_RECOMMENDATION_MODEL: z.string().min(1).default('gpt-6-luna'),
  AI_RECOMMENDATION_TIMEOUT_MS: z.coerce.number().int().positive().max(55000).default(45000),
  AI_CUTOUT_QUALITY: z.enum(['low', 'medium', 'high']).default('low'),
  AI_CUTOUT_COMPLEXITY: z.enum(['low', 'medium', 'high']).default('low'),
  AI_RECOGNITION_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  AI_CUTOUT_TIMEOUT_MS: z.coerce.number().int().positive().default(180000)
}).parse(process.env);

export const config = { ...env, MEDIA_DIR: resolve(env.MEDIA_DIR) };
