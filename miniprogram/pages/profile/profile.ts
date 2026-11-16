import { refreshExpiredImage } from '../../utils/refresh-image';
import { z } from 'zod';
import { getMe, imageUrls, getStatistics } from '../../api/client';
import { RequestScope, requireSession, errorMessage } from '../../utils/request';

Page({
  scope: new RequestScope(),
  data: { nickname: '', avatarUrl: '', totalCount: 0, outfitCount: 0, wornDays: 0, loading: false, error: '', links: [
    { page: 'statistics', label: '衣橱统计', icon: 'chart' }, { page: 'packing-lists', label: '出行清单', icon: 'suitcase' },
    { page: 'taxonomy', label: '分类与标签', icon: 'tag' }, { page: 'recommendations', label: '智能搭配', icon: 'sparkles' },
    { page: 'try-on', label: '虚拟试穿', icon: 'wand' }, { page: 'image-jobs', label: '图片处理任务', icon: 'clock' },
    { page: 'settings', label: '设置与数据', icon: 'settings' }
  ] },
  onLoad() { this.scope = new RequestScope(); if (requireSession()) void this.load(); },
  onShow() { this.getTabBar()?.setData({ selected: 3 }); if (this.scope.hasShown && requireSession()) void this.load(); this.scope.hasShown = true; },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => { if (this.data.avatarUrl === oldUrl) this.setData({ avatarUrl: url }); }, message => this.setData({ error: message }));
  },
  onUnload() { this.scope.close(); },
  onRetry() { void this.load(); },
  onArchive() { wx.reLaunch({ url: '/pages/wardrobe/wardrobe?status=archived' }); },
  onOpen(event: WechatMiniprogram.TouchEvent) { const page = z.enum(['statistics', 'packing-lists', 'taxonomy', 'image-jobs', 'recommendations', 'try-on', 'settings']).parse(event.currentTarget.dataset.page); wx.navigateTo({ url: `/pages/${page}/${page}` }); },
  onEditProfile() { wx.navigateTo({ url: '/pages/profile-edit/profile-edit' }); },
  async load() {
    this.setData({ loading: true, error: '' });
    try { const [result, stats] = await Promise.all([getMe(this.scope), getStatistics(this.scope, false)]); const urls = result.data.avatarAssetId ? await imageUrls(this.scope, [result.data.avatarAssetId], 'thumbnail') : {}; this.setData({ nickname: result.data.nickname, avatarUrl: result.data.avatarAssetId ? urls[result.data.avatarAssetId] : '', totalCount: stats.data.totalCount, outfitCount: stats.data.outfitCount, wornDays: stats.data.wornDays, loading: false }); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, loading: false }); }
  }
});
