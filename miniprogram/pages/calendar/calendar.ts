import { refreshExpiredImage } from '../../utils/refresh-image';
import { z } from 'zod';
import { listWearRecords, imageUrls } from '../../api/client';
import type { WearRecord } from '../../api/contracts';
import { idSchema, dateSchema } from '../../api/contracts';
import { currentDate } from '../../utils/format';
import { RequestScope, requireSession, errorMessage } from '../../utils/request';

Page({
  scope: new RequestScope(), generation: 0, records: Array<WearRecord>(),
  data: { month: currentDate().slice(0, 7), selectedDate: currentDate(), today: currentDate(), title: '', selectedLabel: '',
    days: Array<{ date: string; number: number; inMonth: boolean; hasRecord: boolean; isToday: boolean; selected: boolean }>(),
    records: Array<WearRecord & { images: { id: string; url: string }[] }>(), weekdays: ['一', '二', '三', '四', '五', '六', '日'], loading: false, error: '', canAdd: true
  },
  onLoad() { this.scope = new RequestScope(); if (requireSession()) void this.load(); },
  onShow() { this.getTabBar()?.setData({ selected: 2 }); if (this.scope.hasShown && requireSession()) void this.load(); this.scope.hasShown = true; },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => { this.setData({ records: this.data.records.map(item => ({ ...item, images: item.images.map(image => ({ ...image, url: image.url === oldUrl ? url : image.url })) })) }); }, message => this.setData({ error: message }));
  },
  onUnload() { this.scope.close(); },
  onMonth(event: WechatMiniprogram.TouchEvent) {
    const offset = z.coerce.number().pipe(z.union([z.literal(-1), z.literal(1)])).parse(event.currentTarget.dataset.offset);
    const parts = this.data.month.split('-').map(Number); const month = new Date(Date.UTC(parts[0], parts[1] - 1 + offset, 1)).toISOString().slice(0, 7);
    this.setData({ month, selectedDate: `${month}-01` }); void this.load();
  },
  onDate(event: WechatMiniprogram.TouchEvent) { const date = dateSchema.parse(event.currentTarget.dataset.date); if (!date.startsWith(this.data.month)) return; this.setData({ selectedDate: date }); void this.renderMonth(); },
  onToday() { this.setData({ month: currentDate().slice(0, 7), selectedDate: currentDate() }); void this.load(); },
  onAdd() { if (this.data.canAdd) wx.navigateTo({ url: `/pages/wear-edit/wear-edit?wornOn=${this.data.selectedDate}` }); },
  onEdit(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/wear-edit/wear-edit?id=${idSchema.parse(event.currentTarget.dataset.id)}&wornOn=${this.data.selectedDate}` }); },
  onRetry() { void this.load(); },
  async renderMonth() {
    const year = Number(this.data.month.slice(0, 4)); const month = Number(this.data.month.slice(5, 7));
    const first = new Date(Date.UTC(year, month - 1, 1)); const offset = (first.getUTCDay() + 6) % 7;
    const days = Array.from({ length: 42 }, (_, index) => {
      const date = new Date(first.getTime() + (index - offset) * 86400000).toISOString().slice(0, 10);
      return { date, number: Number(date.slice(8)), inMonth: date.startsWith(this.data.month), hasRecord: this.records.some(item => item.wornOn === date), isToday: date === this.data.today, selected: date === this.data.selectedDate };
    });
    const records = this.records.filter(item => item.wornOn === this.data.selectedDate);
    const selectedDate = this.data.selectedDate;
    try {
      const urls = await imageUrls(this.scope, records.flatMap(item => item.items.map(clothing => clothing.primaryAssetId)), 'thumbnail');
      if (selectedDate !== this.data.selectedDate) return;
      this.setData({ selectedLabel: `${Number(selectedDate.slice(5, 7))}月${Number(selectedDate.slice(8))}日`, title: `${year} 年 ${month} 月`, days, records: records.map(item => ({ ...item, images: item.items.map(clothing => ({ id: clothing.clothingId, url: urls[clothing.primaryAssetId] })) })), canAdd: selectedDate <= this.data.today });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message }); }
  },
  async load() {
    const generation = ++this.generation; this.setData({ loading: true, error: '' });
    try {
      const parts = this.data.month.split('-').map(Number); const end = new Date(Date.UTC(parts[0], parts[1], 0)).toISOString().slice(0, 10);
      const result = await listWearRecords(this.scope, `${this.data.month}-01`, end);
      if (generation !== this.generation) return;
      this.records = result.data; await this.renderMonth(); this.setData({ loading: false });
    } catch (error) { const message = errorMessage(error); if (generation === this.generation && message) this.setData({ error: message, loading: false }); }
  }
});
