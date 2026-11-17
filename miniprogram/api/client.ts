import { z } from 'zod';
import { queryString, ApiError, CancelledRequest } from '../utils/request';
import type { RequestScope } from '../utils/request';
import type { ClothingOptionKind, ClothingBatchInput, ImageJobInput, PromptRefinementInput } from './contracts';
import { categorySchema, tagSchema, clothingOptionSchema, clothingSchema, outfitSchema, outfitCategorySchema, wearSchema, packingSchema, mediaSchema, signedUrlSchema, userSchema, capabilitiesSchema, paginationSchema, jobSchema, statisticsSchema, clothingStatisticsSchema, weatherSchema, weatherLocationSchema, exportSchema, loginSchema } from './contracts';
import { clothingImportSchema, clothingImportDetailSchema, clothingSetSchema, recommendationSchema, recommendationOutfitSchema } from './contracts';
import { promptRefinementSchema } from './contracts';

const result = <T>(schema: z.ZodType<T>) => z.object({ data: schema });
const list = <T>(schema: z.ZodType<T>) => z.object({ data: z.array(schema), pagination: paginationSchema });
export const refineImagePrompt = (scope: RequestScope, input: PromptRefinementInput) => scope.request('POST', '/image-prompt-refinements', result(promptRefinementSchema), input);
export const loginWithWechat = (scope: RequestScope, code: string) => scope.request('POST', '/auth/wechat', result(loginSchema), { code });
export const redeemInvitation = (scope: RequestScope, registrationToken: string, invitationCode: string) => scope.request('POST', '/auth/invitations/redeem', result(loginSchema), { registrationToken, invitationCode });
export const logout = (scope: RequestScope) => scope.request('POST', '/auth/logout', z.undefined());
export const getMe = (scope: RequestScope) => scope.request('GET', '/me', result(userSchema));
export const updateMe = (scope: RequestScope, input: object) => scope.request('PATCH', '/me', result(userSchema), input);
export const deleteMe = (scope: RequestScope) => scope.request('DELETE', '/me', result(z.object({ status: z.literal('deleting') })), { confirmation: 'DELETE_MY_ACCOUNT' });
export const listCategories = (scope: RequestScope) => scope.request('GET', '/categories', result(z.array(categorySchema)));
export const listTags = (scope: RequestScope) => scope.request('GET', '/tags', result(z.array(tagSchema)));
export const createCategory = (scope: RequestScope, name: string, parentId: string | null = null) => scope.request('POST', '/categories', result(categorySchema), { name, parentId });
export const createTag = (scope: RequestScope, name: string, kind: string) => scope.request('POST', '/tags', result(tagSchema), { name, kind });
export const updateCategory = (scope: RequestScope, id: string, input: object) => scope.request('PATCH', `/categories/${id}`, result(categorySchema), input);
export const updateCategorySizeKind = (scope: RequestScope, id: string, input: { version: number; sizeKind: 'clothing-size' | 'shoe-size' }) => scope.request('PATCH', `/categories/${id}/size-kind`, result(categorySchema), input);
export const updateTag = (scope: RequestScope, id: string, input: object) => scope.request('PATCH', `/tags/${id}`, result(tagSchema), input);
export const deleteTaxonomy = (scope: RequestScope, type: 'categories' | 'tags', id: string) => scope.request('DELETE', `/${type}/${id}`, z.undefined());
export const reorderTaxonomy = (scope: RequestScope, type: 'categories' | 'tags', items: { id: string; version: number }[]) => scope.request('POST', `/${type}/reorder`, z.undefined(), { items });
export const listClothingOptions = (scope: RequestScope) => scope.request('GET', '/clothing-options', result(z.array(clothingOptionSchema)));
export const createClothingOption = (scope: RequestScope, name: string, kind: ClothingOptionKind) => scope.request('POST', '/clothing-options', result(clothingOptionSchema), { name, kind });
export const updateClothingOption = (scope: RequestScope, id: string, input: { name: string; version: number }) => scope.request('PATCH', `/clothing-options/${id}`, result(clothingOptionSchema), input);
export const deleteClothingOption = (scope: RequestScope, id: string) => scope.request('DELETE', `/clothing-options/${id}`, z.undefined());
export const reorderClothingOptions = (scope: RequestScope, kind: ClothingOptionKind, items: { id: string; version: number }[]) => scope.request('POST', '/clothing-options/reorder', z.undefined(), { kind, items });
export const listClothes = (scope: RequestScope, filters: Record<string, string | number | boolean | undefined> = {}) => scope.request('GET', `/clothes?${queryString(filters)}`, list(clothingSchema));
export const getClothing = (scope: RequestScope, id: string) => scope.request('GET', `/clothes/${id}`, result(clothingSchema));
export const createClothing = (scope: RequestScope, input: object) => scope.request('POST', '/clothes', result(clothingSchema), input);
export const importClothing = (scope: RequestScope, inputAssetId: string, key: string) => scope.request('POST', '/clothes/imports', result(clothingSchema), { inputAssetId }, key);
export const updateClothing = (scope: RequestScope, id: string, input: object) => scope.request('PATCH', `/clothes/${id}`, result(clothingSchema), input);
export const deleteClothing = (scope: RequestScope, id: string) => scope.request('DELETE', `/clothes/${id}`, z.undefined());
export const batchClothes = (scope: RequestScope, input: ClothingBatchInput) => scope.request('POST', '/clothes/batch', result(z.object({ affectedCount: z.number() })), input);
export async function uploadPhoto(scope: RequestScope, path: string, purpose: 'clothing' | 'body-photo' | 'avatar' = 'clothing') {
  if (!scope.active) throw new CancelledRequest();
  const filePath = await (async () => {
    try {
      const image = await wx.getImageInfo({ src: path });
      const scale = Math.min(1, (purpose === 'avatar' ? 512 : 2048) / Math.max(image.width, image.height));
      if (scale === 1 && image.type !== 'jpeg') return path;
      const compressed = await wx.compressImage({ src: path, quality: 80, compressedWidth: Math.max(1, Math.round(image.width * scale)), compressedHeight: Math.max(1, Math.round(image.height * scale)) });
      return compressed.tempFilePath;
    } catch {
      throw new ApiError('IMAGE_COMPRESSION_FAILED', '图片压缩失败，请重新选择图片');
    }
  })();
  return scope.upload(filePath, purpose, result(mediaSchema));
}
export const signAssets = (scope: RequestScope, assetIds: string[], variant: 'original' | 'thumbnail' | 'preview' = 'original') => scope.request('POST', '/media/signed-urls', result(z.array(signedUrlSchema)), { assetIds, variant });
export async function imageUrls(scope: RequestScope, ids: string[], variant: 'original' | 'thumbnail' | 'preview' = 'preview') {
  const unique = [...new Set(ids)];
  const pairs = await Promise.all(Array.from({ length: Math.ceil(unique.length / 20) }, (_, index) => signAssets(scope, unique.slice(index * 20, index * 20 + 20), variant)));
  if (!scope.active) throw new CancelledRequest();
  return Object.fromEntries(pairs.flatMap(value => value.data.map(item => [item.assetId, item.url])));
}
export const listOutfits = (scope: RequestScope, filters: Record<string, string | number | boolean | undefined> = {}) => scope.request('GET', `/outfits?${queryString(filters)}`, list(outfitSchema));
export const listOutfitCategories = (scope: RequestScope) => scope.request('GET', '/outfit-categories', result(z.array(outfitCategorySchema)));
export const createOutfitCategory = (scope: RequestScope, name: string) => scope.request('POST', '/outfit-categories', result(outfitCategorySchema), { name });
export const getOutfit = (scope: RequestScope, id: string) => scope.request('GET', `/outfits/${id}`, result(outfitSchema));
export const createOutfit = (scope: RequestScope, input: object) => scope.request('POST', '/outfits', result(outfitSchema), input);
export const updateOutfit = (scope: RequestScope, id: string, input: object) => scope.request('PATCH', `/outfits/${id}`, result(outfitSchema), input);
export const deleteOutfit = (scope: RequestScope, id: string) => scope.request('DELETE', `/outfits/${id}`, z.undefined());
export const listWearRecords = (scope: RequestScope, from: string, to: string) => scope.request('GET', `/wear-records?${queryString({ from, to })}`, result(z.array(wearSchema)));
export const createWearRecord = (scope: RequestScope, input: object) => scope.request('POST', '/wear-records', result(wearSchema), input);
export const updateWearRecord = (scope: RequestScope, id: string, input: object) => scope.request('PATCH', `/wear-records/${id}`, result(wearSchema), input);
export const deleteWearRecord = (scope: RequestScope, id: string) => scope.request('DELETE', `/wear-records/${id}`, z.undefined());
export const getStatistics = (scope: RequestScope, all: boolean) => scope.request('GET', `/statistics?scope=${all ? 'all' : 'active'}`, result(statisticsSchema));
export const listClothingStatistics = (scope: RequestScope, all: boolean, page: number, sort: 'least-worn' | 'most-worn') => scope.request('GET', `/statistics/clothes?${queryString({ scope: all ? 'all' : 'active', page, sort })}`, list(clothingStatisticsSchema));
export const listPackingLists = (scope: RequestScope, page: number, status = 'active') => scope.request('GET', `/packing-lists?${queryString({ page, status })}`, list(packingSchema));
export const getPackingList = (scope: RequestScope, id: string) => scope.request('GET', `/packing-lists/${id}`, result(packingSchema));
export const createPackingList = (scope: RequestScope, input: object) => scope.request('POST', '/packing-lists', result(packingSchema), input);
export const updatePackingList = (scope: RequestScope, id: string, input: object) => scope.request('PATCH', `/packing-lists/${id}`, result(packingSchema), input);
export const copyPackingList = (scope: RequestScope, id: string, input: object) => scope.request('POST', `/packing-lists/${id}/copy`, result(packingSchema), input);
export const deletePackingList = (scope: RequestScope, id: string) => scope.request('DELETE', `/packing-lists/${id}`, z.undefined());
export const setPackingStatus = (scope: RequestScope, id: string, input: object) => scope.request('PATCH', `/packing-lists/${id}/status`, result(packingSchema), input);
export const listImageJobs = (scope: RequestScope, page: number) => scope.request('GET', `/image-jobs?page=${page}&standalone=true`, list(jobSchema));
export const getImageJob = (scope: RequestScope, id: string) => scope.request('GET', `/image-jobs/${id}`, result(jobSchema));
export const createImageJob = (scope: RequestScope, input: ImageJobInput, key: string) => scope.request('POST', '/image-jobs', result(jobSchema), input, key);
export const cancelImageJob = (scope: RequestScope, id: string) => scope.request('POST', `/image-jobs/${id}/cancel`, result(jobSchema));
export const retryImageJob = (scope: RequestScope, id: string, key: string, confirmUncertain = false) => scope.request('POST', `/image-jobs/${id}/retry`, result(jobSchema), { confirmUncertain }, key);
export const getCapabilities = (scope: RequestScope) => scope.request('GET', '/capabilities', result(capabilitiesSchema));
export type WeatherLocation = { source: 'ip' } | { cityCode: string } | { latitude: number; longitude: number };
export const getWeather = (scope: RequestScope, location: WeatherLocation, refresh = false) => scope.request('GET', `/weather?${queryString({ ...location, refresh: refresh ? 'true' : undefined })}`, result(weatherSchema));
export const searchWeatherLocations = (scope: RequestScope, q: string, page: number) => scope.request('GET', `/weather-locations?${queryString({ q, page, pageSize: 20 })}`, list(weatherLocationSchema));
export const getRecommendations = (scope: RequestScope, cityCode: string) => scope.request('POST', '/recommendations', result(recommendationSchema), { cityCode }, undefined, 65000);
export const getRecommendationOutfit = (scope: RequestScope, id: string, outfitId: string) => scope.request('GET', `/recommendations/${id}/outfits/${outfitId}`, result(recommendationOutfitSchema));
export const createDataExport = (scope: RequestScope, key: string) => scope.request('POST', '/data-exports', result(exportSchema), { format: 'zip' }, key);
export const getDataExport = (scope: RequestScope, id: string) => scope.request('GET', `/data-exports/${id}`, result(exportSchema));

export const startClothingImport = (scope: RequestScope, inputAssetId: string, mode: 'single' | 'set', key: string) => scope.request('POST', '/clothing-imports', result(clothingImportDetailSchema), { inputAssetId, mode }, key);
export const listClothingImports = (scope: RequestScope, page: number, empty = false) => scope.request('GET', `/clothing-imports?page=${page}${empty ? '&empty=true' : ''}`, list(clothingImportSchema));
export const getClothingImport = (scope: RequestScope, id: string) => scope.request('GET', `/clothing-imports/${id}`, result(clothingImportDetailSchema));
export const updateClothingImport = (scope: RequestScope, id: string, input: object) => scope.request('PATCH', `/clothing-imports/${id}`, result(clothingImportDetailSchema), input);
export const confirmClothingImport = (scope: RequestScope, id: string, input: object, key: string) => scope.request('POST', `/clothing-imports/${id}/confirm`, result(clothingImportDetailSchema), input, key);
export const cancelClothingImport = (scope: RequestScope, id: string) => scope.request('POST', `/clothing-imports/${id}/cancel`, result(clothingImportDetailSchema));
export const listClothingSets = (scope: RequestScope, page: number, q = '') => scope.request('GET', `/clothing-sets?${queryString({ page, q })}`, list(clothingSetSchema));
export const getClothingSet = (scope: RequestScope, id: string) => scope.request('GET', `/clothing-sets/${id}`, result(clothingSetSchema));
export const createClothingSet = (scope: RequestScope, input: object) => scope.request('POST', '/clothing-sets', result(clothingSetSchema), input);
export const updateClothingSet = (scope: RequestScope, id: string, input: object) => scope.request('PATCH', `/clothing-sets/${id}`, result(clothingSetSchema), input);
export const deleteClothingSet = (scope: RequestScope, id: string) => scope.request('DELETE', `/clothing-sets/${id}`, z.undefined());

export const addImportItem = (scope: RequestScope, id: string, input: object, key: string) => scope.request('POST', `/clothing-imports/${id}/items`, result(clothingImportDetailSchema), input, key);

export const redetectClothingImport = (scope: RequestScope, id: string, input: { version: number; userPrompt?: string }, key: string) => scope.request('POST', `/clothing-imports/${id}/redetect`, result(clothingImportDetailSchema), input, key);
