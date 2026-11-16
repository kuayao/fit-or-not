import { refreshExpiredImage } from '../../utils/refresh-image';
import { z } from 'zod';
import { getPackingList, updatePackingList, copyPackingList, deletePackingList, listClothes, listCategories, getClothing, listOutfits, listClothingSets, imageUrls, getCapabilities, setPackingStatus } from '../../api/client';
import { idSchema, packingPatchSchema } from '../../api/contracts';
import type { Category, PackingList } from '../../api/contracts';
import type { DateRangeDetail } from '../../components/app-date-sheet/app-date-sheet';
import { RequestScope, requireSession, errorMessage } from '../../utils/request';
import { pendingPackingReminders, requestPackingSubscription } from '../../utils/packing-reminders';

type ClothingChoice = { id: string; name: string; primaryAssetId: string; imageUrl: string; selected: boolean; included: boolean };
type PackingItem = PackingList['items'][number] & { imageUrl: string };
type PackingGroup = { id: string; name: string; total: number; packedCount: number; collapsed: boolean; items: PackingItem[] };

Page({
  scope: new RequestScope(), id: '', version: 0, page: 0, outfitPage: 0, setPage: 0, setRequest: 0, setSearch: '', choiceRequest: 0, choiceQuery: '', reminderSubscriptions: 0,
  categories: Array<Category>(),
  collapsedGroupIds: new Set<string>(),
  data: { dateLabel: '', progress: '0%', dateOpen: false, sheet: '', sheetTitle: '', addTab: 'clothes', loadingChoices: false, draft: { name: '', startOn: '', endOn: '', departureTime: '' }, editItems: Array<{ clothingId: string; name: string; imageUrl: string; status: string; packed: boolean }>(), name: '', startOn: '', endOn: '', departureTime: '', loading: false, busy: false, error: '', total: 0, packedCount: 0,
    items: Array<PackingItem>(), groups: Array<PackingGroup>(), packingFilter: 'all', removingId: '',
    endedAt: '', overdue: false, reminders: Array<PackingList['reminders'][number]>(), reminderAvailable: false, reminderTemplateId: '',
    choices: Array<ClothingChoice>(), selectedChoices: Array<ClothingChoice>(), choicesTotal: 0,
    query: '', rootCategoryId: '', categoryId: '', favoriteOnly: false, selectedOnly: false, choiceError: '',
    rootCategories: Array<Category>(), subCategories: Array<Category>(), taxonomyLoading: false, taxonomyLoaded: false, taxonomyError: '', addingGroup: '',
    outfits: Array<{ id: string; name: string; clothingIds: string[] }>(), loadingOutfits: false, outfitsTotal: 0, outfitError: '',
    sets: Array<{ id: string; name: string; clothingIds: string[]; previews: { id: string; url: string }[]; members: { id: string; name: string; included: boolean; selected: boolean }[]; remainingCount: number }>(), setQuery: '', setsTotal: 0, loadingSets: false, setError: ''
  },
  onLoad(options) { this.scope = new RequestScope(); this.collapsedGroupIds = new Set(); if (!requireSession()) return; this.id = idSchema.parse(options.id); void this.load(); },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => {
      const items = this.data.items.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl }));
      this.setData({ items, groups: this.groupItems(items, this.data.packingFilter), editItems: this.data.editItems.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })), choices: this.data.choices.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })), selectedChoices: this.data.selectedChoices.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })), sets: this.data.sets.map(item => ({ ...item, previews: item.previews.map(preview => ({ ...preview, url: preview.url === oldUrl ? url : preview.url })) })) });
    }, message => this.setData({ error: message }));
  },
  onUnload() { this.scope.close(); },
  onMore() { this.setData({ sheet: 'manage', sheetTitle: '管理出行清单' }); },
  async onChangeStatus() {
    if (this.data.busy || this.data.loading) return;
    this.setData({ busy: true, error: '' });
    try {
      const result = await setPackingStatus(this.scope, this.id, { version: this.version, ended: !this.data.endedAt });
      this.applyTripState(result.data);
      this.setData({ busy: false, sheet: '' });
    } catch (error) {
      const message = errorMessage(error);
      if (message) this.setData({ error: message, busy: false });
    }
  },
  onCloseSheet() {
    if (this.data.busy || this.data.addingGroup) return;
    this.choiceRequest++;
    this.setRequest++;
    this.reminderSubscriptions = 0;
    this.setData({ sheet: '', loadingChoices: false, loadingSets: false, error: '' });
  },
  onEditList() { this.reminderSubscriptions = 0; this.setData({ sheet: 'edit', sheetTitle: '编辑清单', draft: { name: this.data.name, startOn: this.data.startOn, endOn: this.data.endOn, departureTime: this.data.departureTime }, editItems: this.data.items.map(item => ({ ...item })) }); },
  onInput(event: WechatMiniprogram.Input) { this.setData({ 'draft.name': event.detail.value }); },
  onDepartureTimeInput(event: WechatMiniprogram.Input) { this.setData({ 'draft.departureTime': event.detail.value.replace('：', ':') }); },
  onOpenDate() {
    if (this.data.busy) return;
    this.setData({ dateOpen: true });
  },
  onCloseDate() { this.setData({ dateOpen: false }); },
  onDate(event: WechatMiniprogram.CustomEvent<DateRangeDetail>) {
    this.setData({ 'draft.startOn': event.detail.startOn, 'draft.endOn': event.detail.endOn, dateOpen: false });
  },
  onClearDates() { this.setData({ 'draft.startOn': '', 'draft.endOn': '' }); },
  onRetry() { void this.load(); },
  onPackingFilter(event: WechatMiniprogram.TouchEvent) {
    const packingFilter = z.enum(['all', 'unpacked', 'packed']).parse(event.currentTarget.dataset.filter);
    this.setData({ packingFilter, groups: this.groupItems(this.data.items, packingFilter) });
  },
  onToggleGroup(event: WechatMiniprogram.TouchEvent) {
    const id = z.union([idSchema, z.literal('uncategorized')]).parse(event.currentTarget.dataset.id);
    this.collapsedGroupIds.has(id) ? this.collapsedGroupIds.delete(id) : this.collapsedGroupIds.add(id);
    this.setData({ groups: this.groupItems(this.data.items, this.data.packingFilter) });
  },
  async onChoose() {
    if (this.data.busy || this.data.endedAt) return;
    this.setPage = 0;
    this.setRequest++;
    this.setData({ sets: [], setsTotal: 0, loadingSets: false, setError: '', sheet: 'add', sheetTitle: '添加到清单', addTab: 'clothes', selectedChoices: [], selectedOnly: false, error: '' });
    await Promise.all([this.loadChoices(true), this.data.taxonomyLoaded ? Promise.resolve() : this.loadCategories()]);
  },
  async onAddTab(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.addingGroup) return;
    const addTab = z.enum(['clothes', 'outfits', 'sets']).parse(event.currentTarget.dataset.tab);
    this.setData({ addTab });
    if (addTab === 'outfits' && !this.outfitPage) await this.loadOutfits();
    if (addTab === 'sets' && !this.setPage) await this.loadSets(true);
  },
  onSearchInput(event: WechatMiniprogram.Input) { this.setData({ query: event.detail.value }); },
  onSearch() { this.setData({ selectedOnly: false }); void this.loadChoices(true); },
  onClearSearch() { this.setData({ query: '', selectedOnly: false }); void this.loadChoices(true); },
  onRootCategory(event: WechatMiniprogram.TouchEvent) {
    const id = z.union([idSchema, z.literal('')]).parse(event.currentTarget.dataset.id);
    this.setData({ rootCategoryId: id, categoryId: id, selectedOnly: false, subCategories: this.categories.filter(item => item.parentId === id) });
    void this.loadChoices(true);
  },
  onSubCategory(event: WechatMiniprogram.TouchEvent) {
    this.setData({ categoryId: idSchema.parse(event.currentTarget.dataset.id), selectedOnly: false });
    void this.loadChoices(true);
  },
  onFavorite() {
    this.setData({ favoriteOnly: !this.data.favoriteOnly, selectedOnly: false });
    void this.loadChoices(true);
  },
  onSelectedOnly() { this.setData({ selectedOnly: !this.data.selectedOnly }); },
  onMoreChoices() {
    if (!this.data.selectedOnly && !this.data.choiceError && this.data.choices.length < this.data.choicesTotal) void this.loadChoices(false);
  },
  onRetryChoices() { void this.loadChoices(this.page === 0); },
  onRetryCategories() { void this.loadCategories(); },
  onMoreOutfits() { void this.loadOutfits(); },
  onSetSearchInput(event: WechatMiniprogram.Input) { this.setData({ setQuery: event.detail.value }); },
  async onSetSearch() { await this.loadSets(true); },
  async onClearSetSearch() { this.setData({ setQuery: '' }); await this.loadSets(true); },
  async onMoreSets() {
    if (!this.data.loadingSets && !this.data.setError && this.data.sets.length < this.data.setsTotal) await this.loadSets(false);
  },
  async onRetrySets() { await this.loadSets(this.setPage === 0); },
  async onAddGroup(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.addingGroup) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    const source = z.enum(['sets', 'outfits']).parse(event.currentTarget.dataset.source);
    const group = (source === 'sets' ? this.data.sets : this.data.outfits).find(item => item.id === id)!;
    const ids = group.clothingIds.filter(id => !this.data.items.some(item => item.clothingId === id) && !this.data.selectedChoices.some(item => item.id === id));
    if (!ids.length) { wx.showToast({ title: '衣物已全部选入', icon: 'none' }); return; }
    if (this.data.items.length + this.data.selectedChoices.length + ids.length > 100) { this.setData({ error: '每份清单最多添加 100 件衣物' }); return; }
    this.setData({ addingGroup: id, error: '' });
    try {
      const clothes = await Promise.all(ids.map(id => getClothing(this.scope, id)));
      const urls = await imageUrls(this.scope, clothes.map(item => item.data.primaryAssetId), 'thumbnail');
      if (clothes.some(item => item.data.status !== 'active')) {
        this.setData({ addingGroup: '', error: `${source === 'sets' ? '套装' : '搭配'}中有衣物已归档或未入橱，请先调整${source === 'sets' ? '套装' : '搭配'}` });
        return;
      }
      const selectedChoices = [...this.data.selectedChoices, ...clothes.map(({ data }) => ({ id: data.id, name: data.name, primaryAssetId: data.primaryAssetId, imageUrl: urls[data.primaryAssetId], selected: true, included: false }))];
      this.updateSelection(selectedChoices);
      this.setData({ addingGroup: '' });
      wx.showToast({ title: `已选入 ${ids.length} 件衣物`, icon: 'none' });
    } catch (error) {
      const message = errorMessage(error);
      if (message) this.setData({ error: message, addingGroup: '' });
    }
  },
  onSelect(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.addingGroup) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    if (this.data.items.some(item => item.clothingId === id)) return;
    const selected = this.data.selectedChoices.some(item => item.id === id);
    if (!selected && this.data.items.length + this.data.selectedChoices.length >= 100) { this.setData({ error: '每份清单最多添加 100 件衣物' }); return; }
    const selectedChoices = selected ? this.data.selectedChoices.filter(item => item.id !== id) : [...this.data.selectedChoices, { ...this.data.choices.find(item => item.id === id)!, selected: true }];
    this.updateSelection(selectedChoices);
  },
  async onToggle(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.loading || this.data.endedAt) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    const packed = this.data.items.find(item => item.clothingId === id)!.packed;
    this.setData({ busy: true });
    this.updatePacked(id, !packed);
    try {
      const result = await updatePackingList(this.scope, this.id, {
        version: this.version, name: this.data.name, startOn: this.data.startOn || null, endOn: this.data.endOn || null, departureTime: this.data.departureTime || null,
        items: this.data.items.map(item => ({ clothingId: item.clothingId, packed: item.packed }))
      });
      this.applyTripState(result.data);
      this.setData({ busy: false });
    } catch (error) {
      const message = errorMessage(error);
      if (!message) return;
      this.updatePacked(id, packed);
      this.setData({ busy: false });
      wx.showToast({ title: message, icon: 'none' });
    }
  },
  onRemove(event: WechatMiniprogram.TouchEvent) {
    const id = idSchema.parse(event.currentTarget.dataset.id);
    this.setData({ editItems: this.data.editItems.filter(item => item.clothingId !== id) });
  },
  async onRemoveItem(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.loading || this.data.endedAt) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    this.setData({ busy: true, removingId: id, error: '' });
    try {
      const result = await updatePackingList(this.scope, this.id, {
        version: this.version, name: this.data.name, startOn: this.data.startOn || null, endOn: this.data.endOn || null, departureTime: this.data.departureTime || null,
        items: this.data.items.filter(item => item.clothingId !== id).map(item => ({ clothingId: item.clothingId, packed: item.packed }))
      });
      const items = this.data.items.filter(item => item.clothingId !== id);
      const packedCount = items.filter(item => item.packed).length;
      this.applyTripState(result.data);
      this.setData({ items, groups: this.groupItems(items, this.data.packingFilter), total: items.length, packedCount, progress: `${items.length ? packedCount / items.length * 100 : 0}%`, removingId: '', busy: false });
    } catch (error) {
      const message = errorMessage(error);
      if (!message) return;
      this.setData({ busy: false, removingId: '' });
      wx.showToast({ title: message, icon: 'none' });
    }
  },
  async onSave() {
    if (this.data.sheet === 'edit') {
      await this.save(this.data.editItems.map(item => ({ clothingId: item.clothingId, packed: item.packed })), this.data.draft);
      return;
    }
    await this.save([...this.data.items.map(item => ({ clothingId: item.clothingId, packed: item.packed })), ...this.data.selectedChoices.map(item => ({ clothingId: item.id, packed: false }))]);
  },
  async onCopy() {
    if (this.data.busy) return; this.setData({ busy: true, error: '' });
    try { const result = await copyPackingList(this.scope, this.id, { name: `${this.data.name.slice(0, 55)} 副本`, startOn: null, endOn: null }); this.setData({ busy: false }); wx.redirectTo({ url: `/pages/packing-detail/packing-detail?id=${result.data.id}` }); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async onDelete() {
    if (this.data.busy) return;
    const answer = await wx.showModal({ title: '删除这份旅行清单？', content: '衣橱中的衣物会保留。', confirmText: '删除' });
    if (!answer.confirm || !this.scope.active) return; this.setData({ busy: true, error: '' });
    try { await deletePackingList(this.scope, this.id); wx.navigateBack(); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async save(items: { clothingId: string; packed: boolean }[], details?: { name: string; startOn: string; endOn: string; departureTime: string }) {
    if (this.data.busy || this.data.addingGroup) return;
    const values = details || { name: this.data.name, startOn: this.data.startOn, endOn: this.data.endOn, departureTime: this.data.departureTime };
    const input = packingPatchSchema.safeParse({ version: this.version, name: values.name, startOn: values.startOn || null, endOn: values.endOn || null, departureTime: values.departureTime.trim() || null, items });
    if (!input.success) { this.setData({ error: input.error.issues[0].path[0] === 'departureTime' ? input.error.issues[0].message : '请填写清单名称，并检查起止日期和衣物数量（最多 100 件）' }); return; }
    this.setData({ busy: true, error: '' });
    try {
      if (details && (values.startOn !== this.data.startOn || values.endOn !== this.data.endOn || values.departureTime !== this.data.departureTime) && !this.reminderSubscriptions && this.data.reminderAvailable && this.data.reminders.filter(item => ['scheduled', 'sending'].includes(item.status)).length < pendingPackingReminders(values.startOn)) this.reminderSubscriptions += await requestPackingSubscription(this.data.reminderTemplateId);
      if (!this.scope.active) return;
      await updatePackingList(this.scope, this.id, { ...input.data, reminderSubscriptions: this.reminderSubscriptions });
      this.reminderSubscriptions = 0;
      this.setData({ busy: false, sheet: '', selectedChoices: [] });
      await this.load();
    }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async loadCategories() {
    if (this.data.taxonomyLoading) return;
    this.setData({ taxonomyLoading: true, taxonomyError: '' });
    try {
      const result = await listCategories(this.scope);
      this.categories = result.data;
      this.setData({ rootCategories: result.data.filter(item => !item.parentId), subCategories: result.data.filter(item => item.parentId === this.data.rootCategoryId), taxonomyLoading: false, taxonomyLoaded: true });
    } catch (error) {
      const message = errorMessage(error);
      if (message) this.setData({ taxonomyError: message, taxonomyLoading: false });
    }
  },
  async loadChoices(reset: boolean) {
    if (!reset && this.data.loadingChoices) return;
    const request = ++this.choiceRequest;
    const page = reset ? 1 : this.page + 1;
    if (reset) { this.page = 0; this.choiceQuery = this.data.query.trim(); }
    this.setData({ loadingChoices: true, choiceError: '', ...(reset ? { choices: [], choicesTotal: 0 } : {}) });
    try {
      const result = await listClothes(this.scope, { page, q: this.choiceQuery, categoryId: this.data.categoryId || undefined, favorite: this.data.favoriteOnly ? true : undefined });
      if (request !== this.choiceRequest) return;
      const urls = await imageUrls(this.scope, result.data.map(item => item.primaryAssetId), 'thumbnail');
      if (request !== this.choiceRequest) return;
      this.page = page;
      this.setData({ choices: [...(reset ? [] : this.data.choices), ...result.data.map(item => ({ id: item.id, name: item.name, primaryAssetId: item.primaryAssetId, imageUrl: urls[item.primaryAssetId], selected: this.data.selectedChoices.some(value => value.id === item.id), included: this.data.items.some(value => value.clothingId === item.id) }))], choicesTotal: result.pagination.total, loadingChoices: false });
    } catch (error) {
      const message = errorMessage(error);
      if (message && request === this.choiceRequest) this.setData({ choiceError: message, loadingChoices: false });
    }
  },
  async loadOutfits() {
    if (this.data.loadingOutfits) return;
    this.setData({ loadingOutfits: true, outfitError: '' });
    try {
      const result = await listOutfits(this.scope, { page: this.outfitPage + 1 }); this.outfitPage++;
      this.setData({ outfits: [...this.data.outfits, ...result.data.map(item => ({ id: item.id, name: item.name, clothingIds: item.items.map(item => item.clothingId) }))], outfitsTotal: result.pagination.total, loadingOutfits: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ outfitError: message, loadingOutfits: false }); }
  },
  async loadSets(reset: boolean) {
    if (!reset && this.data.loadingSets) return;
    const request = ++this.setRequest;
    const page = reset ? 1 : this.setPage + 1;
    if (reset) { this.setPage = 0; this.setSearch = this.data.setQuery.trim(); }
    this.setData({ loadingSets: true, setError: '', ...(reset ? { sets: [], setsTotal: 0 } : {}) });
    try {
      const result = await listClothingSets(this.scope, page, this.setSearch);
      if (request !== this.setRequest) return;
      const previews = result.data.map(item => item.coverAssetId ? [{ id: item.id, assetId: item.coverAssetId }] : item.members.slice(0, 4).map(member => ({ id: member.id, assetId: member.primaryAssetId })));
      const urls = await imageUrls(this.scope, previews.flatMap(items => items.map(item => item.assetId)), 'thumbnail');
      if (request !== this.setRequest) return;
      this.setPage = page;
      this.setData({ sets: [...(reset ? [] : this.data.sets), ...result.data.map((item, index) => ({ id: item.id, name: item.name, clothingIds: item.members.map(member => member.id), previews: previews[index].map(preview => ({ id: preview.id, url: urls[preview.assetId] })), members: item.members.map(member => ({ id: member.id, name: member.name, included: this.data.items.some(value => value.clothingId === member.id), selected: this.data.selectedChoices.some(value => value.id === member.id) })), remainingCount: item.members.filter(member => !this.data.items.some(value => value.clothingId === member.id) && !this.data.selectedChoices.some(value => value.id === member.id)).length }))], setsTotal: result.pagination.total, loadingSets: false });
    } catch (error) {
      const message = errorMessage(error);
      if (message && request === this.setRequest) this.setData({ setError: message, loadingSets: false });
    }
  },
  updateSelection(selectedChoices: ClothingChoice[]) {
    this.setData({
      selectedChoices,
      choices: this.data.choices.map(item => ({ ...item, selected: selectedChoices.some(value => value.id === item.id) })),
      sets: this.data.sets.map(item => ({ ...item, members: item.members.map(member => ({ ...member, selected: selectedChoices.some(value => value.id === member.id) })), remainingCount: item.clothingIds.filter(id => !this.data.items.some(value => value.clothingId === id) && !selectedChoices.some(value => value.id === id)).length })),
      error: ''
    });
  },
  groupItems(items: PackingItem[], filter: string) {
    const groups = new Map<string, PackingGroup>();
    for (const item of items) {
      const id = item.rootCategoryId || 'uncategorized';
      if (!groups.has(id)) groups.set(id, { id, name: item.rootCategoryName, total: 0, packedCount: 0, collapsed: this.collapsedGroupIds.has(id), items: [] });
      const group = groups.get(id)!;
      group.total++;
      group.packedCount += Number(item.packed);
      if (filter === 'all' || (filter === 'packed' ? item.packed : !item.packed)) group.items.push(item);
    }
    return [...groups.values()].filter(group => group.items.length);
  },
  updatePacked(id: string, packed: boolean) {
    const index = this.data.items.findIndex(item => item.clothingId === id);
    const items = this.data.items.map(item => item.clothingId === id ? { ...item, packed } : item);
    const packedCount = items.filter(item => item.packed).length;
    this.setData({ [`items[${index}].packed`]: packed, groups: this.groupItems(items, this.data.packingFilter), packedCount, progress: `${packedCount / items.length * 100}%` });
  },
  applyTripState(list: PackingList) {
    this.version = list.version;
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const dateLabel = list.startOn ? `${list.startOn}${list.departureTime ? ` ${list.departureTime}` : ''}${list.endOn ? ` — ${list.endOn}` : ' 出发'}` : list.endOn ? `截至 ${list.endOn}` : '日期未定';
    this.setData({ endedAt: list.endedAt || '', overdue: Boolean(!list.endedAt && list.endOn && list.endOn < today), departureTime: list.departureTime || '', dateLabel, reminders: list.reminders });
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const [result, capabilities] = await Promise.all([getPackingList(this.scope, this.id), getCapabilities(this.scope)]);
      const urls = await imageUrls(this.scope, result.data.items.map(item => item.primaryAssetId), 'thumbnail');
      this.applyTripState(result.data);
      const items = result.data.items.map(item => ({ ...item, imageUrl: urls[item.primaryAssetId] }));
      this.setData({ items, groups: this.groupItems(items, this.data.packingFilter), reminderAvailable: capabilities.data.packingReminder.available, reminderTemplateId: capabilities.data.packingReminder.templateId, progress: `${items.length ? items.filter(item => item.packed).length / items.length * 100 : 0}%`, name: result.data.name, startOn: result.data.startOn || '', endOn: result.data.endOn || '', total: items.length, packedCount: items.filter(item => item.packed).length, choices: this.data.choices.map(item => ({ ...item, selected: false, included: items.some(value => value.clothingId === item.id) })), loading: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, loading: false }); }
  }
});
