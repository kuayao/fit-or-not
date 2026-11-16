import { Router } from 'express';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { idSchema, weatherSchema } from '../../miniprogram/api/contracts.js';
import { config } from './config.js';
import { HttpError, notFound } from './errors.js';
import { weatherLocations } from './weather-locations.js';
import { packingRemindersAvailable } from './packing-reminders.js';

export const servicesRouter = Router();
servicesRouter.get('/capabilities', (_req, res) => {
  const imageReady = Boolean(config.NEW_API_KEY);
  res.json({ data: {
    imageProcessing: { available: imageReady, reason: imageReady ? 'AI 抠图与识别已配置，资料自动保存' : '请在服务端配置 New API 密钥后上传解析' },
    weather: { available: Boolean(config.AMAP_KEY), reason: config.AMAP_KEY ? '高德天气已配置' : '尚未配置高德 Web 服务密钥' },
    recommendation: { available: imageReady && Boolean(config.AMAP_KEY), reason: imageReady && config.AMAP_KEY ? '天气推荐已配置' : '请配置天气和 AI 服务' },
    tryOn: { available: false, reason: '虚拟试穿服务商与费用上限尚未确定' },
    packingReminder: { available: packingRemindersAvailable(), templateId: config.WECHAT_PACKING_TEMPLATE_ID }
  } });
});
const amapErrorSchema = z.object({ status: z.literal('0'), infocode: z.string() });
const amapAdcodeSchema = z.union([z.string().regex(/^(?:\d{6})?$/), z.tuple([])]).transform(value => typeof value === 'string' ? value : '');
const ipResponseSchema = z.object({ status: z.literal('1'), adcode: amapAdcodeSchema });
const geocodeResponseSchema = z.object({ status: z.literal('1'), regeocode: z.object({ addressComponent: z.object({ adcode: amapAdcodeSchema }) }) });
const temperatureSchema = z.string().trim().min(1).pipe(z.coerce.number<string>().finite());
const reportTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).transform(value => `${value.replace(' ', 'T')}+08:00`).pipe(z.iso.datetime({ offset: true }));
const currentResponseSchema = z.object({ status: z.literal('1'), lives: z.array(z.object({
  city: z.string(), weather: z.string().min(1), temperature: temperatureSchema,
  winddirection: z.string(), windpower: z.string(), humidity: temperatureSchema.pipe(z.number().min(0).max(100)), reporttime: reportTimeSchema
})) });
const forecastResponseSchema = z.object({ status: z.literal('1'), forecasts: z.array(z.object({
  city: z.string(),
  reporttime: reportTimeSchema,
  casts: z.array(z.object({ date: z.iso.date(), dayweather: z.string(), nightweather: z.string(), daytemp: temperatureSchema, nighttemp: temperatureSchema })).min(1)
})) });
async function requestAmap<T>(path: string, parameters: Record<string, string>, schema: z.ZodType<T>, signal: AbortSignal) {
  const url = new URL(`https://restapi.amap.com/v3/${path}`);
  url.search = new URLSearchParams({ key: config.AMAP_KEY, ...parameters }).toString();
  const response = await fetch(url, { signal });
  const payload: unknown = await response.json();
  if (!response.ok) throw new HttpError(502, 'WEATHER_UNAVAILABLE', '高德服务暂时不可用，请稍后重试');
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  const error = amapErrorSchema.safeParse(payload);
  if (error.success && ['10001', '10002', '10005', '10006', '10007', '10009', '10012', '10013'].includes(error.data.infocode)) {
    throw new HttpError(503, 'AMAP_ACCESS_DENIED', '高德服务鉴权失败，请检查 Web 服务密钥及接口权限');
  }
  if (error.success && ['10003', '10004', '10010', '10014', '10019', '10020', '10021', '10044'].includes(error.data.infocode)) {
    throw new HttpError(503, 'AMAP_QUOTA_EXCEEDED', '高德服务额度或调用频率已达上限，请稍后重试');
  }
  throw new HttpError(502, 'WEATHER_UNAVAILABLE', '高德服务未返回可用数据，请稍后重试');
}
const cache = new Map<string, { expires: number; data: z.infer<typeof weatherSchema> }>();
const privateAddresses = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]] as const) privateAddresses.addSubnet(address, prefix, 'ipv4');
servicesRouter.get('/weather-locations', (req, res) => {
  const input = z.object({
    q: z.string().trim().min(1).max(100),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20)
  }).strict().parse(req.query);
  const terms = input.q.toLowerCase().split(/\s+/);
  const matches = weatherLocations.filter(location => terms.every(term => `${location.path} ${location.pinyin}`.toLowerCase().includes(term)));
  res.json({
    data: matches.slice((input.page - 1) * input.pageSize, input.page * input.pageSize).map(location => ({ id: `${location.cityCode}:${location.path}`, cityCode: location.cityCode, name: location.name, path: location.path.replaceAll('/', ' · ') })),
    pagination: { page: input.page, pageSize: input.pageSize, total: matches.length }
  });
});
const weatherQuerySchema = z.union([
    z.object({ source: z.literal('ip'), refresh: z.literal('true').optional() }).strict(),
    z.object({ cityCode: z.string().regex(/^\d{6}$/), refresh: z.literal('true').optional() }).strict(),
    z.object({
      refresh: z.literal('true').optional(),
      latitude: z.string().trim().min(1).pipe(z.coerce.number<string>().min(-90).max(90)),
      longitude: z.string().trim().min(1).pipe(z.coerce.number<string>().min(-180).max(180))
    }).strict()
  ]);
servicesRouter.get('/weather', async (req, res) => {
  res.json({ data: await loadWeather(weatherQuerySchema.parse(req.query), (req.ip || '').replace(/^::ffff:/i, '')) });
});
export async function loadWeather(input: z.infer<typeof weatherQuerySchema>, address = '') {
  if ('source' in input) {
    if (isIP(address) !== 4 || privateAddresses.check(address, 'ipv4')) throw new HttpError(400, 'LOCATION_UNAVAILABLE', '无法识别当前城市，请手动选择');
  }
  const location = 'source' in input
    ? { value: address, cacheKey: `ip:${address}` }
    : 'cityCode' in input
      ? { value: input.cityCode, cacheKey: `city:${input.cityCode}` }
      : { value: `${input.longitude.toFixed(6)},${input.latitude.toFixed(6)}`, cacheKey: `coordinates:${input.longitude.toFixed(6)},${input.latitude.toFixed(6)}` };
  if (!config.AMAP_KEY) throw new HttpError(503, 'SERVICE_NOT_CONFIGURED', '尚未配置高德 Web 服务密钥');
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const cached = cache.get(location.cacheKey);
  if (!input.refresh && cached && cached.expires > Date.now() && cached.data.forecast[0].date === today) {
    return cached.data;
  }
  try {
    const signal = AbortSignal.timeout(10000);
    const adcode = 'cityCode' in input ? input.cityCode : 'source' in input
      ? (await requestAmap('ip', { ip: location.value }, ipResponseSchema, signal)).adcode
      : (await requestAmap('geocode/regeo', { location: location.value, extensions: 'base' }, geocodeResponseSchema, signal)).regeocode.addressComponent.adcode;
    if (!adcode) throw new HttpError(400, 'LOCATION_UNAVAILABLE', '无法识别当前城市，请手动选择');
    const [currentResponse, response] = await Promise.all([
      requestAmap('weather/weatherInfo', { city: adcode, extensions: 'base' }, currentResponseSchema, signal),
      requestAmap('weather/weatherInfo', { city: adcode, extensions: 'all' }, forecastResponseSchema, signal)
    ]);
    if (!currentResponse.lives.length) throw new HttpError(422, 'WEATHER_LOCATION_NOT_SUPPORTED', '该地区暂无实况天气，请选择其他城市');
    if (!response.forecasts.length) throw new HttpError(422, 'WEATHER_LOCATION_NOT_SUPPORTED', '该地区暂无天气预报，请选择其他城市');
    const current = currentResponse.lives[0];
    const forecast = response.forecasts[0];
    const days = forecast.casts.filter(day => day.date >= today).slice(0, 3);
    if (!days.length || days[0].date !== today) throw new HttpError(502, 'WEATHER_UNAVAILABLE', '天气预报尚未更新，请稍后重试');
    const data = { cityCode: adcode, city: current.city, updatedAt: forecast.reporttime, source: '高德天气', stale: false,
      current: { weather: current.weather, temperature: current.temperature, windDirection: current.winddirection, windPower: current.windpower, humidity: current.humidity, updatedAt: current.reporttime },
      forecast: days.map(day => ({ date: day.date, textDay: day.dayweather, textNight: day.nightweather, tempDay: day.daytemp, tempNight: day.nighttemp })) };
    cache.set(location.cacheKey, { expires: Date.now() + 600000, data });
    cache.set(`city:${adcode}`, { expires: Date.now() + 600000, data });
    return data;
  } catch (error) {
    if (cached && cached.data.forecast[0].date === today) {
      const stale = { ...cached.data, stale: true };
      cache.set(location.cacheKey, { ...cached, data: stale });
      cache.set(`city:${stale.cityCode}`, { ...cached, data: stale });
      return stale;
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'WEATHER_UNAVAILABLE', '天气请求失败，请稍后重试');
  }
}
servicesRouter.post('/try-ons', (req, _res) => {
  z.object({ bodyAssetId: idSchema, outfitId: idSchema, consent: z.literal(true) }).strict().parse(req.body);
  throw new HttpError(503, 'SERVICE_NOT_CONFIGURED', '虚拟试穿服务商与费用上限尚未确定');
});
servicesRouter.get('/external-jobs/:id', req => { idSchema.parse(req.params.id); notFound(); });
servicesRouter.post('/external-jobs/:id/cancel', req => { idSchema.parse(req.params.id); notFound(); });
servicesRouter.delete('/external-jobs/:id', req => { idSchema.parse(req.params.id); notFound(); });
