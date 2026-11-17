import { z } from 'zod';
import { getCapabilities, startClothingImport, uploadPhoto } from '../../api/client';
import { RequestScope, errorMessage, requireSession, requestKey } from '../../utils/request';

type Photo = { id: string; path: string; mode: 'single' | 'set'; locked: boolean; submitted: boolean; error: string };
Page({
  scope: new RequestScope(), dirty: false, uploads: new Map<string, { assetId: string; key: string }>(),
  data: { photos: Array<Photo>(), busy: false, loading: true, available: false, error: '', singleCount: 0, setCount: 0, pendingCount: 0 },
  onLoad() { this.scope = new RequestScope(); if (requireSession()) void this.load(); },
  onUnload() { this.scope.close(); wx.disableAlertBeforeUnload(); },
  onRetry() { void this.load(); },
  async onAdd() {
    if (this.data.busy || this.data.photos.length >= 20) return;
    try {
      const result = await wx.chooseMedia({ count: 20 - this.data.photos.length, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'] });
      if (!this.scope.active) return;
      this.setData({ photos: [...this.data.photos, ...result.tempFiles.map(file => ({ id: requestKey(), path: file.tempFilePath, mode: 'single' as const, locked: false, submitted: false, error: '' }))] });
      this.renderCounts();
    } catch (error) {
      const cancelled = z.object({ errMsg: z.string() }).safeParse(error);
      if (cancelled.success && cancelled.data.errMsg.includes('cancel')) return;
      const message = errorMessage(error); if (message) this.setData({ error: message });
    }
  },
  onMode(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const mode = z.enum(['single', 'set']).parse(event.currentTarget.dataset.mode);
    const id = z.string().parse(event.currentTarget.dataset.id);
    this.setData({ photos: this.data.photos.map(photo => !photo.locked && photo.id === id ? { ...photo, mode } : photo) });
    this.renderCounts();
  },
  onRemove(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const id = z.string().parse(event.currentTarget.dataset.id);
    this.setData({ photos: this.data.photos.filter(photo => photo.id !== id || photo.locked) });
    this.renderCounts();
  },
  onPreview(event: WechatMiniprogram.TouchEvent) {
    const id = z.string().parse(event.currentTarget.dataset.id);
    wx.previewImage({ current: this.data.photos.find(photo => photo.id === id)!.path, urls: this.data.photos.map(photo => photo.path) });
  },
  onTasks() { wx.navigateTo({ url: '/pages/image-jobs/image-jobs' }); },
  async onStart() {
    if (this.data.busy || !this.data.available || !this.data.pendingCount) return;
    this.setData({ busy: true, error: '' });
    for (const photo of this.data.photos.filter(photo => !photo.submitted)) {
      this.setData({ photos: this.data.photos.map(item => item.id === photo.id ? { ...item, locked: true, error: '' } : item) });
      try {
        const upload = this.uploads.get(photo.id) || { assetId: '', key: requestKey() };
        this.uploads.set(photo.id, upload);
        if (!upload.assetId) upload.assetId = (await uploadPhoto(this.scope, photo.path)).data.assetId;
        await startClothingImport(this.scope, upload.assetId, photo.mode, upload.key);
        this.setData({ photos: this.data.photos.map(item => item.id === photo.id ? { ...item, submitted: true } : item) });
        this.renderCounts();
      } catch (error) {
        const message = errorMessage(error);
        if (!message) return;
        this.setData({ photos: this.data.photos.map(item => item.id === photo.id ? { ...item, error: message } : item) });
      }
      if (!this.scope.active) return;
    }
    this.setData({ busy: false });
    this.renderCounts();
    if (!this.data.pendingCount) wx.reLaunch({ url: '/pages/wardrobe/wardrobe' });
  },
  renderCounts() {
    this.setData({ singleCount: this.data.photos.filter(photo => photo.mode === 'single').length, setCount: this.data.photos.filter(photo => photo.mode === 'set').length, pendingCount: this.data.photos.filter(photo => !photo.submitted).length });
    if (this.dirty === Boolean(this.data.pendingCount)) return;
    this.dirty = Boolean(this.data.pendingCount);
    if (this.dirty) { wx.enableAlertBeforeUnload({ message: '还有照片未提交识别，离开后需要重新选择' }); return; }
    wx.disableAlertBeforeUnload();
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await getCapabilities(this.scope);
      this.setData({ loading: false, available: result.data.imageProcessing.available, error: result.data.imageProcessing.available ? '' : result.data.imageProcessing.reason });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ loading: false, error: message }); }
  }
});
