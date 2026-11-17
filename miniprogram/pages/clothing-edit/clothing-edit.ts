import { refreshExpiredImage } from '../../utils/refresh-image';
import { z } from 'zod';
import { listCategories, listTags, listClothingOptions, getClothing, importClothing, updateClothing, deleteClothing, uploadPhoto, imageUrls, getCapabilities, createImageJob, getImageJob, retryImageJob, refineImagePrompt } from '../../api/client';
import { idSchema, clothingInputSchema, imageJobInputSchema, promptRefinementInputSchema, newSubcategorySchema, clothingOptionKindSchema, colors, seasons, seasonLabels, patterns, patternLabels } from '../../api/contracts';
import type { Clothing, Category, ClothingOption, ClothingOptionKind, ImageJobInput } from '../../api/contracts';
import { ApiError, RequestScope, errorMessage, requireSession, requestKey } from '../../utils/request';
import { money, currentDate } from '../../utils/format';
import type { SelectDetail } from '../../components/app-select-sheet/app-select-sheet';
import type { DateDetail } from '../../components/app-date-sheet/app-date-sheet';
import { COLOR_OPTIONS } from '../../config/colors';
import { prepareImageJobRetry } from '../../utils/image-job-retry';
import type { ImageJobRetryAttempt } from '../../utils/image-job-retry';

const subcategoryData = { subcategorySuggestionVisible: false, subcategorySuggestionName: '', subcategoryDecision: '', subcategoryError: '' };
const processData = {
  ...subcategoryData, processing: false, processQueued: false, processStatus: '', processError: '', processedAssetId: '', processedImageUrl: '', compareOpen: false,
  processOpen: false, processPrompt: '', processMode: 'reidentify', processLocked: false, processRetryId: '', processNeedsConfirmation: false, promptRefining: false
};
type OptionGroup = {
  kind: ClothingOptionKind; field: 'brandId' | 'sizeId' | 'materialId'; label: string;
  items: { id: string; name: string }[]; index: number;
};

Page({
  processAttempt: null as { key: string; input: ImageJobInput } | null,
  retryAttempts: new Map<string, ImageJobRetryAttempt>(),
  scope: new RequestScope(), clothingId: '', version: 0, dirty: false, replacePrimary: false, pendingPhotos: Array<{ path: string; assetId: string; key: string }>(),
  clothingOptions: Array<ClothingOption>(), processJobId: '', processTimer: 0, processPolling: false, visible: true, refreshOptions: false,
  data: {
    ...processData, importId: '', singleImport: false, setId: '', setName: '', originalAssetId: '', originalImageUrl: '',
    favorite: false, showMore: false, seasonOpen: false,
    moreDraft: { brandId: '', sizeId: '', materialId: '', notes: '', purchasedOn: '', itemType: '', colorDescription: '', pattern: '', patternIndex: 0, visibleFeaturesText: '', tags: Array<{ id: string; name: string; selected: boolean }>(), detailPhotos: Array<{ id: string; imageUrl: string }>() },
    optionGroups: Array<OptionGroup>(), sizeKind: 'clothing-size' as 'clothing-size' | 'shoe-size', sizeHint: '', optionsLoading: false, optionsError: '',
    choice: '', choiceTitle: '', choiceItems: Array<{ id: string; name: string }>(), optionField: 'brandId',
    seasonDraft: seasons.map((value, index) => ({ value, label: seasonLabels[index], selected: false })), seasonSummary: '', detailPhotos: Array<{ id: string; imageUrl: string }>(),
    name: '', primaryAssetId: '', imageUrl: '', categoryId: '', rootCategoryId: '', rootCategoryIndex: 0, rootCategories: Array<Category>(), subCategoryIndex: 0, subCategories: Array<{ id: string; name: string }>(), categories: Array<Category>(),
    itemType: '', colorDescription: '', pattern: '', patternIndex: 0, visibleFeaturesText: '',
    patternOptions: [{ value: '', label: '未确定' }, ...patterns.map((value, index) => ({ value, label: patternLabels[index] }))],
    colorOptions: COLOR_OPTIONS.map(item => ({ ...item, selected: false })),
    seasonOptions: seasons.map((value, index) => ({ value, label: seasonLabels[index], selected: false })),
    tags: Array<{ id: string; name: string; selected: boolean }>(), brandId: '', sizeId: '', materialId: '', price: '', purchasedOn: '', notes: '',
    remainingCount: 0, uploadedCount: 0, busy: false, loading: true, error: '', fieldError: '',
    imageProcessingAvailable: false, imageProcessingReason: '', status: 'draft', today: currentDate()
  },
  onLoad(options) {
    this.scope = new RequestScope(); this.retryAttempts = new Map();
    if (!requireSession()) return;
    const input = z.object({ id: idSchema.optional() }).parse(options);
    if (!input.id) { wx.redirectTo({ url: '/pages/clothing-import/clothing-import' }); return; }
    this.clothingId = input.id || '';
    wx.setNavigationBarTitle({ title: this.clothingId ? '编辑衣物' : '添加衣物' });
    void this.load();
  },
  onShow() {
    this.visible = true;
    if (this.refreshOptions) { this.refreshOptions = false; void this.loadOptions(true); }
    if (this.data.processing && this.processJobId) void this.pollProcess();
  },
  onHide() { this.visible = false; clearTimeout(this.processTimer); this.processTimer = 0; },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => { this.setData({ imageUrl: this.data.imageUrl === oldUrl ? url : this.data.imageUrl, originalImageUrl: this.data.originalImageUrl === oldUrl ? url : this.data.originalImageUrl, processedImageUrl: this.data.processedImageUrl === oldUrl ? url : this.data.processedImageUrl, detailPhotos: this.data.detailPhotos.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })), 'moreDraft.detailPhotos': this.data.moreDraft.detailPhotos.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })) }); }, message => this.setData({ error: message }));
  },
  onUnload() { this.visible = false; clearTimeout(this.processTimer); this.scope.close(); wx.disableAlertBeforeUnload(); },
  onMembership() { if (!this.data.busy && !this.data.processing) wx.navigateTo({ url: this.data.setId ? `/pages/clothing-set/clothing-set?id=${this.data.setId}` : `/pages/clothing-set/clothing-set?clothingId=${this.clothingId}` }); },
  onTasks() { wx.navigateTo({ url: '/pages/image-jobs/image-jobs' }); },
  onRetry() { void this.load(); },
  onWardrobe() { if (!this.data.busy) wx.reLaunch({ url: '/pages/wardrobe/wardrobe' }); },
  onMore() {
    this.setData({ showMore: true, moreDraft: { brandId: this.data.brandId, sizeId: this.data.sizeId, materialId: this.data.materialId, notes: this.data.notes, purchasedOn: this.data.purchasedOn, itemType: this.data.itemType, colorDescription: this.data.colorDescription, pattern: this.data.pattern, patternIndex: this.data.patternIndex, visibleFeaturesText: this.data.visibleFeaturesText, tags: this.data.tags.map(item => ({ ...item })), detailPhotos: this.data.detailPhotos.map(item => ({ ...item })) } });
    this.renderOptions();
  },
  onCloseMore() { if (!this.data.busy) this.setData({ showMore: false }); },
  onConfirmMore() {
    if (this.data.busy || this.data.optionsLoading || this.data.optionsError) return;
    if ((['brandId', 'sizeId', 'materialId', 'notes', 'purchasedOn', 'itemType', 'colorDescription', 'pattern', 'visibleFeaturesText', 'tags', 'detailPhotos'] as const)
      .some(field => JSON.stringify(this.data.moreDraft[field]) !== JSON.stringify(this.data[field]))) this.markDirty();
    this.setData({ ...this.data.moreDraft, showMore: false });
  },
  onMoreInput(event: WechatMiniprogram.Input) {
    const field = z.enum(['notes', 'itemType', 'colorDescription', 'visibleFeaturesText']).parse(event.currentTarget.dataset.field);
    this.setData({ [`moreDraft.${field}`]: event.detail.value });
  },
  onOpenChoice(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.processing) return;
    const choice = z.enum(['root-category', 'sub-category', 'pattern', 'option']).parse(event.currentTarget.dataset.choice);
    if (choice === 'option') {
      const field = z.enum(['brandId', 'sizeId', 'materialId']).parse(event.currentTarget.dataset.field);
      const group = this.data.optionGroups.find(item => item.field === field)!;
      this.setData({ choice, choiceTitle: `选择${group.label}`, optionField: field, choiceItems: group.items });
      return;
    }
    if (choice === 'pattern') {
      this.setData({ choice, choiceTitle: '选择图案', choiceItems: this.data.patternOptions.map(item => ({ id: item.value, name: item.label })) });
      return;
    }
    if (choice === 'sub-category' && !this.data.rootCategoryId) return;
    const items = choice === 'root-category' ? this.data.rootCategories : this.data.subCategories;
    this.setData({ choice, choiceTitle: choice === 'root-category' ? '选择一级分类' : '选择二级分类', choiceItems: items.map(item => ({ id: item.id, name: item.name })) });
  },
  onCloseChoice() { this.setData({ choice: '' }); },
  onChoose(event: WechatMiniprogram.CustomEvent<SelectDetail>) {
    if (this.data.choice === 'pattern') {
      const pattern = event.detail.id;
      this.setData({ 'moreDraft.pattern': pattern, 'moreDraft.patternIndex': this.data.patternOptions.findIndex(item => item.value === pattern), choice: '' });
      return;
    }
    if (this.data.choice === 'option') {
      if (this.data.optionsLoading || this.data.optionsError) return;
      const id = event.detail.id;
      this.setData({ [`moreDraft.${this.data.optionField}`]: id, choice: '', sizeHint: this.data.optionField === 'sizeId' ? '' : this.data.sizeHint });
      this.renderOptions();
      return;
    }
    const id = event.detail.id;
    if (this.data.choice === 'sub-category') { if (id !== this.data.categoryId || this.data.subcategorySuggestionVisible) this.markDirty(); this.setData({ ...subcategoryData, categoryId: id, subCategoryIndex: this.data.subCategories.findIndex(item => item.id === id), choice: '', fieldError: '' }); return; }
    if (id === this.data.rootCategoryId) { this.setData({ choice: '' }); return; }
    this.markDirty();
    const category = this.data.rootCategories.find(item => item.id === id)!;
    const clearSize = this.data.sizeKind !== category.sizeKind;
    this.setData({ ...subcategoryData, rootCategoryIndex: this.data.rootCategories.findIndex(item => item.id === id), rootCategoryId: id, categoryId: id, subCategoryIndex: 0, choice: '', fieldError: '', sizeKind: category.sizeKind,
      subCategories: [{ id, name: '暂不细分' }, ...this.data.categories.filter(item => item.parentId === id)],
      ...(clearSize ? { sizeId: '', 'moreDraft.sizeId': '', sizeHint: this.data.sizeId ? '分类已变更，请重新选择尺码' : '' } : {}) });
    this.renderOptions();
  },
  onSubcategoryName(event: WechatMiniprogram.Input) {
    if (this.data.busy) return;
    if (event.detail.value !== this.data.subcategorySuggestionName) this.markDirty();
    this.setData({ subcategorySuggestionName: event.detail.value, subcategoryDecision: '', subcategoryError: '' });
  },
  onSubcategoryDecision(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    this.markDirty();
    this.setData({ subcategoryDecision: z.enum(['create', 'skip']).parse(event.currentTarget.dataset.decision), subcategoryError: '' });
  },
  onManageOptions(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.optionsLoading) return;
    const kind = clothingOptionKindSchema.parse(event.currentTarget.dataset.kind);
    this.setData({ choice: '' });
    this.refreshOptions = true;
    wx.navigateTo({ url: `/pages/taxonomy/taxonomy?kind=${kind}` });
  },
  onRetryOptions() { void this.loadOptions(true); },
  onOpenSeason() { this.setData({ seasonOpen: true, seasonDraft: this.data.seasonOptions.map(item => ({ ...item })) }); },
  onCloseSeason() { this.setData({ seasonOpen: false }); },
  onConfirmSeason() { if (this.data.seasonDraft.some((item, index) => item.selected !== this.data.seasonOptions[index].selected)) this.markDirty(); this.setData({ seasonOpen: false, seasonOptions: this.data.seasonDraft, seasonSummary: this.data.seasonDraft.filter(item => item.selected).map(item => item.label).join(' / ') }); },
  onInput(event: WechatMiniprogram.Input) {
    const field = z.enum(['name', 'price']).parse(event.currentTarget.dataset.field);
    if (event.detail.value !== this.data[field]) this.markDirty();
    this.setData({ [field]: event.detail.value });
  },
  onOpenDate() { if (!this.data.busy) this.setData({ choice: 'date', choiceTitle: '购买日期' }); },
  onDate(event: WechatMiniprogram.CustomEvent<DateDetail>) { this.setData({ 'moreDraft.purchasedOn': event.detail.value, choice: '' }); },
  onClearDate() { this.setData({ 'moreDraft.purchasedOn': '' }); },
  onColor(event: WechatMiniprogram.TouchEvent) {
    const value = z.enum(colors).parse(event.currentTarget.dataset.value);
    this.markDirty();
    this.setData({ colorOptions: this.data.colorOptions.map(item => ({ ...item, selected: item.value === value ? !item.selected : item.selected })) });
  },
  onSeason(event: WechatMiniprogram.TouchEvent) {
    const value = z.enum(seasons).parse(event.currentTarget.dataset.value);
    this.setData({ seasonDraft: this.data.seasonDraft.map(item => ({ ...item, selected: item.value === value ? !item.selected : item.selected })) });
  },
  onTag(event: WechatMiniprogram.TouchEvent) {
    const id = idSchema.parse(event.currentTarget.dataset.id);
    this.setData({ 'moreDraft.tags': this.data.moreDraft.tags.map(item => ({ ...item, selected: item.id === id ? !item.selected : item.selected })) });
  },
  async onChoosePhoto() {
    if (this.data.busy || this.data.processing) return;
    if (!this.clothingId && !this.data.imageProcessingAvailable) { this.setData({ error: this.data.imageProcessingReason }); return; }
    try {
      const result = await wx.chooseMedia({ count: this.clothingId ? 1 : 20, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'] });
      if (!this.scope.active) return;
      this.replacePrimary = Boolean(this.clothingId);
      this.pendingPhotos = result.tempFiles.map(file => ({ path: file.tempFilePath, assetId: '', key: requestKey() }));
      this.markDirty();
      await this.uploadPending();
    } catch (error) {
      const cancellation = z.object({ errMsg: z.string() }).safeParse(error);
      if (cancellation.success && cancellation.data.errMsg.includes('cancel')) return;
      const message = errorMessage(error); if (message) this.setData({ error: message, busy: false });
    }
  },
  async onCrop() {
    if (this.data.busy || this.data.processing || !this.data.imageUrl) return;
    this.setData({ busy: true, error: '' });
    try {
      const urls = await imageUrls(this.scope, [this.data.primaryAssetId], 'original');
      const downloaded = await new Promise<WechatMiniprogram.DownloadFileSuccessCallbackResult>((resolve, reject) => wx.downloadFile({ url: urls[this.data.primaryAssetId], success: resolve, fail: reject }));
      if (downloaded.statusCode !== 200) throw new ApiError('CROP_DOWNLOAD_FAILED', '图片下载失败，请重新尝试裁剪');
      if (!this.scope.active) return;
      const source = downloaded.tempFilePath;
      const cropped = await new Promise<WechatMiniprogram.CropImageSuccessCallbackResult>((resolve, reject) => wx.cropImage({ src: source, cropScale: '3:4', success: resolve, fail: reject }));
      if (!this.scope.active) return;
      this.replacePrimary = Boolean(this.clothingId);
      this.pendingPhotos = [{ path: cropped.tempFilePath, assetId: '', key: requestKey() }];
      this.markDirty();
      this.setData({ busy: false });
      await this.uploadPending();
    } catch (error) {
      const cancellation = z.object({ errMsg: z.string() }).safeParse(error);
      if (cancellation.success && cancellation.data.errMsg.includes('cancel')) { this.setData({ busy: false }); return; }
      const message = cancellation.success && cancellation.data.errMsg.includes('开发者工具暂时不支持') ? '微信开发者工具暂不支持裁剪，请在微信真机中使用' : errorMessage(error);
      if (message) this.setData({ error: message, busy: false });
    }
  },
  onRetryUpload() { void this.uploadPending(); },
  async onDetailPhotos() {
    if (this.data.busy || this.data.moreDraft.detailPhotos.length >= 9) return;
    try {
      const photos = await wx.chooseMedia({ count: 9 - this.data.moreDraft.detailPhotos.length, mediaType: ['image'], sizeType: ['compressed'] });
      if (!this.scope.active) return;
      this.setData({ busy: true, error: '' });
      for (const photo of photos.tempFiles) {
        const result = await uploadPhoto(this.scope, photo.tempFilePath);
        this.setData({ 'moreDraft.detailPhotos': [...this.data.moreDraft.detailPhotos, { id: result.data.assetId, imageUrl: photo.tempFilePath }] });
      }
      this.setData({ busy: false });
    } catch (error) {
      const cancellation = z.object({ errMsg: z.string() }).safeParse(error);
      if (cancellation.success && cancellation.data.errMsg.includes('cancel')) return;
      const message = errorMessage(error); if (message) this.setData({ error: message, busy: false });
    }
  },
  onRemoveDetail(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    this.setData({ 'moreDraft.detailPhotos': this.data.moreDraft.detailPhotos.filter(item => item.id !== id) });
  },
  onCompare() { this.setData({ compareOpen: true }); },
  onCloseCompare() { this.setData({ compareOpen: false }); },
  onUseImage(event: WechatMiniprogram.TouchEvent) {
    const variant = z.enum(['original', 'processed']).parse(event.currentTarget.dataset.variant);
    if (this.data.primaryAssetId !== (variant === 'original' ? this.data.originalAssetId : this.data.processedAssetId)) this.markDirty();
    this.setData({ primaryAssetId: variant === 'original' ? this.data.originalAssetId : this.data.processedAssetId,
      imageUrl: variant === 'original' ? this.data.originalImageUrl : this.data.processedImageUrl, compareOpen: false });
  },
  onProcess() {
    if (this.data.busy || this.data.processing || !this.clothingId || !this.data.imageProcessingAvailable) return;
    if (this.data.processNeedsConfirmation) { void this.onRetryProcess(); return; }
    if (this.processAttempt) { this.setData({ processOpen: true }); return; }
    const mode = this.data.processedAssetId ? 'repair' : 'reidentify';
    this.setData({ processOpen: true, processMode: mode, processPrompt: mode === this.data.processMode ? this.data.processPrompt : '', processError: '', fieldError: '' });
  },
  onCloseProcess() { if (!this.data.busy && !this.data.promptRefining) this.setData({ processOpen: false }); },
  onPreviewProcessImage(event: WechatMiniprogram.TouchEvent) { wx.previewImage({ urls: [z.string().min(1).parse(event.currentTarget.dataset.url)] }); },
  onProcessMode(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.promptRefining || this.processAttempt) return;
    const mode = z.enum(['repair', 'reidentify']).parse(event.currentTarget.dataset.mode);
    if (mode === 'repair' && !this.data.processedAssetId) return;
    this.setData({ processMode: mode, processPrompt: '', processError: '' });
  },
  onProcessPrompt(event: WechatMiniprogram.Input) { this.setData({ processPrompt: event.detail.value }); },
  async onRefinePrompt() {
    if (this.data.busy || this.data.promptRefining || this.data.processLocked) return;
    const input = promptRefinementInputSchema.safeParse({ clothingId: this.clothingId, mode: this.data.processMode, userPrompt: this.data.processPrompt });
    if (!input.success) { this.setData({ processError: input.error.issues[0].message }); return; }
    this.setData({ promptRefining: true, processError: '' });
    try {
      const result = await refineImagePrompt(this.scope, input.data);
      if (!this.scope.active) return;
      if (result.data.status === 'needs-detail') {
        this.setData({ promptRefining: false });
        wx.showModal({ title: this.data.processMode === 'repair' ? '请说明修补部位' : '请补充目标描述', content: result.data.text, showCancel: false, confirmText: '继续填写' });
        return;
      }
      this.setData({ promptRefining: false, processPrompt: result.data.text });
      wx.showToast({ title: result.data.text === input.data.userPrompt ? '描述已足够明确' : '描述已优化', icon: 'none' });
    } catch (error) {
      if (!this.scope.active) return;
      this.setData({ promptRefining: false, processError: errorMessage(error) });
    }
  },
  async onRetryProcess() {
    if (this.data.busy || this.data.processing || !this.data.processRetryId) return;
    const id = this.data.processRetryId;
    this.setData({ busy: true, processError: '' });
    try {
      const attempt = this.retryAttempts.get(id) || await prepareImageJobRetry(this.scope, id);
      if (!attempt) { this.setData({ busy: false }); return; }
      this.retryAttempts.set(id, attempt);
      await retryImageJob(this.scope, id, attempt.key, attempt.confirmUncertain);
      this.retryAttempts.delete(id);
      this.setData({ busy: false });
      await this.loadClothing();
    } catch (error) {
      if (error instanceof ApiError && !['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(error.code)) this.retryAttempts.delete(id);
      const message = errorMessage(error); if (message) this.setData({ busy: false, processError: message });
    }
  },
  async onConfirmProcess() {
    if (this.data.busy || this.data.promptRefining || this.data.processing || !this.clothingId || !this.data.imageProcessingAvailable) return;
    const jobInput = imageJobInputSchema.safeParse({ inputAssetId: this.data.originalAssetId, clothingId: this.clothingId, userPrompt: this.data.processPrompt, ...(this.data.processMode === 'repair' ? { kind: 'cutout', editAssetId: this.data.processedAssetId } : { kind: 'process', refreshRecognition: true }) });
    if (!jobInput.success) { this.setData({ processError: jobInput.error.issues[0].message }); return; }
    const input = this.getInput();
    if (!input) return;
    this.setData({ busy: true, error: '', processError: '' });
    try {
      if (!this.processAttempt) {
        const saved = await updateClothing(this.scope, this.clothingId, { ...input, version: this.version });
        this.version = saved.data.version;
        this.dirty = false;
        wx.disableAlertBeforeUnload();
        this.processAttempt = { input: jobInput.data, key: requestKey() };
        this.setData({ processLocked: true });
      }
      const result = await createImageJob(this.scope, this.processAttempt.input, this.processAttempt.key);
      this.processAttempt = null;
      this.processJobId = result.data.id;
      this.setData({ processing: true, processQueued: result.data.status === 'queued', busy: false, processOpen: false, processLocked: false, processPrompt: result.data.userPrompt, showMore: false, seasonOpen: false, compareOpen: false, processStatus: result.data.phase });
      wx.setNavigationBarTitle({ title: this.data.processMode === 'repair' ? '修补图片' : '识别图片' });
      await this.pollProcess();
    } catch (error) {
      if (error instanceof ApiError && !['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(error.code)) { this.processAttempt = null; this.setData({ processLocked: false }); }
      const message = errorMessage(error); if (message) this.setData({ processError: message, busy: false });
    }
  },
  async pollProcess() {
    if (this.processPolling) return;
    this.processPolling = true;
    clearTimeout(this.processTimer);
    this.processTimer = 0;
    try {
      const job = (await getImageJob(this.scope, this.processJobId)).data;
      if (!this.visible) return;
      if (job.status === 'queued' || job.status === 'running') {
        this.setData({ processQueued: job.status === 'queued', processStatus: job.phase || '正在处理图片', processError: '' });
        this.processTimer = setTimeout(() => { void this.pollProcess(); }, 2000);
        return;
      }
      await this.loadClothing();
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ processStatus: '暂未取回状态，请到处理列表刷新', processError: message }); }
    finally { this.processPolling = false; }
  },
  getInput() {
    if (this.data.price && !/^(0|[1-9]\d{0,12})(\.\d{1,2})?$/.test(this.data.price)) { this.setData({ fieldError: '价格请输入非负金额，最多两位小数' }); return; }
    if (this.data.purchasedOn > this.data.today) { this.setData({ fieldError: '购买日期不能晚于今天' }); return; }
    const amount = this.data.price.split('.');
    const input = clothingInputSchema.safeParse({
      favorite: this.data.favorite, detailAssetIds: this.data.detailPhotos.map(item => item.id),
      name: this.data.name, primaryAssetId: this.data.primaryAssetId, categoryId: this.data.categoryId || null,
      itemType: this.data.itemType || null, colorDescription: this.data.colorDescription || null, pattern: this.data.pattern || null,
      visibleFeatures: this.data.visibleFeaturesText.split(/[，,、\n]/).map(value => value.trim()).filter(Boolean),
      colors: this.data.colorOptions.filter(item => item.selected).map(item => item.value), seasons: this.data.seasonOptions.filter(item => item.selected).map(item => item.value),
      tagIds: this.data.tags.filter(item => item.selected).map(item => item.id), brandId: this.data.brandId || null, sizeId: this.data.sizeId || null, materialId: this.data.materialId || null,
      priceCents: this.data.price ? `${amount[0]}${(amount[1] || '').padEnd(2, '0')}`.replace(/^0+(?=\d)/, '') : null,
      purchasedOn: this.data.purchasedOn || null, notes: this.data.notes, status: this.data.status
    });
    if (!input.success) { this.setData({ fieldError: '请检查资料格式，可见特征最多 5 项，每项最多 20 字' }); return; }
    return input.data;
  },
  async onDelete() {
    if (this.data.busy || this.data.loading || this.data.processing || !this.clothingId) return;
    this.setData({ busy: true });
    const answer = await wx.showModal({ title: '永久删除这件待核对衣物？', content: '删除后无法恢复。', confirmText: '删除', confirmColor: '#c43c3c' });
    if (!this.scope.active) return;
    if (!answer.confirm) { this.setData({ busy: false }); return; }
    try {
      await deleteClothing(this.scope, this.clothingId);
      this.dirty = false;
      wx.disableAlertBeforeUnload();
      if (this.data.importId) { wx.navigateBack(); return; }
      wx.reLaunch({ url: '/pages/wardrobe/wardrobe' });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async onSave() {
    if (this.data.busy || this.data.processing) return;
    if (!this.data.categoryId) { this.setData({ fieldError: '请选择衣物分类' }); return; }
    if (this.data.subcategorySuggestionVisible && !this.data.subcategoryDecision) { this.setData({ subcategoryError: '请选择采用建议或暂不新增' }); return; }
    const newSubcategory = this.data.subcategorySuggestionVisible && this.data.subcategoryDecision === 'create'
      ? newSubcategorySchema.safeParse({ parentId: this.data.rootCategoryId, name: this.data.subcategorySuggestionName }) : null;
    if (newSubcategory && !newSubcategory.success) { this.setData({ subcategoryError: newSubcategory.error.issues[0].message }); return; }
    const input = this.getInput();
    if (!input) return;
    this.setData({ busy: true, error: '', fieldError: '' });
    try {
      const result = await updateClothing(this.scope, this.clothingId, { ...input, ...(newSubcategory?.success ? { newSubcategory: newSubcategory.data } : {}), status: this.data.importId && !this.data.singleImport ? 'draft' : this.data.status === 'archived' ? 'archived' : 'active', version: this.version });
      this.version = result.data.version;
      this.clothingId = result.data.id;
      this.dirty = false;
      wx.disableAlertBeforeUnload();
      this.setData({ busy: false });
      if (result.data.importId) { wx.navigateBack(); return; }
      wx.redirectTo({ url: `/pages/clothing-detail/clothing-detail?id=${result.data.id}` });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  markDirty() { if (this.dirty) return; this.dirty = true; wx.enableAlertBeforeUnload({ message: '衣物资料尚未保存，离开后本次修改会丢失' }); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const [categories, tags, capabilities] = await Promise.all([listCategories(this.scope), listTags(this.scope), getCapabilities(this.scope), this.loadOptions()]);
      this.setData({ categories: categories.data, rootCategories: categories.data.filter(item => !item.parentId), tags: tags.data.map(item => ({ ...item, selected: false })), imageProcessingAvailable: capabilities.data.imageProcessing.available, imageProcessingReason: capabilities.data.imageProcessing.reason });
      if (this.clothingId) await this.loadClothing();
      this.setData({ loading: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, loading: false }); }
  },
  renderOptions() {
    const fields: Pick<OptionGroup, 'kind' | 'field' | 'label'>[] = [
      { kind: 'brand', field: 'brandId', label: '品牌' },
      { kind: this.data.sizeKind, field: 'sizeId', label: this.data.sizeKind === 'shoe-size' ? '鞋码' : '服装尺码' },
      { kind: 'material', field: 'materialId', label: '面料' }
    ];
    const optionGroups = fields.map(group => {
      const items = [{ id: '', name: '未选择' }, ...this.clothingOptions.filter(item => item.kind === group.kind).map(item => ({ id: item.id, name: item.name }))];
      return { ...group, items, index: Math.max(0, items.findIndex(item => item.id === (this.data.showMore ? this.data.moreDraft[group.field] : this.data[group.field]))) };
    });
    this.setData({ optionGroups });
    if (this.data.choice === 'option') {
      const group = optionGroups.find(item => item.field === this.data.optionField)!;
      this.setData({ choiceTitle: `选择${group.label}`, choiceItems: group.items });
    }
  },
  async loadOptions(refreshCategories = false) {
    if (this.data.optionsLoading) return;
    this.setData({ optionsLoading: true, optionsError: '' });
    try {
      const [result, categories] = await Promise.all([listClothingOptions(this.scope), refreshCategories ? listCategories(this.scope) : Promise.resolve(null)]);
      this.clothingOptions = result.data;
      if (categories) {
        const category = categories.data.find(item => item.id === this.data.categoryId);
        const rootCategoryId = category?.parentId || category?.id || '';
        const rootCategories = categories.data.filter(item => !item.parentId);
        const subCategories = rootCategoryId ? [{ id: rootCategoryId, name: '暂不细分' }, ...categories.data.filter(item => item.parentId === rootCategoryId)] : [];
        this.setData({ ...(rootCategoryId !== this.data.rootCategoryId ? subcategoryData : {}), categories: categories.data, categoryId: category?.id || '', rootCategories, rootCategoryId, rootCategoryIndex: Math.max(0, rootCategories.findIndex(item => item.id === rootCategoryId)), subCategories,
          subCategoryIndex: Math.max(0, subCategories.findIndex(item => item.id === category?.id)), sizeKind: category?.sizeKind || this.data.sizeKind });
      }
      const validSize = this.clothingOptions.some(item => item.id === this.data.sizeId && item.kind === this.data.sizeKind);
      const validDraftSize = this.clothingOptions.some(item => item.id === this.data.moreDraft.sizeId && item.kind === this.data.sizeKind);
      this.setData({ optionsLoading: false, sizeId: validSize ? this.data.sizeId : '', 'moreDraft.sizeId': validDraftSize ? this.data.moreDraft.sizeId : '',
        sizeHint: !validSize && this.data.sizeId ? '分类或尺码已变更，请重新选择尺码' : this.data.sizeHint,
        ...Object.fromEntries((['brandId', 'materialId'] as const).flatMap(field => [
          [field, result.data.some(item => item.id === this.data[field]) ? this.data[field] : ''],
          [`moreDraft.${field}`, result.data.some(item => item.id === this.data.moreDraft[field]) ? this.data.moreDraft[field] : '']
        ])) });
      this.renderOptions();
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ optionsError: message, optionsLoading: false }); }
  },
  async loadClothing() {
    const result = await getClothing(this.scope, this.clothingId);
    const job = result.data.processingJobId ? (await getImageJob(this.scope, result.data.processingJobId)).data : null;
    const imageJob = job?.matchesPrimaryAsset ? job : null;
    const processedAssetId = imageJob?.result?.cutoutAssetId || imageJob?.editAssetId || (imageJob && result.data.primaryAssetId !== imageJob.inputAssetId ? result.data.primaryAssetId : '');
    const [urls, thumbnails] = await Promise.all([
      imageUrls(this.scope, [result.data.primaryAssetId, ...(imageJob?.inputAssetId ? [imageJob.inputAssetId] : []), ...(processedAssetId ? [processedAssetId] : [])]),
      imageUrls(this.scope, result.data.detailAssetIds, 'thumbnail')
    ]);
    this.setData({ detailPhotos: result.data.detailAssetIds.map(id => ({ id, imageUrl: thumbnails[id] })) });
    this.applyClothing(result.data, urls[result.data.primaryAssetId]);
    const suggestions = imageJob?.result?.suggestions;
    this.setData({ originalAssetId: imageJob?.inputAssetId || result.data.primaryAssetId, originalImageUrl: urls[imageJob?.inputAssetId || result.data.primaryAssetId],
      processPrompt: imageJob?.userPrompt || '', processMode: imageJob?.editAssetId ? 'repair' : 'reidentify',
      subcategorySuggestionVisible: Boolean(suggestions?.subcategoryName && !imageJob?.result?.subcategoryReviewed && suggestions.rootCategoryId === this.data.rootCategoryId && suggestions.categoryId === suggestions.rootCategoryId && result.data.categoryId === suggestions.rootCategoryId),
      subcategorySuggestionName: suggestions?.subcategoryName || '',
      processedAssetId, processedImageUrl: processedAssetId ? urls[processedAssetId] : '',
      processRetryId: imageJob && (imageJob.providerPending || imageJob.result?.canRetry) && imageJob.status !== 'queued' && imageJob.status !== 'running' ? imageJob.id : '',
      processNeedsConfirmation: Boolean(imageJob?.providerPending),
      processError: job?.result?.steps ? Object.values(job.result.steps).filter(step => step.status === 'failed' || step.skipReason === 'retake').map(step => step.errorCode === 'PROVIDER_PENDING' ? '处理未完成，请重试' : step.message).filter(Boolean).join('；') : '' });
    if (this.data.processing && imageJob?.editAssetId) wx.setNavigationBarTitle({ title: '修补图片' });
    if (this.data.processing && this.visible && !this.processPolling) void this.pollProcess();
  },
  applyClothing(clothing: Clothing, imageUrl: string) {
    this.version = clothing.version;
    this.processJobId = clothing.processingJobId || '';
    const category = this.data.categories.find(item => item.id === clothing.categoryId);
    const rootCategoryId = category?.parentId || category?.id || '';
    const subCategories = rootCategoryId ? [{ id: rootCategoryId, name: '暂不细分' }, ...this.data.categories.filter(item => item.parentId === rootCategoryId)] : [];
    this.setData({ ...processData, importId: clothing.importId || '', singleImport: clothing.singleImport, setId: clothing.setId || '', setName: clothing.clothingSet?.name || '', sizeKind: category?.sizeKind || 'clothing-size', sizeHint: '', rootCategoryId, rootCategoryIndex: Math.max(0, this.data.rootCategories.findIndex(item => item.id === rootCategoryId)), subCategories, subCategoryIndex: Math.max(0, subCategories.findIndex(item => item.id === clothing.categoryId)), processing: clothing.processingStatus === 'queued' || clothing.processingStatus === 'running', processStatus: clothing.processingPhase || '', originalAssetId: clothing.primaryAssetId, originalImageUrl: imageUrl, seasonSummary: clothing.seasons.map(value => seasonLabels[seasons.indexOf(value)]).join(' / '), favorite: clothing.favorite, name: clothing.name, categoryId: clothing.categoryId || '',
      processQueued: clothing.processingStatus === 'queued',
      itemType: clothing.itemType || '', colorDescription: clothing.colorDescription || '', pattern: clothing.pattern || '', patternIndex: this.data.patternOptions.findIndex(item => item.value === (clothing.pattern || '')), visibleFeaturesText: clothing.visibleFeatures.join('、'),
      primaryAssetId: clothing.primaryAssetId, imageUrl, brandId: clothing.brandId || '', sizeId: clothing.sizeId || '', materialId: clothing.materialId || '', price: clothing.priceCents === null ? '' : money(clothing.priceCents), purchasedOn: clothing.purchasedOn || '', notes: clothing.notes, status: clothing.status,
      colorOptions: this.data.colorOptions.map(item => ({ ...item, selected: clothing.colors.includes(item.value) })), seasonOptions: this.data.seasonOptions.map(item => ({ ...item, selected: clothing.seasons.includes(item.value) })), tags: this.data.tags.map(item => ({ ...item, selected: clothing.tagIds.includes(item.id) })) });
    this.renderOptions();
    wx.setNavigationBarTitle({ title: this.data.processing ? '识别图片' : clothing.status === 'draft' ? '添加衣物' : '编辑衣物' });
  },
  async uploadPending() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '', remainingCount: this.pendingPhotos.length });
    try {
      while (this.pendingPhotos.length) {
        const photo = this.pendingPhotos[0];
        if (!photo.assetId) photo.assetId = (await uploadPhoto(this.scope, photo.path)).data.assetId;
        if (this.replacePrimary) { this.processJobId = ''; this.setData({ ...processData, primaryAssetId: photo.assetId, imageUrl: photo.path, originalAssetId: photo.assetId, originalImageUrl: photo.path, remainingCount: this.pendingPhotos.length - 1 }); this.pendingPhotos.shift(); continue; }
        await importClothing(this.scope, photo.assetId, photo.key);
        this.pendingPhotos.shift();
        this.setData({ uploadedCount: this.data.uploadedCount + 1, remainingCount: this.pendingPhotos.length });
      }
      this.setData({ busy: false, remainingCount: 0 });
      if (!this.replacePrimary) this.onWardrobe();
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false, remainingCount: this.pendingPhotos.length }); }
  }
});
