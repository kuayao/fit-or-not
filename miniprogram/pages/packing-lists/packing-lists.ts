import { listPackingLists, createPackingList, getCapabilities } from '../../api/client';
import { z } from 'zod';
import { idSchema, packingInputSchema } from '../../api/contracts';
import type { DateRangeDetail } from '../../components/app-date-sheet/app-date-sheet';
import { RequestScope, requireSession, errorMessage } from '../../utils/request';
import { pendingPackingReminders, requestPackingSubscription } from '../../utils/packing-reminders';

Page({
  scope: new RequestScope(), page: 0, retryReset: true, listRequest: 0, reminderSubscriptions: 0,
  data: {
    lists: Array<{ id: string; name: string; dateLabel: string; count: number; packed: number; progress: string; ended: boolean; overdue: boolean }>(), tab: 'active',
    loading: false, busy: false, error: '', total: 0, creating: false, dateOpen: false, formError: '',
    draft: { name: '', startOn: '', endOn: '', departureTime: '07:00' },
    reminderAvailable: false, reminderTemplateId: ''
  },
  onLoad() { this.scope = new RequestScope(); if (requireSession()) void this.load(true); },
  onShow() { if (this.scope.hasShown && requireSession()) void this.load(true); this.scope.hasShown = true; },
  onUnload() { this.scope.close(); },
  onReachBottom() { if (!this.data.loading && !this.data.error && this.data.lists.length < this.data.total) void this.load(false); },
  onRetry() { void this.load(this.retryReset); },
  onTab(event: WechatMiniprogram.TouchEvent) {
    const tab = z.enum(['active', 'ended']).parse(event.currentTarget.dataset.tab);
    if (tab === this.data.tab) return;
    this.setData({ tab, lists: [], total: 0 });
    void this.load(true);
  },
  onOpen(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/packing-detail/packing-detail?id=${idSchema.parse(event.currentTarget.dataset.id)}` }); },
  onAdd() {
    this.reminderSubscriptions = 0;
    this.setData({ creating: true, formError: '', dateOpen: false, draft: { name: '', startOn: '', endOn: '', departureTime: '07:00' } });
  },
  onCloseCreate() { if (!this.data.busy) this.setData({ creating: false }); },
  onInput(event: WechatMiniprogram.Input) { this.setData({ 'draft.name': event.detail.value, formError: '' }); },
  onDepartureTimeInput(event: WechatMiniprogram.Input) { this.setData({ 'draft.departureTime': event.detail.value.replace('：', ':'), formError: '' }); },
  onOpenDate() {
    if (this.data.busy) return;
    this.setData({ dateOpen: true });
  },
  onCloseDate() { this.setData({ dateOpen: false }); },
  onDate(event: WechatMiniprogram.CustomEvent<DateRangeDetail>) {
    this.setData({ 'draft.startOn': event.detail.startOn, 'draft.endOn': event.detail.endOn, dateOpen: false, formError: '' });
  },
  onClearDates() { this.setData({ 'draft.startOn': '', 'draft.endOn': '', formError: '' }); },
  async onCreate() {
    if (this.data.busy) return;
    const input = packingInputSchema.safeParse({ name: this.data.draft.name, startOn: this.data.draft.startOn || null, endOn: this.data.draft.endOn || null, departureTime: this.data.draft.departureTime.trim() || null });
    if (!input.success) {
      this.setData({ formError: input.error.issues[0].path[0] === 'name' ? '请填写清单名称（1–60 个字）' : input.error.issues[0].message });
      return;
    }
    this.setData({ busy: true, formError: '' });
    try {
      if (this.data.reminderAvailable && !this.reminderSubscriptions && pendingPackingReminders(input.data.startOn || '') > 0) this.reminderSubscriptions += await requestPackingSubscription(this.data.reminderTemplateId);
      if (!this.scope.active) return;
      const result = await createPackingList(this.scope, { ...input.data, reminderSubscriptions: this.reminderSubscriptions });
      this.setData({ busy: false, creating: false });
      wx.navigateTo({ url: `/pages/packing-detail/packing-detail?id=${result.data.id}` });
    } catch (error) {
      const message = errorMessage(error);
      if (message) this.setData({ formError: message, busy: false });
    }
  },
  async load(reset: boolean) {
    if (this.data.loading && !reset) return;
    const request = ++this.listRequest;
    this.retryReset = reset;
    this.setData({ loading: true, error: '' });
    try {
      const page = reset ? 1 : this.page + 1;
      const [result, capabilities] = await Promise.all([listPackingLists(this.scope, page, this.data.tab), getCapabilities(this.scope)]);
      if (request !== this.listRequest) return;
      this.page = page;
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      this.setData({
        lists: [...(reset ? [] : this.data.lists), ...result.data.map(item => {
          const packed = item.items.filter(clothing => clothing.packed).length;
          return {
            id: item.id, name: item.name, count: item.items.length, packed, ended: Boolean(item.endedAt), overdue: Boolean(!item.endedAt && item.endOn && item.endOn < today),
            dateLabel: item.startOn ? `${item.startOn}${item.departureTime ? ` ${item.departureTime}` : ''}${item.endOn ? ` — ${item.endOn}` : ' 出发'}` : item.endOn ? `截至 ${item.endOn}` : '日期未定',
            progress: `${item.items.length ? packed / item.items.length * 100 : 0}%`
          };
        })], total: result.pagination.total, loading: false, reminderAvailable: capabilities.data.packingReminder.available, reminderTemplateId: capabilities.data.packingReminder.templateId
      });
    } catch (error) { const message = errorMessage(error); if (message && request === this.listRequest) this.setData({ error: message, loading: false }); }
  }
});
