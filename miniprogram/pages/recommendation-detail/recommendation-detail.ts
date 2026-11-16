import { getRecommendationOutfit, imageUrls } from '../../api/client';
import { idSchema } from '../../api/contracts';
import type { RecommendationOutfit } from '../../api/contracts';
import { RequestScope, requireSession, errorMessage } from '../../utils/request';
import { refreshExpiredImage } from '../../utils/refresh-image';

Page({
  scope: new RequestScope(), id: '', outfitId: '',
  data: { loading: true, error: '', outfit: null as RecommendationOutfit | null, items: Array<RecommendationOutfit['items'][number] & { imageUrl: string }>() },
  onLoad(options) {
    this.scope = new RequestScope();
    if (!requireSession()) return;
    this.id = idSchema.parse(options.id); this.outfitId = idSchema.parse(options.outfitId);
    void this.load();
  },
  onUnload() { this.scope.close(); },
  onRetry() { if (!this.data.loading) void this.load(); },
  onClothing(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/clothing-detail/clothing-detail?id=${idSchema.parse(event.currentTarget.dataset.id)}` }); },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => this.setData({ items: this.data.items.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })) }), message => this.setData({ error: message }));
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await getRecommendationOutfit(this.scope, this.id, this.outfitId);
      const urls = await imageUrls(this.scope, result.data.items.map(item => item.primaryAssetId), 'thumbnail');
      if (!this.scope.active) return;
      this.setData({ outfit: result.data, loading: false, items: result.data.items.map(item => ({ ...item, imageUrl: urls[item.primaryAssetId] })) });
    } catch (error) {
      const message = errorMessage(error);
      if (this.scope.active && message) this.setData({ error: message, loading: false });
    }
  }
});
