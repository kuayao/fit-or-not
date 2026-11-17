import { z } from 'zod';
z.config({ jitless: true });

export const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export const idSchema = z.uuid();
export const dateSchema = z.iso.date();
export const colors = ['white', 'black', 'gray', 'cream', 'brown', 'blue', 'green', 'red', 'pink', 'yellow', 'purple', 'orange', 'multi'] as const;
export const seasons = ['spring', 'summer', 'autumn', 'winter', 'all'] as const;
export const colorLabels = ['白色', '黑色', '灰色', '米色', '棕色', '蓝色', '绿色', '红色', '粉色', '黄色', '紫色', '橙色', '多色'];
export const seasonLabels = ['春', '夏', '秋', '冬', '四季'];
export const patterns = ['solid', 'striped', 'checked', 'printed', 'color-block', 'other'] as const;
export const patternLabels = ['纯色', '条纹', '格纹', '印花', '拼色', '其他'];
export const clothingFeaturesSchema = z.object({
  itemType: z.string().trim().max(30).nullable().default(null),
  colorDescription: z.string().trim().max(30).nullable().default(null),
  pattern: z.enum(patterns).nullable().default(null),
  visibleFeatures: z.array(z.string().trim().min(1).max(20)).max(5).default([])
});
export const recognitionSchema = clothingFeaturesSchema.required().extend({
  name: z.string().trim().min(1).max(60).nullable(), categoryId: idSchema.nullable(),
  rootCategoryId: idSchema.nullable(), subcategoryName: z.string().trim().min(1).max(30).nullable(),
  colors: z.array(z.enum(colors)).max(3).refine(values => new Set(values).size === values.length && (!values.includes('multi') || values.length === 1)),
  seasons: z.array(z.enum(seasons)).max(5).refine(values => new Set(values).size === values.length && (!values.includes('all') || values.length === 1)),
  styleTagIds: z.array(idSchema).max(2), occasionTagIds: z.array(idSchema).max(2),
  inputIssues: z.array(z.enum(['multiple-items', 'occluded', 'cropped', 'blurry', 'strong-color-cast', 'target-unclear'])).max(6),
  cutoutReadiness: z.enum(['ready', 'needs-review', 'retake'])
});
export const sizeKindSchema = z.enum(['clothing-size', 'shoe-size']);
export const categorySchema = z.object({ id: idSchema, name: z.string(), parentId: idSchema.nullable(), displayName: z.string(), sizeKind: sizeKindSchema, sortOrder: z.number().int(), version: z.number().int() });
export const tagSchema = z.object({ id: idSchema, name: z.string(), sortOrder: z.number().int(), version: z.number().int(), kind: z.enum(['occasion', 'style']) });
export const clothingOptionKindSchema = z.enum(['brand', 'clothing-size', 'shoe-size', 'material']);
export const clothingOptionInputSchema = z.object({ kind: clothingOptionKindSchema, name: z.string().trim().min(1).max(100) }).strict();
export const clothingOptionSchema = clothingOptionInputSchema.extend({ id: idSchema, sortOrder: z.number().int(), version: z.number().int() });
export const userSchema = z.object({
  id: idSchema, nickname: z.string(), avatarAssetId: idSchema.nullable(), cityCode: z.string(),
  timezone: z.string(), preferences: z.object({ showArchived: z.boolean().optional() }), version: z.number().int()
});
export const userInputSchema = z.object({
  version: z.number().int().positive(), nickname: z.string().trim().min(1).max(30).optional(),
  avatarAssetId: idSchema.nullable().optional(), cityCode: z.string().trim().max(100).optional(),
  preferences: z.object({ showArchived: z.boolean().optional() }).optional()
}).strict();
export const clothingInputSchema = z.object({
  ...clothingFeaturesSchema.shape,
  name: z.string().trim().max(60).default(''), categoryId: idSchema.nullable().default(null),
  primaryAssetId: idSchema, detailAssetIds: z.array(idSchema).max(9).default([]),
  colors: z.array(z.enum(colors)).max(colors.length).default([]), seasons: z.array(z.enum(seasons)).max(5).default([]),
  tagIds: z.array(idSchema).max(100).default([]), brandId: idSchema.nullable().default(null),
  sizeId: idSchema.nullable().default(null), materialId: idSchema.nullable().default(null),
  priceCents: z.string().regex(/^(0|[1-9]\d{0,14})$/).nullable().default(null), purchasedOn: dateSchema.nullable().default(null),
  notes: z.string().max(1000).default(''), favorite: z.boolean().default(false), status: z.enum(['draft', 'active', 'archived']).default('active')
}).strict();
export const newSubcategorySchema = z.object({ parentId: idSchema, name: z.string().trim().min(1, '请输入二级分类名称').max(30, '分类名称最多 30 个字') }).strict();
export const clothingPatchSchema = z.object({
  itemType: clothingFeaturesSchema.shape.itemType.removeDefault().optional(),
  colorDescription: clothingFeaturesSchema.shape.colorDescription.removeDefault().optional(),
  pattern: clothingFeaturesSchema.shape.pattern.removeDefault().optional(),
  visibleFeatures: clothingFeaturesSchema.shape.visibleFeatures.removeDefault().optional(),
  version: z.number().int().positive(), name: clothingInputSchema.shape.name.removeDefault().optional(),
  categoryId: clothingInputSchema.shape.categoryId.removeDefault().optional(), primaryAssetId: idSchema.optional(),
  detailAssetIds: clothingInputSchema.shape.detailAssetIds.removeDefault().optional(),
  colors: clothingInputSchema.shape.colors.removeDefault().optional(), seasons: clothingInputSchema.shape.seasons.removeDefault().optional(),
  tagIds: clothingInputSchema.shape.tagIds.removeDefault().optional(), brandId: clothingInputSchema.shape.brandId.removeDefault().optional(),
  sizeId: clothingInputSchema.shape.sizeId.removeDefault().optional(), materialId: clothingInputSchema.shape.materialId.removeDefault().optional(),
  priceCents: clothingInputSchema.shape.priceCents.removeDefault().optional(), purchasedOn: clothingInputSchema.shape.purchasedOn.removeDefault().optional(),
  notes: clothingInputSchema.shape.notes.removeDefault().optional(), favorite: clothingInputSchema.shape.favorite.removeDefault().optional(),
  status: clothingInputSchema.shape.status.removeDefault().optional(), newSubcategory: newSubcategorySchema.optional()
}).strict();
export const setMemberSchema = z.object({
  id: idSchema, name: z.string(), categoryName: z.string().nullable(), primaryAssetId: idSchema,
  status: z.enum(['draft', 'active', 'archived'])
});
export const clothingSetSchema = z.object({
  id: idSchema, name: z.string(), coverAssetId: idSchema.nullable(), version: z.number().int(),
  createdAt: z.iso.datetime(), members: z.array(setMemberSchema), memberCount: z.number().int()
});
export const clothingSetInputSchema = z.object({
  name: z.string().trim().min(1, '请输入套装名称').max(60), coverAssetId: idSchema.nullable(),
  memberIds: z.array(idSchema).min(2, '套装至少包含两件单品').max(50)
    .refine(ids => new Set(ids).size === ids.length), moveMembers: z.boolean().default(false)
}).strict();
export const clothingSchema = clothingInputSchema.extend({
  setId: idSchema.nullable(), importId: idSchema.nullable(), singleImport: z.boolean(), clothingSet: clothingSetSchema.omit({ createdAt: true }).nullable(),
  brand: z.string(), sizeLabel: z.string(), material: z.string(),
  id: idSchema, version: z.number().int(), categoryName: z.string().nullable(), wearCount: z.number().int(),
  processingStatus: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).nullable(),
  processingPhase: z.string().nullable(), processingJobId: idSchema.nullable(),
  lastWornOn: dateSchema.nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime()
});
const clothingBatchItemsSchema = z.object({
  items: z.array(z.object({ id: idSchema, version: z.number().int().positive() }).strict()).min(1).max(50)
    .refine(items => new Set(items.map(item => item.id)).size === items.length)
});
export const clothingBatchSchema = z.discriminatedUnion('action', [
  clothingBatchItemsSchema.extend({ action: z.literal('change-category'), parameters: z.object({ categoryId: idSchema }).strict() }).strict(),
  clothingBatchItemsSchema.extend({ action: z.literal('update-attributes'), parameters: clothingPatchSchema.pick({ colors: true, seasons: true, pattern: true, brandId: true, sizeId: true, materialId: true })
    .refine(input => Object.keys(input).length > 0, '请选择要修改的标签') }).strict(),
  clothingBatchItemsSchema.extend({ action: z.enum(['add-tags', 'remove-tags']), parameters: z.object({ tagIds: z.array(idSchema).min(1).max(100) }).strict() }).strict(),
  clothingBatchItemsSchema.extend({ action: z.literal('replace-tags'), parameters: z.object({ kind: z.enum(['occasion', 'style']), tagIds: z.array(idSchema).max(100) }).strict() }).strict(),
  clothingBatchItemsSchema.extend({ action: z.enum(['archive', 'restore', 'delete']), parameters: z.object({}).strict().default({}) }).strict()
]);
export type ClothingBatchInput = z.infer<typeof clothingBatchSchema>;
export const layoutItemSchema = z.object({
  clothingId: idSchema, x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
  rotation: z.number().min(-180).max(180), zIndex: z.number().int().min(0).max(100)
}).strict();
const itemsSchema = z.array(layoutItemSchema).min(1).max(12).refine(items => new Set(items.map(item => item.clothingId)).size === items.length, '同一衣物只能添加一次');
export const outfitCategoryInputSchema = z.object({ name: z.string().trim().min(1, '请输入分类名称').max(12, '分类名称最多 12 个字') }).strict();
export const outfitCategorySchema = outfitCategoryInputSchema.extend({ id: idSchema });
export const outfitInputSchema = z.object({
  name: z.string().trim().min(1).max(60), backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#FFFFFF'),
  categoryId: idSchema.nullable().default(null),
  occasion: z.string().trim().max(60).default(''), seasons: z.array(z.enum(seasons)).max(5).default([]),
  notes: z.string().max(1000).default(''), favorite: z.boolean().default(false), items: itemsSchema
}).strict();
export const outfitPatchSchema = z.object({
  version: z.number().int().positive(), name: outfitInputSchema.shape.name.optional(),
  categoryId: idSchema.nullable().optional(),
  backgroundColor: outfitInputSchema.shape.backgroundColor.removeDefault().optional(),
  occasion: outfitInputSchema.shape.occasion.removeDefault().optional(), seasons: outfitInputSchema.shape.seasons.removeDefault().optional(),
  notes: outfitInputSchema.shape.notes.removeDefault().optional(), favorite: outfitInputSchema.shape.favorite.removeDefault().optional(),
  items: itemsSchema.optional()
}).strict();
export const outfitSchema = outfitInputSchema.extend({
  id: idSchema, version: z.number().int(), categoryName: z.string().nullable(), coverAssetId: idSchema.nullable(), createdAt: z.iso.datetime(),
  previewAssets: z.array(z.object({ clothingId: idSchema, assetId: idSchema }))
});
export const wearInputSchema = z.object({
  wornOn: dateSchema, clothingIds: z.array(idSchema).min(1).max(12).optional(), outfitId: idSchema.optional(),
  occasion: z.string().trim().max(60).default(''), notes: z.string().max(1000).default(''), bodyAssetId: idSchema.nullable().default(null)
}).strict().refine(value => Boolean(value.clothingIds) !== Boolean(value.outfitId), '请选择单品或搭配');
export const wearPatchSchema = z.object({
  version: z.number().int().positive(), wornOn: dateSchema, clothingIds: z.array(idSchema).min(1).max(12),
  occasion: z.string().trim().max(60), notes: z.string().max(1000), bodyAssetId: idSchema.nullable()
}).strict();
export const wearSchema = z.object({
  id: idSchema, wornOn: dateSchema, occasion: z.string(), notes: z.string(), bodyAssetId: idSchema.nullable(),
  sourceOutfitId: idSchema.nullable(), version: z.number().int(),
  items: z.array(z.object({ clothingId: idSchema, name: z.string(), categoryName: z.string(), primaryAssetId: idSchema, status: z.string() }))
});
export const departureTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '出发时刻请填写为 09:30 这样的格式');
export const packingInputSchema = z.object({
  name: z.string().trim().min(1).max(60), startOn: dateSchema.nullable().default(null), endOn: dateSchema.nullable().default(null),
  departureTime: departureTimeSchema.nullable().default(null),
  reminderSubscriptions: z.number().int().min(0).max(2).default(0),
  clothingIds: z.array(idSchema).max(100).default([])
}).strict().refine(value => !value.startOn || !value.endOn || value.startOn <= value.endOn, '结束日期不能早于开始日期');
export const packingPatchSchema = z.object({
  version: z.number().int().positive(), name: z.string().trim().min(1).max(60), startOn: dateSchema.nullable(), endOn: dateSchema.nullable(),
  departureTime: departureTimeSchema.nullable().default(null),
  reminderSubscriptions: z.number().int().min(0).max(2).default(0),
  items: z.array(z.object({ clothingId: idSchema, packed: z.boolean() }).strict()).max(100)
}).strict().refine(value => !value.startOn || !value.endOn || value.startOn <= value.endOn, '结束日期不能早于开始日期');
export const packingReminderTimingSchema = z.enum(['two-days-before', 'day-before']);
export const packingStatusInputSchema = z.object({ version: z.number().int().positive(), ended: z.boolean() }).strict();
export const packingSchema = z.object({
  id: idSchema, name: z.string(), startOn: dateSchema.nullable(), endOn: dateSchema.nullable(), departureTime: departureTimeSchema.nullable(), endedAt: z.iso.datetime().nullable(), version: z.number().int(), createdAt: z.iso.datetime(),
  reminders: z.array(z.object({ timing: packingReminderTimingSchema, scheduledAt: z.iso.datetime({ offset: true }), status: z.enum(['scheduled', 'sending', 'sent', 'skipped', 'cancelled', 'failed', 'unknown']) })),
  items: z.array(z.object({ clothingId: idSchema, name: z.string(), primaryAssetId: idSchema, status: z.string(), packed: z.boolean(), rootCategoryId: idSchema.nullable(), rootCategoryName: z.string() }))
});
export const mediaSchema = z.object({ assetId: idSchema, thumbnailAssetId: idSchema, width: z.number(), height: z.number(), mimeType: z.string() });
export const signedUrlSchema = z.object({ assetId: idSchema, url: z.string().max(4096).regex(/^https?:\/\/[^/\s?#]+(?:[/?#][^\s]*)?$/), expiresAt: z.iso.datetime() });
export const imageJobStepSchema = z.object({
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'skipped']),
  errorCode: z.string().optional(), message: z.string().optional(), skipReason: z.string().optional()
});
export const targetSchema = z.object({
  description: z.string().min(1).max(500), name: z.string().min(1).max(60),
  box: z.object({ left: z.number().min(0).max(1), top: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) })
    .refine(box => box.left + box.width <= 1 && box.top + box.height <= 1),
  visibility: z.enum(['visible', 'occluded', 'retake'])
});
export const detectionSchema = z.object({ name: z.string().max(60), targets: z.array(targetSchema).max(6) });
export const imageJobResultSchema = z.object({
  detection: detectionSchema.optional(),
  cutoutAssetId: idSchema.optional(), thumbnailAssetId: idSchema.optional(),
  categoryCandidates: z.array(z.object({ categoryId: idSchema, rank: z.number() })).optional(),
  colors: z.array(z.enum(colors)).optional(), modelRevision: z.string().optional(),
  suggestions: recognitionSchema.optional(),
  subcategoryReviewed: z.boolean().optional(),
  steps: z.object({ recognition: imageJobStepSchema, cutout: imageJobStepSchema }).optional(),
  outcome: z.enum(['complete', 'partial']).optional(), canRetry: z.boolean().optional()
});
export const imageJobInputSchema = z.object({
  inputAssetId: idSchema, clothingId: idSchema.optional(), kind: z.enum(['process', 'cutout', 'classify']),
  userPrompt: z.string().trim().max(300, '补充描述最多 300 字').optional(), refreshRecognition: z.boolean().optional(), editAssetId: idSchema.optional()
}).strict().refine(input => !input.refreshRecognition || Boolean(input.clothingId) && input.kind !== 'cutout', { message: '重新识别需要指定衣物及识别阶段' }).refine(input => !input.editAssetId || Boolean(input.clothingId && input.userPrompt) && input.kind === 'cutout' && !input.refreshRecognition && input.editAssetId !== input.inputAssetId, { message: '修补图片需要指定衣物、不同的原图和处理图，并填写修补意见' });
export type ImageJobInput = z.infer<typeof imageJobInputSchema>;
export const promptRefinementInputSchema = z.object({
  clothingId: idSchema, mode: z.enum(['repair', 'reidentify']), userPrompt: z.string().trim().min(1, '请先填写描述').max(300, '描述最多 300 字')
}).strict();
export type PromptRefinementInput = z.infer<typeof promptRefinementInputSchema>;
export const promptRefinementSchema = z.object({ status: z.enum(['ready', 'needs-detail']), text: z.string().trim().min(1).max(300) }).strict();
export const imageJobRetrySchema = z.object({ confirmUncertain: z.boolean().optional() }).strict();
export const jobSchema = z.object({
  importId: idSchema.nullable(), importItemId: idSchema.nullable(),
  id: idSchema, kind: z.string(), status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  phase: z.string(), inputAssetId: idSchema.nullable(), clothingId: idSchema.nullable(), errorCode: z.string().nullable(), editAssetId: idSchema.nullable(), userPrompt: z.string(), matchesPrimaryAsset: z.boolean(),
  result: imageJobResultSchema.nullable(), createdAt: z.iso.datetime(), providerPending: z.boolean(),
  clothingName: z.string().nullable(), clothingStatus: z.enum(['draft', 'active', 'archived']).nullable()
});
export const clothingStatisticsSchema = z.object({ id: idSchema, name: z.string(), primaryAssetId: idSchema, wearCount: z.number().int(), lastWornOn: dateSchema.nullable(), priceCents: z.string().nullable(), costPerWearCents: z.string().nullable() });
export const statisticsSchema = z.object({
  scope: z.enum(['active', 'all']), totalCount: z.number().int(), pricedCount: z.number().int(), totalPriceCents: z.string(),
  wornDays: z.number().int(), outfitCount: z.number().int(),
  categories: z.array(z.object({ name: z.string(), count: z.number().int() })),
  description: z.string()
});
const capabilitySchema = z.object({ available: z.boolean(), reason: z.string() });
export const capabilitiesSchema = z.object({ imageProcessing: capabilitySchema, weather: capabilitySchema, recommendation: capabilitySchema, tryOn: capabilitySchema,
  packingReminder: z.object({ available: z.boolean(), templateId: z.string() })
});
export const weatherLocationSchema = z.object({ id: z.string(), cityCode: z.string(), name: z.string(), path: z.string() });
export const weatherSchema = z.object({
  cityCode: z.string().regex(/^\d{6}$/), city: z.string(), updatedAt: z.iso.datetime({ offset: true }), source: z.string(), stale: z.boolean(),
  current: z.object({
    weather: z.string(), temperature: z.number(), windDirection: z.string(), windPower: z.string(), humidity: z.number().min(0).max(100),
    updatedAt: z.iso.datetime({ offset: true })
  }),
  forecast: z.array(z.object({ date: dateSchema, textDay: z.string(), textNight: z.string(), tempDay: z.number(), tempNight: z.number() })).min(1).max(3)
});
export const recommendationItemSchema = z.object({ clothingId: idSchema, name: z.string(), primaryAssetId: idSchema, reason: z.string() });
export const recommendationOutfitSchema = z.object({ id: idSchema, name: z.string(), reason: z.string(), items: z.array(recommendationItemSchema).min(2).max(6) });
export const recommendationSchema = z.object({
  id: idSchema, cityCode: z.string().regex(/^\d{6}$/), date: dateSchema,
  status: z.enum(['ready', 'empty-wardrobe', 'no-matches']), summary: z.string(),
  items: z.array(recommendationItemSchema).max(6), outfits: z.array(recommendationOutfitSchema).max(3), generatedAt: z.iso.datetime()
});
export type Weather = z.infer<typeof weatherSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;
export type RecommendationOutfit = z.infer<typeof recommendationOutfitSchema>;
export const exportSchema = z.object({ id: idSchema, status: z.enum(['queued', 'running', 'succeeded', 'failed']), assetId: idSchema.nullable(), expiresAt: z.iso.datetime().nullable(), errorCode: z.string().nullable() });
export const loginSchema = z.union([
  z.object({ token: z.string(), expiresAt: z.iso.datetime(), user: userSchema }),
  z.object({ requiresInvitation: z.literal(true), registrationToken: z.string() })
]);
export const paginationSchema = z.object({ page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });
export type Clothing = z.infer<typeof clothingSchema>;
export type Category = z.infer<typeof categorySchema>;
export type ClothingOption = z.infer<typeof clothingOptionSchema>;
export type ClothingOptionKind = z.infer<typeof clothingOptionKindSchema>;
export type Outfit = z.infer<typeof outfitSchema>;
export type OutfitCategory = z.infer<typeof outfitCategorySchema>;
export type LayoutItem = z.infer<typeof layoutItemSchema>;
export type WearRecord = z.infer<typeof wearSchema>;
export type PackingList = z.infer<typeof packingSchema>;
export type User = z.infer<typeof userSchema>;
export type ImageJob = z.infer<typeof jobSchema>;
export type ImageJobResult = z.infer<typeof imageJobResultSchema>;
export type Recognition = z.infer<typeof recognitionSchema>;

export const clothingImportSchema = z.object({
  id: idSchema, inputAssetId: idSchema, mode: z.enum(['single', 'set']),
  status: z.enum(['queued', 'processing', 'review', 'needs-attention', 'confirmed', 'cancelled']),
  name: z.string(), saveAsSet: z.boolean(), coverAssetId: idSchema.nullable(), version: z.number().int(),
  createdAt: z.iso.datetime(), itemCount: z.number().int(), pending: z.boolean()
});
export const redetectImportSchema = z.object({ version: z.number().int().positive(), userPrompt: z.string().trim().max(300).optional() }).strict();
export const clothingImportDetailSchema = clothingImportSchema.extend({
  items: z.array(z.object({ id: idSchema, included: z.boolean(), target: targetSchema.nullable(), clothing: clothingSchema.nullable() })),
  jobs: z.array(jobSchema)
});
export type ClothingSet = z.infer<typeof clothingSetSchema>;
export type ClothingImport = z.infer<typeof clothingImportSchema>;
export type ClothingImportDetail = z.infer<typeof clothingImportDetailSchema>;
export type ClothingTarget = z.infer<typeof targetSchema>;
