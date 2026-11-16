import { refreshExpiredImage } from '../../utils/refresh-image';
import { getOutfit, getClothing, imageUrls, updateOutfit, deleteOutfit, listOutfitCategories, createOutfitCategory } from '../../api/client';
import { idSchema } from '../../api/contracts';
import type { Outfit, Clothing, OutfitCategory } from '../../api/contracts';
import { RequestScope, requireSession, errorMessage } from '../../utils/request';

const initialData: { outfit: Outfit | null; coverUrl: string; layers: { clothingId: string; imageUrl: string; style: string }[]; clothes: (Clothing & { imageUrl: string })[]; loading: boolean; busy: boolean; error: string; showMore: boolean } = {
  outfit: null, coverUrl: '', layers: [], clothes: [], loading: false, busy: false, error: '', showMore: false
};
Page({
  scope: new RequestScope(), id: '', data: { ...initialData, categories: Array<OutfitCategory>(), categoryId: '', categoriesLoading: false, categoriesError: '', categoryBusy: false, categoryCreateError: '' },
  onLoad(options) { this.scope = new RequestScope(); if (!requireSession()) return; this.id = idSchema.parse(options.id); void this.load(); void this.loadCategories(); },
  onShow() { if (this.scope.hasShown && requireSession()) void this.load(); this.scope.hasShown = true; },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => { this.setData({ coverUrl: this.data.coverUrl === oldUrl ? url : this.data.coverUrl, clothes: this.data.clothes.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })), layers: this.data.layers.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })) }); }, message => this.setData({ error: message }));
  },
  onUnload() { this.scope.close(); },
  onMore() { this.setData({ showMore: true }); },
  onCloseMore() { this.setData({ showMore: false }); },
  onRetry() { void this.load(); },
  onEdit() { wx.navigateTo({ url: `/pages/outfit-edit/outfit-edit?id=${this.id}` }); },
  onWear() { wx.navigateTo({ url: `/pages/wear-edit/wear-edit?outfitId=${this.id}` }); },
  onTryOn() { this.setData({ showMore: false }); wx.navigateTo({ url: `/pages/try-on/try-on?outfitId=${this.id}` }); },
  onClothing(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/clothing-detail/clothing-detail?id=${idSchema.parse(event.currentTarget.dataset.id)}` }); },
  onRetryCategories() { void this.loadCategories(); },
  async onCategory(event: WechatMiniprogram.CustomEvent<{ id: string }>) {
    if (this.data.busy || this.data.categoryBusy || !this.data.outfit) return;
    this.setData({ busy: true, categoriesError: '' });
    try {
      const result = await updateOutfit(this.scope, this.id, { version: this.data.outfit.version, categoryId: event.detail.id || null });
      this.setData({ outfit: result.data, categoryId: result.data.categoryId || '', busy: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ categoriesError: message, busy: false }); }
  },
  async onCreateCategory(event: WechatMiniprogram.CustomEvent<{ name: string }>) {
    if (this.data.busy || this.data.categoryBusy || !this.data.outfit) return;
    this.setData({ categoryBusy: true, categoryCreateError: '' });
    try {
      const category = await createOutfitCategory(this.scope, event.detail.name);
      this.setData({ categories: [...this.data.categories, category.data] });
      const result = await updateOutfit(this.scope, this.id, { version: this.data.outfit.version, categoryId: category.data.id });
      this.setData({ outfit: result.data, categoryId: category.data.id, categoryBusy: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ categoryCreateError: message, categoryBusy: false }); }
  },
  async onFavorite() {
    if (this.data.busy || !this.data.outfit) return; this.setData({ busy: true, error: '' });
    try { const result = await updateOutfit(this.scope, this.id, { version: this.data.outfit.version, favorite: !this.data.outfit.favorite }); this.setData({ outfit: result.data, busy: false }); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async onExport() {
    if (this.data.busy || !this.data.outfit) return;
    if (!this.data.outfit.coverAssetId) { this.setData({ error: '封面尚未生成，请稍后刷新再导出' }); return; }
    this.setData({ busy: true, error: '' });
    try {
      const urls = await imageUrls(this.scope, [this.data.outfit.coverAssetId], 'original');
      const file = await new Promise<WechatMiniprogram.DownloadFileSuccessCallbackResult>((resolve, reject) => wx.downloadFile({ url: urls[this.data.outfit!.coverAssetId!], success: resolve, fail: reject }));
      if (file.statusCode !== 200) throw new Error('download failed');
      await wx.saveImageToPhotosAlbum({ filePath: file.tempFilePath });
      if (!this.scope.active) return;
      this.setData({ busy: false }); wx.showToast({ title: '已保存到相册', icon: 'none' });
    } catch (error) { const message = errorMessage(error); if (message && this.scope.active) this.setData({ error: message, busy: false }); }
  },
  async onDelete() {
    if (this.data.busy) return;
    const answer = await wx.showModal({ title: '删除这套搭配？', content: '已有穿搭记录会保留当时的单品快照。', confirmText: '删除' });
    if (!answer.confirm || !this.scope.active) return;
    this.setData({ busy: true, error: '' });
    try { await deleteOutfit(this.scope, this.id); wx.navigateBack(); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async loadCategories() {
    this.setData({ categoriesLoading: true, categoriesError: '' });
    try {
      const result = await listOutfitCategories(this.scope);
      this.setData({ categories: result.data, categoriesLoading: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ categoriesError: message, categoriesLoading: false }); }
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await getOutfit(this.scope, this.id);
      const clothes = await Promise.all(result.data.items.map(item => getClothing(this.scope, item.clothingId)));
      const [urls, thumbnails] = await Promise.all([
        imageUrls(this.scope, result.data.coverAssetId ? [result.data.coverAssetId] : clothes.map(item => item.data.primaryAssetId)),
        imageUrls(this.scope, clothes.map(item => item.data.primaryAssetId), 'thumbnail')
      ]);
      this.setData({ outfit: result.data, categoryId: result.data.categoryId || '', coverUrl: result.data.coverAssetId ? urls[result.data.coverAssetId] : '', clothes: clothes.map(item => ({ ...item.data, imageUrl: thumbnails[item.data.primaryAssetId] })),
        layers: result.data.coverAssetId ? [] : result.data.items.map(item => ({ clothingId: item.clothingId, imageUrl: urls[clothes.find(clothing => clothing.data.id === item.clothingId)!.data.primaryAssetId], style: `left:${item.x * 100}%;top:${item.y * 100}%;width:${item.width * 100}%;height:${item.height * 100}%;transform:rotate(${item.rotation}deg);z-index:${item.zIndex};` })), loading: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, loading: false }); }
  }
});
