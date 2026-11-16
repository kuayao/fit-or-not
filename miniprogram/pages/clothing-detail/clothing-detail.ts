import { refreshExpiredImage } from '../../utils/refresh-image';
import { idSchema, colorLabels, colors, seasonLabels, seasons, patterns, patternLabels } from '../../api/contracts';
import type { Clothing } from '../../api/contracts';
import { getClothing, updateClothing, deleteClothing, imageUrls } from '../../api/client';
import { ApiError, RequestScope, requireSession, errorMessage } from '../../utils/request';
import { money } from '../../utils/format';

const initialData: { clothing: Clothing | null; imageUrl: string; detailPhotos: { id: string; imageUrl: string }[]; cost: string; showMore: boolean; showInfo: boolean; price: string; colorText: string; seasonText: string; patternText: string; featuresText: string; setCoverUrl: string; setMembers: { id: string; name: string; imageUrl: string }[]; processing: boolean; loading: boolean; busy: boolean; error: string } = {
  clothing: null, imageUrl: '', detailPhotos: [], cost: '—', showMore: false, showInfo: false, price: '', colorText: '', seasonText: '', patternText: '', featuresText: '', setCoverUrl: '', setMembers: [], processing: false, loading: false, busy: false, error: ''
};
Page({
  scope: new RequestScope(), id: '', data: initialData,
  onLoad(options) { this.scope = new RequestScope(); if (!requireSession()) return; this.id = idSchema.parse(options.id); void this.load(); },
  onShow() { if (this.scope.hasShown && requireSession()) void this.load(); this.scope.hasShown = true; },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => { this.setData({ setCoverUrl: this.data.setCoverUrl === oldUrl ? url : this.data.setCoverUrl, setMembers: this.data.setMembers.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })), imageUrl: this.data.imageUrl === oldUrl ? url : this.data.imageUrl, detailPhotos: this.data.detailPhotos.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })) }); }, message => this.setData({ error: message }));
  },
  onUnload() { this.scope.close(); },
  onSet() { if (this.data.clothing?.setId) wx.navigateTo({ url: `/pages/clothing-set/clothing-set?id=${this.data.clothing.setId}` }); },
  onSetMember(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/clothing-detail/clothing-detail?id=${idSchema.parse(event.currentTarget.dataset.id)}` }); },
  onMore() { this.setData({ showMore: true }); },
  onCloseMore() { this.setData({ showMore: false }); },
  onInfo() { this.setData({ showInfo: true }); },
  onCloseInfo() { this.setData({ showInfo: false }); },
  onRetry() { void this.load(); },
  onEdit() { wx.navigateTo({ url: `/pages/clothing-edit/clothing-edit?id=${this.id}` }); },
  onWear() { this.setData({ showMore: false }); wx.navigateTo({ url: `/pages/wear-edit/wear-edit?clothingId=${this.id}` }); },
  async onPreview() {
    if (!this.data.clothing) return;
    try {
      const ids = [this.data.clothing.primaryAssetId, ...this.data.clothing.detailAssetIds];
      const urls = await imageUrls(this.scope, ids, 'original');
      wx.previewImage({ urls: ids.map(id => urls[id]) });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message }); }
  },
  async onFavorite() {
    if (this.data.busy || this.data.loading || this.data.processing || !this.data.clothing) return;
    this.setData({ busy: true, error: '' });
    try { const response = await updateClothing(this.scope, this.id, { version: this.data.clothing.version, favorite: !this.data.clothing.favorite }); this.setData({ clothing: response.data, busy: false }); }
    catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        await this.load();
        if (this.scope.active) this.setData({ busy: false, error: this.data.error || '衣物资料已更新，请确认后再次点击收藏' });
        return;
      }
      const message = errorMessage(error); if (message) this.setData({ error: message, busy: false });
    }
  },
  async onArchive() {
    if (this.data.busy || this.data.processing || !this.data.clothing) return;
    this.setData({ busy: true, error: '' });
    try { const response = await updateClothing(this.scope, this.id, { version: this.data.clothing.version, status: this.data.clothing.status === 'archived' ? 'active' : 'archived' }); this.setData({ clothing: response.data, busy: false, showMore: false }); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async onDelete() {
    if (this.data.busy || this.data.processing) return;
    const answer = await wx.showModal({ title: '永久删除这件衣物？', content: '被搭配、穿搭记录或清单引用的衣物需要先处理引用，也可以选择归档。', confirmText: '删除' });
    if (!answer.confirm || !this.scope.active) return;
    this.setData({ busy: true, error: '' });
    try { await deleteClothing(this.scope, this.id); wx.navigateBack(); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await getClothing(this.scope, this.id);
      const [urls, thumbnails] = await Promise.all([
        imageUrls(this.scope, [result.data.primaryAssetId]),
        imageUrls(this.scope, [...result.data.detailAssetIds, ...(result.data.clothingSet?.coverAssetId ? [result.data.clothingSet.coverAssetId] : []), ...(result.data.clothingSet?.members.map(item => item.primaryAssetId) || [])], 'thumbnail')
      ]);
      this.setData({ processing: result.data.processingStatus === 'queued' || result.data.processingStatus === 'running', patternText: result.data.pattern ? patternLabels[patterns.indexOf(result.data.pattern)] : '', featuresText: result.data.visibleFeatures.join('、') });
      this.setData({ setCoverUrl: result.data.clothingSet?.coverAssetId ? thumbnails[result.data.clothingSet.coverAssetId] : '', setMembers: result.data.clothingSet?.members.map(item => ({ id: item.id, name: item.name, imageUrl: thumbnails[item.primaryAssetId] })) || [], cost: result.data.priceCents !== null && result.data.wearCount ? `¥${money(((BigInt(result.data.priceCents) + BigInt(Math.floor(result.data.wearCount / 2))) / BigInt(result.data.wearCount)).toString())}` : '—', clothing: result.data, imageUrl: urls[result.data.primaryAssetId], detailPhotos: result.data.detailAssetIds.map(id => ({ id, imageUrl: thumbnails[id] })), price: money(result.data.priceCents), colorText: result.data.colors.map(value => colorLabels[colors.indexOf(value)]).join('、'), seasonText: result.data.seasons.map(value => seasonLabels[seasons.indexOf(value)]).join('、'), loading: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, loading: false }); }
  }
});
