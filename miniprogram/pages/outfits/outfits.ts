import { z } from 'zod';
import { listOutfits, listOutfitCategories, createOutfitCategory, listWearRecords, imageUrls } from '../../api/client';
import { idSchema, dateSchema } from '../../api/contracts';
import type { OutfitCategory, WearRecord } from '../../api/contracts';
import { currentDate } from '../../utils/format';
import { refreshExpiredImage } from '../../utils/refresh-image';
import { RequestScope, requireSession, errorMessage } from '../../utils/request';

type OutfitCard = { id: string; name: string; categoryName: string | null; itemCount: number; backgroundColor: string; imageUrl: string; layers: { clothingId: string; imageUrl: string; style: string }[] };
type CalendarDay = { date: string; number: number; inMonth: boolean; selected: boolean; isToday: boolean; hasRecord: boolean; imageUrl: string };

Page({
  scope: new RequestScope(), page: 0, generation: 0, calendarGeneration: 0, categoryGeneration: 0, retryReset: true, searchQuery: '',
  wearRecords: Array<WearRecord>(), calendarUrls: new Map<string, string>(),
  data: {
    activeTab: 'wear',
    outfits: Array<OutfitCard>(), q: '', searchOpen: false, categoryId: '', categories: Array<OutfitCategory>(),
    categoriesLoading: false, categoriesError: '', categoryBusy: false, categoryCreateError: '',
    favorite: false, loading: false, error: '', imageError: '', total: 0,
    month: currentDate().slice(0, 7), selectedDate: currentDate(), today: currentDate(), expanded: false,
    calendarTitle: '本周穿搭', selectedLabel: '今天', selectedWeekday: '', canAdd: true,
    days: Array<CalendarDay>(), weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    records: Array<{ id: string; title: string; notes: string; itemCount: number; images: { id: string; url: string }[] }>(),
    calendarLoading: false, calendarLoaded: false, calendarError: '', showCreate: false
  },
  onLoad() {
    this.scope = new RequestScope(); this.calendarUrls = new Map<string, string>();
    if (!requireSession()) return;
    this.renderCalendar(); void this.load(true); void this.loadCalendar(); void this.loadCategories();
  },
  onShow() {
    this.getTabBar()?.setData({ selected: 2 });
    if (this.scope.hasShown && requireSession()) {
      this.setData({ today: currentDate() });
      void this.load(true); void this.loadCalendar(); void this.loadCategories();
    }
    this.scope.hasShown = true;
  },
  onUnload() { this.scope.close(); },
  onReachBottom() { if (this.data.activeTab === 'outfits' && !this.data.loading && this.data.outfits.length < this.data.total) void this.load(false); },
  onTab(event: WechatMiniprogram.TouchEvent) {
    const activeTab = z.enum(['wear', 'outfits']).parse(event.currentTarget.dataset.tab);
    if (activeTab === this.data.activeTab) return;
    this.setData({ activeTab });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => {
      for (const [id, value] of this.calendarUrls) if (value === oldUrl) this.calendarUrls.set(id, url);
      this.setData({ outfits: this.data.outfits.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl, layers: item.layers.map(layer => ({ ...layer, imageUrl: layer.imageUrl === oldUrl ? url : layer.imageUrl })) })) });
      this.renderCalendar();
    }, message => this.setData({ imageError: message }));
  },
  onSearchToggle() {
    this.setData({ searchOpen: !this.data.searchOpen });
    if (this.data.searchOpen) return;
    const hadSearch = Boolean(this.searchQuery);
    this.searchQuery = ''; this.setData({ q: '' });
    if (hadSearch) { this.setData({ outfits: [], total: 0 }); void this.load(true); }
  },
  onInput(event: WechatMiniprogram.Input) { this.setData({ q: event.detail.value }); },
  onSearch() { this.searchQuery = this.data.q; this.setData({ outfits: [], total: 0 }); void this.load(true); },
  onRetryOutfits() { void this.load(this.retryReset); },
  onFavorite() { this.setData({ favorite: !this.data.favorite, outfits: [], total: 0 }); void this.load(true); },
  onCategory(event: WechatMiniprogram.CustomEvent<{ id: string }>) { this.setData({ categoryId: event.detail.id, outfits: [], total: 0 }); void this.load(true); },
  onRetryCategories() { void this.loadCategories(); },
  async onCreateCategory(event: WechatMiniprogram.CustomEvent<{ name: string }>) {
    if (this.data.categoryBusy) return;
    this.setData({ categoryBusy: true, categoryCreateError: '' });
    try {
      const result = await createOutfitCategory(this.scope, event.detail.name);
      this.setData({ categories: [...this.data.categories, result.data], categoryId: result.data.id, categoryBusy: false, outfits: [], total: 0 });
      void this.load(true);
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ categoryCreateError: message, categoryBusy: false }); }
  },
  onExpandCalendar() {
    const expanded = !this.data.expanded;
    const today = currentDate();
    this.setData({
      expanded, today, calendarLoaded: false,
      selectedDate: expanded ? this.data.selectedDate : today,
      month: expanded ? this.data.month : today.slice(0, 7)
    });
    this.renderCalendar(); void this.loadCalendar();
  },
  onDate(event: WechatMiniprogram.TouchEvent) {
    const date = dateSchema.parse(event.currentTarget.dataset.date);
    if (this.data.expanded && !date.startsWith(this.data.month)) return;
    this.setData({ selectedDate: date, month: date.slice(0, 7) }); this.renderCalendar();
  },
  onMonth(event: WechatMiniprogram.TouchEvent) {
    const offset = z.coerce.number().pipe(z.union([z.literal(-1), z.literal(1)])).parse(event.currentTarget.dataset.offset);
    const month = new Date(Date.UTC(Number(this.data.month.slice(0, 4)), Number(this.data.month.slice(5)) - 1 + offset, 1)).toISOString().slice(0, 7);
    this.setData({ month, selectedDate: `${month}-01`, calendarLoaded: false }); this.renderCalendar(); void this.loadCalendar();
  },
  onWeek(event: WechatMiniprogram.TouchEvent) {
    const offset = z.coerce.number().pipe(z.union([z.literal(-1), z.literal(1)])).parse(event.currentTarget.dataset.offset);
    const date = new Date(`${this.data.selectedDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset * 7);
    this.setData({ selectedDate: date.toISOString().slice(0, 10), month: date.toISOString().slice(0, 7), calendarLoaded: false });
    this.renderCalendar(); void this.loadCalendar();
  },
  onToday() {
    this.setData({ selectedDate: currentDate(), month: currentDate().slice(0, 7), today: currentDate(), calendarLoaded: false });
    this.renderCalendar(); void this.loadCalendar();
  },
  onRetryCalendar() { void this.loadCalendar(); },
  onAddRecord() { if (this.data.canAdd) wx.navigateTo({ url: `/pages/wear-edit/wear-edit?wornOn=${this.data.selectedDate}` }); },
  onEditRecord(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/wear-edit/wear-edit?id=${idSchema.parse(event.currentTarget.dataset.id)}&wornOn=${this.data.selectedDate}` }); },
  onAdd() { this.setData({ showCreate: true }); },
  onCloseCreate() { this.setData({ showCreate: false }); },
  onManualCreate() { this.setData({ showCreate: false }); wx.navigateTo({ url: `/pages/outfit-edit/outfit-edit${this.data.categoryId ? `?categoryId=${this.data.categoryId}` : ''}` }); },
  onRecommend() { this.setData({ showCreate: false }); wx.navigateTo({ url: '/pages/recommendations/recommendations' }); },
  onOpen(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/outfit-detail/outfit-detail?id=${idSchema.parse(event.currentTarget.dataset.id)}` }); },
  renderCalendar() {
    const selected = new Date(`${this.data.selectedDate}T00:00:00Z`);
    const first = this.data.expanded ? new Date(`${this.data.month}-01T00:00:00Z`) : new Date(selected);
    const offset = (first.getUTCDay() + 6) % 7;
    const monthDays = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const days = Array.from({ length: this.data.expanded ? Math.ceil((offset + monthDays) / 7) * 7 : 7 }, (_, index) => {
      const date = new Date(first.getTime() + (index - offset) * 86400000).toISOString().slice(0, 10);
      const record = this.wearRecords.find(item => item.wornOn === date);
      return { date, number: Number(date.slice(8)), inMonth: !this.data.expanded || date.startsWith(this.data.month), selected: date === this.data.selectedDate, isToday: date === this.data.today, hasRecord: Boolean(record), imageUrl: record ? this.calendarUrls.get(record.items[0].primaryAssetId) || '' : '' };
    });
    this.setData({
      days, calendarTitle: this.data.expanded ? `${first.getUTCFullYear()}年${first.getUTCMonth() + 1}月` : '本周穿搭',
      selectedLabel: this.data.selectedDate === this.data.today ? '今天' : `${selected.getUTCMonth() + 1}月${selected.getUTCDate()}日`,
      selectedWeekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][selected.getUTCDay()], canAdd: this.data.selectedDate <= this.data.today,
      records: this.wearRecords.filter(item => item.wornOn === this.data.selectedDate).map(item => ({ id: item.id, title: item.occasion || '日常穿搭', notes: item.notes, itemCount: item.items.length, images: item.items.slice(0, 4).map(clothing => ({ id: clothing.clothingId, url: this.calendarUrls.get(clothing.primaryAssetId) || '' })) }))
    });
  },
  async loadCalendar() {
    const generation = ++this.calendarGeneration;
    this.setData({ calendarLoading: true, calendarError: '' });
    const first = this.data.expanded ? `${this.data.month}-01` : this.data.days[0].date;
    const end = this.data.expanded ? new Date(Date.UTC(Number(this.data.month.slice(0, 4)), Number(this.data.month.slice(5)), 0)).toISOString().slice(0, 10) : this.data.days[6].date;
    try {
      const result = await listWearRecords(this.scope, first, end);
      const urls = await imageUrls(this.scope, result.data.flatMap(record => record.items.map(item => item.primaryAssetId)), 'thumbnail');
      if (generation !== this.calendarGeneration || !this.scope.active) return;
      this.wearRecords = result.data; this.calendarUrls = new Map(Object.entries(urls));
      this.renderCalendar(); this.setData({ calendarLoading: false, calendarLoaded: true });
    } catch (error) { const message = errorMessage(error); if (generation === this.calendarGeneration && message) this.setData({ calendarError: message, calendarLoading: false }); }
  },
  async loadCategories() {
    const generation = ++this.categoryGeneration;
    this.setData({ categoriesLoading: true, categoriesError: '' });
    try {
      const result = await listOutfitCategories(this.scope);
      if (generation !== this.categoryGeneration || !this.scope.active) return;
      this.setData({ categories: result.data, categoriesLoading: false });
    } catch (error) { const message = errorMessage(error); if (generation === this.categoryGeneration && message) this.setData({ categoriesError: message, categoriesLoading: false }); }
  },
  async load(reset: boolean) {
    if (!reset && this.data.loading) return;
    const generation = reset ? ++this.generation : this.generation;
    const page = reset ? 1 : this.page + 1;
    this.retryReset = reset;
    this.setData({ loading: true, error: '' });
    try {
      const result = await listOutfits(this.scope, { q: this.searchQuery, categoryId: this.data.categoryId || undefined, favorite: this.data.favorite ? true : undefined, page });
      const urls = await imageUrls(this.scope, result.data.flatMap(item => item.coverAssetId ? [item.coverAssetId] : item.previewAssets.map(asset => asset.assetId)), 'thumbnail');
      if (generation !== this.generation || !this.scope.active) return;
      this.page = page;
      this.setData({ outfits: [...(reset ? [] : this.data.outfits), ...result.data.map(item => ({ id: item.id, name: item.name, categoryName: item.categoryName, itemCount: item.items.length, backgroundColor: item.backgroundColor,
        imageUrl: item.coverAssetId ? urls[item.coverAssetId] : '', layers: item.coverAssetId ? [] : item.items.map(layer => ({ clothingId: layer.clothingId, imageUrl: urls[item.previewAssets.find(asset => asset.clothingId === layer.clothingId)!.assetId], style: `left:${layer.x * 100}%;top:${layer.y * 100}%;width:${layer.width * 100}%;height:${layer.height * 100}%;transform:rotate(${layer.rotation}deg);z-index:${layer.zIndex};` })) }))], total: result.pagination.total, loading: false });
    } catch (error) { const message = errorMessage(error); if (generation === this.generation && message) this.setData({ error: message, loading: false }); }
  }
});
