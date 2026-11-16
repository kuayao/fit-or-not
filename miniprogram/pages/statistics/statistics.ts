import { refreshExpiredImage } from '../../utils/refresh-image';
import { getStatistics, listClothingStatistics, imageUrls } from '../../api/client';
import { z } from 'zod';
import { idSchema } from '../../api/contracts';
import { money } from '../../utils/format';
import { RequestScope, requireSession, errorMessage } from '../../utils/request';

Page({
  scope: new RequestScope(), generation: 0, page: 0,
  data: { mostWorn: false, all: false, total: 0, loading: false, error: '', totalCount: 0, pricedCount: 0, wornDays: 0, outfitCount: 0, totalPrice: '0.00', description: '',
    categories: Array<{ name: string; count: number; width: string }>(),
    clothes: Array<{ id: string; name: string; imageUrl: string; wearCount: number; lastWornOn: string | null; cost: string }>()
  },
  onLoad() { this.scope = new RequestScope(); if (requireSession()) void this.load(); },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => { this.setData({ clothes: this.data.clothes.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })) }); }, message => this.setData({ error: message }));
  },
  onUnload() { this.scope.close(); },
  onReachBottom() { if (!this.data.loading && this.data.clothes.length < this.data.total) void this.load(false); },
  onScope(event: WechatMiniprogram.TouchEvent) { const all = z.boolean().parse(event.currentTarget.dataset.value); if (all === this.data.all) return; this.setData({ all }); void this.load(); },
  onSort(event: WechatMiniprogram.TouchEvent) { const mostWorn = z.boolean().parse(event.currentTarget.dataset.value); if (mostWorn === this.data.mostWorn) return; this.setData({ mostWorn }); void this.load(); },
  onRetry() { void this.load(); },
  onClothing(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/clothing-detail/clothing-detail?id=${idSchema.parse(event.currentTarget.dataset.id)}` }); },
  async load(reset = true) {
    if (!reset && this.data.loading) return;
    const generation = reset ? ++this.generation : this.generation;
    const page = reset ? 1 : this.page + 1; this.setData({ loading: true, error: '' });
    try {
      const [result, details] = await Promise.all([getStatistics(this.scope, this.data.all), listClothingStatistics(this.scope, this.data.all, page, this.data.mostWorn ? 'most-worn' : 'least-worn')]);
      const urls = await imageUrls(this.scope, details.data.map(item => item.primaryAssetId), 'thumbnail');
      if (generation !== this.generation) return;
      this.page = page;
      this.setData({ total: details.pagination.total, totalCount: result.data.totalCount, pricedCount: result.data.pricedCount, wornDays: result.data.wornDays, outfitCount: result.data.outfitCount, totalPrice: money(result.data.totalPriceCents), description: result.data.description,
        categories: result.data.categories.map(item => ({ ...item, width: `${result.data.totalCount ? item.count / result.data.totalCount * 100 : 0}%` })),
        clothes: [...(reset ? [] : this.data.clothes), ...details.data.map(item => ({ id: item.id, name: item.name, imageUrl: urls[item.primaryAssetId], wearCount: item.wearCount, lastWornOn: item.lastWornOn, cost: item.priceCents === null ? '未填写价格' : item.wearCount === 0 ? '尚未穿着' : `${money(item.costPerWearCents)} 元 / 次` }))], loading: false });
    } catch (error) { const message = errorMessage(error); if (generation === this.generation && message) this.setData({ error: message, loading: false }); }
  }
});
