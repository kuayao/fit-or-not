import { getRecommendations, imageUrls } from '../../api/client';
import { idSchema } from '../../api/contracts';
import type { Recommendation, RecommendationOutfit } from '../../api/contracts';
import { RequestScope, requireSession, errorMessage } from '../../utils/request';
import { refreshExpiredImage } from '../../utils/refresh-image';

type ItemView = Recommendation['items'][number] & { imageUrl: string };
type OutfitView = Omit<RecommendationOutfit, 'items'> & { items: ItemView[] };

Page({
  scope: new RequestScope(), generation: 0, cityCode: '',
  data: {
    ready: false, weatherReady: false, weatherLoading: true, loading: false, error: '', imageError: '',
    recommendation: null as Recommendation | null, items: Array<ItemView>(), outfits: Array<OutfitView>(),
    outfitIndex: 0, updatedLabel: ''
  },
  onLoad() { this.scope = new RequestScope(); if (requireSession()) this.setData({ ready: true }); },
  onShow() {
    this.getTabBar()?.setData({ selected: 0 });
    if (this.scope.active || !requireSession()) return;
    this.scope = new RequestScope();
    if (this.cityCode) void this.loadRecommendations();
  },
  onHide() { this.generation++; this.scope.close(); this.setData({ loading: false }); },
  onUnload() { this.generation++; this.scope.close(); },
  onWeatherLoadingChange(event: WechatMiniprogram.CustomEvent<{ loading: boolean }>) {
    this.setData({ weatherLoading: event.detail.loading });
  },
  onWeatherChange(event: WechatMiniprogram.CustomEvent<{ cityCode: string }>) {
    if (this.cityCode === event.detail.cityCode && this.data.loading) return;
    this.cityCode = event.detail.cityCode;
    this.setData({ weatherReady: true });
    void this.loadRecommendations();
  },
  onCityChange() {
    this.generation++; this.scope.close(); this.scope = new RequestScope(); this.cityCode = '';
    this.setData({ weatherReady: false, loading: false, error: '', imageError: '', recommendation: null, items: [], outfits: [], outfitIndex: 0, updatedLabel: '' });
  },
  onRetry() { if (!this.data.loading && this.cityCode) void this.loadRecommendations(); },
  onOutfitChange(event: WechatMiniprogram.SwiperChange) {
    if (event.detail.source !== 'touch') return;
    this.setData({ outfitIndex: event.detail.current });
  },
  onClothing(event: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/clothing-detail/clothing-detail?id=${idSchema.parse(event.currentTarget.dataset.id)}` });
  },
  onOutfit(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.recommendation) return;
    wx.navigateTo({ url: `/pages/recommendation-detail/recommendation-detail?id=${this.data.recommendation.id}&outfitId=${idSchema.parse(event.currentTarget.dataset.id)}` });
  },
  onAddClothing() { wx.navigateTo({ url: '/pages/clothing-import/clothing-import' }); },
  onImageError(event: WechatMiniprogram.ImageError) {
    const generation = this.generation;
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => {
      if (generation !== this.generation) return;
      const outfits = this.data.outfits.map(outfit => ({ ...outfit, items: outfit.items.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })) }));
      this.setData({ items: this.data.items.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })), outfits });
    }, message => { if (generation === this.generation) this.setData({ imageError: message }); });
  },
  async loadRecommendations() {
    this.scope.close(); this.scope = new RequestScope();
    const scope = this.scope;
    const generation = ++this.generation;
    this.setData({ loading: true, error: '', imageError: '' });
    try {
      const result = await getRecommendations(scope, this.cityCode);
      const urls = await imageUrls(scope, [...result.data.items, ...result.data.outfits.flatMap(outfit => outfit.items)].map(item => item.primaryAssetId), 'thumbnail');
      if (!scope.active || generation !== this.generation) return;
      const outfits = result.data.outfits.map(outfit => ({ ...outfit, items: outfit.items.map(item => ({ ...item, imageUrl: urls[item.primaryAssetId] })) }));
      this.setData({
        loading: false, recommendation: result.data, items: result.data.items.map(item => ({ ...item, imageUrl: urls[item.primaryAssetId] })),
        outfits, outfitIndex: 0,
        updatedLabel: `${result.data.date.replace(/-/g, '/')} ${new Date(result.data.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' })}`
      });
    } catch (error) {
      const message = errorMessage(error);
      if (scope.active && generation === this.generation && message) this.setData({ error: message, loading: false });
    }
  }
});
