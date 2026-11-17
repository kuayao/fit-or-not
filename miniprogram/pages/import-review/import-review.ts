import { refreshExpiredImage } from '../../utils/refresh-image';
import { z } from 'zod';
import { idSchema, redetectImportSchema } from '../../api/contracts';
import type { ClothingImportDetail } from '../../api/contracts';
import { addImportItem, cancelClothingImport, confirmClothingImport, getClothingImport, imageUrls, redetectClothingImport, retryImageJob, updateClothingImport, uploadPhoto } from '../../api/client';
import { ApiError, RequestScope, errorMessage, requireSession, requestKey } from '../../utils/request';
import { prepareImageJobRetry } from '../../utils/image-job-retry';
import type { ImageJobRetryAttempt } from '../../utils/image-job-retry';

Page({
  scope: new RequestScope(), id: '', timer: 0, visible: true, dirty: false, coverDirty: false,
  confirmAttempt: null as { key: string; input: { version: number; items: { id: string; version: number }[] } } | null,
  redetectAttempt: null as { key: string; input: { version: number; userPrompt?: string } } | null,
  addAttempt: null as { key: string; input: { inputAssetId: string; version: number } } | null,
  retryAttempts: new Map<string, ImageJobRetryAttempt>(),
  data: { record: null as ClothingImportDetail | null, sourceUrl: '', coverUrl: '', coverAssetId: '', name: '', saveAsSet: false, count: 0,
    items: Array<ClothingImportDetail['items'][number] & { imageUrl: string; pending: boolean; message: string; retryId: string; providerPending: boolean; categorySuggestion: string }>(),
    loading: false, busy: false, error: '', confirmLocked: false, addPending: false, coverMessage: '', coverRetryId: '', coverProviderPending: false, locateRetryId: '', locateMessage: '', redetectOpen: false, userPrompt: '', redetectLocked: false },
  onLoad(options) { this.scope = new RequestScope(); this.retryAttempts = new Map(); if (!requireSession()) return; this.id = idSchema.parse(options.id); void this.load(); },
  onShow() { this.visible = true; if (this.scope.hasShown && requireSession()) void this.load(); this.scope.hasShown = true; },
  onHide() { this.visible = false; clearTimeout(this.timer); },
  onUnload() { this.visible = false; clearTimeout(this.timer); this.scope.close(); },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => { this.setData({ sourceUrl: this.data.sourceUrl === oldUrl ? url : this.data.sourceUrl, coverUrl: this.data.coverUrl === oldUrl ? url : this.data.coverUrl, items: this.data.items.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })) }); }, message => this.setData({ error: message }));
  },
  onRetry() { void this.load(); },
  onName(event: WechatMiniprogram.Input) { if (!this.data.busy && !this.confirmAttempt) { this.dirty = true; this.setData({ name: event.detail.value }); } },
  onSet(event: WechatMiniprogram.SwitchChange) { if (!this.data.busy && !this.confirmAttempt) { this.dirty = true; this.setData({ saveAsSet: event.detail.value }); } },
  onInclude(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.confirmAttempt) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    this.dirty = true;
    const items = this.data.items.map(item => item.id === id ? { ...item, included: !item.included } : item);
    this.setData({ items, count: items.filter(item => item.included && item.clothing).length });
  },
  onEdit(event: WechatMiniprogram.TouchEvent) {
    const id = idSchema.parse(event.currentTarget.dataset.id);
    wx.navigateTo({ url: `/pages/clothing-edit/clothing-edit?id=${id}` });
  },
  async onPreview(event: WechatMiniprogram.TouchEvent) {
    const id = idSchema.parse(event.currentTarget.dataset.assetId);
    try {
      const urls = await imageUrls(this.scope, [id], 'original');
      wx.previewImage({ urls: [urls[id]] });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message }); }
  },
  async onCover() {
    if (this.data.busy || this.confirmAttempt) return;
    try {
      const photos = await wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'] });
      if (!this.scope.active) return;
      this.setData({ busy: true });
      const result = await uploadPhoto(this.scope, photos.tempFiles[0].tempFilePath);
      this.coverDirty = true;
      this.setData({ coverAssetId: result.data.assetId, coverUrl: photos.tempFiles[0].tempFilePath, busy: false });
    } catch (error) { this.showPhotoError(error); }
  },
  async onAddItem() {
    if (this.data.busy || this.confirmAttempt || !this.data.record || (this.data.items.length >= 6 && !this.addAttempt)) return;
    try {
      if (!this.addAttempt) {
        const photos = await wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'] });
        if (!this.scope.active) return;
        this.setData({ busy: true, error: '' });
        const result = await uploadPhoto(this.scope, photos.tempFiles[0].tempFilePath);
        this.addAttempt = { input: { inputAssetId: result.data.assetId, version: this.data.record.version }, key: requestKey() };
        this.setData({ addPending: true });
      }
      this.setData({ busy: true, error: '' });
      await addImportItem(this.scope, this.id, this.addAttempt.input, this.addAttempt.key);
      this.addAttempt = null;
      this.setData({ busy: false, addPending: false });
      await this.load();
    } catch (error) {
      if (error instanceof Error && 'code' in error && !['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(String(error.code))) { this.addAttempt = null; this.setData({ addPending: false }); }
      this.showPhotoError(error);
    }
  },
  async onRetryJob(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.confirmAttempt) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    this.setData({ busy: true, error: '' });
    try {
      const attempt = this.retryAttempts.get(id) || await prepareImageJobRetry(this.scope, id);
      if (!attempt) { this.setData({ busy: false }); return; }
      this.retryAttempts.set(id, attempt);
      await retryImageJob(this.scope, id, attempt.key, attempt.confirmUncertain);
      this.retryAttempts.delete(id);
      this.setData({ busy: false });
      await this.load();
    } catch (error) {
      if (error instanceof ApiError && !['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(error.code)) this.retryAttempts.delete(id);
      const message = errorMessage(error); if (message) this.setData({ busy: false, error: message });
    }
  },
  onRedetect() {
    if (this.data.busy || !this.data.record || this.data.record.pending) return;
    const latest = [...this.data.record.jobs].reverse().find(job => job.kind === 'locate');
    this.setData({ redetectOpen: true, userPrompt: this.redetectAttempt ? this.data.userPrompt : latest?.userPrompt || '', error: '' });
  },
  onCloseRedetect() { if (!this.data.busy) this.setData({ redetectOpen: false }); },
  onUserPrompt(event: WechatMiniprogram.Input) { this.setData({ userPrompt: event.detail.value }); },
  async onConfirmRedetect() {
    if (this.data.busy || !this.data.record) return;
    const input = redetectImportSchema.safeParse({ version: this.data.record.version, userPrompt: this.data.userPrompt });
    if (!input.success) { this.setData({ error: '补充描述最多 300 字' }); return; }
    this.redetectAttempt ??= { key: requestKey(), input: input.data };
    this.setData({ busy: true, redetectLocked: true, error: '' });
    try {
      await redetectClothingImport(this.scope, this.id, this.redetectAttempt.input, this.redetectAttempt.key);
      this.redetectAttempt = null;
      this.setData({ busy: false, redetectLocked: false, redetectOpen: false });
      await this.load();
    } catch (error) {
      if (error instanceof Error && 'code' in error && !['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(String(error.code))) { this.redetectAttempt = null; this.setData({ redetectLocked: false }); }
      const message = errorMessage(error); if (message) this.setData({ busy: false, error: message });
    }
  },
  async onCancel() {
    if (this.data.busy || this.confirmAttempt) return;
    const answer = await wx.showModal({ title: '取消这次录入？', content: '本次生成的单品草稿将一并删除。', confirmText: '取消录入' });
    if (!answer.confirm || !this.scope.active) return;
    this.setData({ busy: true, error: '' });
    try { await cancelClothingImport(this.scope, this.id); wx.reLaunch({ url: '/pages/wardrobe/wardrobe' }); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ busy: false, error: message }); }
  },
  async onConfirm() {
    if (this.data.busy || this.addAttempt || !this.data.record || this.data.record.pending || !this.data.count) return;
    const needsReview = this.data.items.filter(item => item.included && item.categorySuggestion);
    if (!this.confirmAttempt && needsReview.length) {
      this.setData({ error: `请先确认${needsReview.map(item => `「${item.clothing!.name}」`).join('、')}的分类` }, () => {
        wx.pageScrollTo({ selector: `#review-item-${needsReview[0].id}`, duration: 300 });
      });
      return;
    }
    if (this.data.saveAsSet && (this.data.count < 2 || !this.data.name.trim())) { this.setData({ error: '请填写套装名称，并至少选择两件单品' }); return; }
    this.setData({ busy: true, error: '' });
    try {
      if (!this.confirmAttempt) {
        const saved = await updateClothingImport(this.scope, this.id, { version: this.data.record.version, name: this.data.name, saveAsSet: this.data.saveAsSet, coverAssetId: this.data.coverAssetId || null, items: this.data.items.map(item => ({ id: item.id, included: item.included })) });
        this.setData({ record: saved.data });
        this.confirmAttempt = { key: requestKey(), input: { version: saved.data.version, items: saved.data.items.filter(item => item.included && item.clothing).map(item => ({ id: item.clothing!.id, version: item.clothing!.version })) } };
        this.setData({ confirmLocked: true });
      }
      await confirmClothingImport(this.scope, this.id, this.confirmAttempt.input, this.confirmAttempt.key);
      wx.reLaunch({ url: '/pages/wardrobe/wardrobe' });
    } catch (error) {
      const message = errorMessage(error);
      // A received business error means the transaction did not commit; fields can be edited again.
      if (error instanceof Error && 'code' in error && !['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(String(error.code))) { this.confirmAttempt = null; this.setData({ confirmLocked: false }); }
      if (message) this.setData({ busy: false, error: message });
    }
  },
  showPhotoError(error: unknown) {
    const cancelled = z.object({ errMsg: z.string() }).safeParse(error);
    if (cancelled.success && cancelled.data.errMsg.includes('cancel')) { this.setData({ busy: false }); return; }
    const message = errorMessage(error); if (message) this.setData({ busy: false, error: message });
  },
  async load() {
    if (this.data.loading || this.data.busy) return;
    clearTimeout(this.timer);
    this.setData({ loading: true, error: '' });
    try {
      const record = (await getClothingImport(this.scope, this.id)).data;
      if (record.status === 'confirmed' || record.status === 'cancelled') { wx.reLaunch({ url: '/pages/wardrobe/wardrobe' }); return; }
      const single = record.items.find(item => item.clothing)?.clothing;
      if (record.mode === 'single' && !record.saveAsSet && record.itemCount === 1 && single) { wx.redirectTo({ url: `/pages/clothing-edit/clothing-edit?id=${single.id}` }); return; }
      const [urls, thumbnails] = await Promise.all([
        imageUrls(this.scope, [record.inputAssetId, ...(record.coverAssetId ? [record.coverAssetId] : [])]),
        imageUrls(this.scope, record.items.flatMap(item => item.clothing ? [item.clothing.primaryAssetId] : []), 'thumbnail')
      ]);
      if (!this.visible) { this.setData({ loading: false }); return; }
      const items = record.items.map(item => {
        const job = [...record.jobs].reverse().find(job => job.importItemId === item.id);
        const reviewResult = record.jobs.find(job => job.id === item.clothing?.processingJobId)?.result;
        return { ...item, included: this.dirty ? this.data.items.find(old => old.id === item.id)?.included ?? item.included : item.included,
          categorySuggestion: reviewResult?.suggestions?.subcategoryName && !reviewResult.subcategoryReviewed && reviewResult.suggestions.categoryId === reviewResult.suggestions.rootCategoryId ? reviewResult.suggestions.subcategoryName : '',
          imageUrl: item.clothing ? thumbnails[item.clothing.primaryAssetId] : '', pending: job?.status === 'queued' || job?.status === 'running',
          message: job?.result?.steps ? Object.values(job.result.steps).filter(step => step.status === 'failed' || step.skipReason === 'retake').map(step => step.errorCode === 'PROVIDER_PENDING' ? '处理未完成，请重试' : step.message).filter(Boolean).join('；') : '',
          providerPending: Boolean(job?.providerPending),
          retryId: job && (job.providerPending || job.result?.canRetry) && job.status !== 'queued' && job.status !== 'running' ? job.id : '' };
      });
      const locateJob = [...record.jobs].reverse().find(job => job.kind === 'locate');
      const coverJob = [...record.jobs].reverse().find(job => job.kind === 'set-cover');
      this.setData({ locateMessage: (locateJob?.errorCode === 'PROVIDER_PENDING' ? '识别未完成，请重试' : locateJob?.phase) || '未生成单品，请补充描述重新识别，或更换照片', record, sourceUrl: urls[record.inputAssetId], items, count: items.filter(item => item.included && item.clothing).length, loading: false,
        coverMessage: coverJob?.status === 'queued' || coverJob?.status === 'running' ? '正在生成整套图…' : coverJob?.status === 'failed' ? coverJob.providerPending ? '整套图生成未完成' : coverJob.result?.steps?.cutout.message || coverJob.phase : '',
        coverRetryId: coverJob?.status === 'failed' && (coverJob.providerPending || coverJob.result?.canRetry !== false) ? coverJob.id : '', coverProviderPending: Boolean(coverJob?.providerPending),
        locateRetryId: locateJob?.status === 'failed' && locateJob.providerPending ? locateJob.id : '',
        ...(!this.dirty ? { name: record.name, saveAsSet: record.saveAsSet } : {}),
        ...(!this.coverDirty ? { coverAssetId: record.coverAssetId || '', coverUrl: record.coverAssetId ? urls[record.coverAssetId] : '' } : {}) });
      if (record.pending) this.timer = setTimeout(() => { void this.load(); }, 2500);
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ loading: false, error: message }); }
  }
});
