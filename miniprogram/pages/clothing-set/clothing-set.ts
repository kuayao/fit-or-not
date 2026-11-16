import { refreshExpiredImage } from '../../utils/refresh-image';
import { z } from 'zod';
import { idSchema } from '../../api/contracts';
import type { Category, Clothing, ClothingSet } from '../../api/contracts';
import { createClothingSet, deleteClothingSet, getClothing, getClothingSet, imageUrls, listCategories, listClothes, listClothingSets, updateClothingSet, uploadPhoto } from '../../api/client';
import { ApiError, RequestScope, errorMessage, requireSession } from '../../utils/request';

Page({
  scope: new RequestScope(), id: '', initialClothingId: '', page: 0, setPage: 0, clothesGeneration: 0, clothesRetryReset: true, choicesRetryReset: true,
  data: { record: null as ClothingSet | null, name: '', coverAssetId: '', coverUrl: '', edit: false,
    members: Array<ClothingSet['members'][number] & { imageUrl: string }>(), memberIds: Array<string>(),
    clothes: Array<Pick<Clothing, 'id' | 'name' | 'setId' | 'categoryName' | 'primaryAssetId' | 'status'> & { imageUrl: string; selected: boolean }>(),
    choices: Array<ClothingSet & { imageUrl: string; previews: { id: string; url: string }[] }>(), choosing: false, choicesTotal: 0, choicesLoading: false, choicesError: '',
    picking: false, categories: Array<Category>(), rootCategories: Array<Category>(), subCategories: Array<Category>(), rootCategoryId: '', categoryId: '', taxonomyLoading: false, taxonomyError: '',
    q: '', total: 0, clothesLoading: false, clothesError: '', loading: true, busy: false, error: '' },
  onLoad(options) {
    this.scope = new RequestScope(); if (!requireSession()) return;
    const input = z.object({ id: idSchema.optional(), clothingId: idSchema.optional() }).parse(options);
    this.id = input.id || ''; this.initialClothingId = input.clothingId || '';
    this.setData({ edit: !this.id }); void this.load();
  },
  onShow() { if (this.scope.hasShown && !this.data.edit && requireSession()) void this.load(); this.scope.hasShown = true; },
  onUnload() { this.clothesGeneration++; this.scope.close(); },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => { this.setData({ coverUrl: this.data.coverUrl === oldUrl ? url : this.data.coverUrl, members: this.data.members.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })), clothes: this.data.clothes.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })), choices: this.data.choices.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl, previews: item.previews.map(preview => ({ ...preview, url: preview.url === oldUrl ? url : preview.url })) })) }); }, message => this.setData({ error: message }));
  },
  onRetry() { void this.load(); },
  onName(event: WechatMiniprogram.Input) { this.setData({ name: event.detail.value }); },
  onSearchInput(event: WechatMiniprogram.Input) { this.setData({ q: event.detail.value }); },
  onSearch() { void this.loadClothes(true); },
  onMoreClothes() { if (!this.data.clothesLoading && !this.data.clothesError && this.data.clothes.length < this.data.total) void this.loadClothes(false); },
  onRetryClothes() { void this.loadClothes(this.clothesRetryReset); },
  onOpenClothes() {
    if (this.data.busy) return;
    this.setData({ picking: true }); void this.loadCategories(); void this.loadClothes(true);
  },
  onCloseClothes() { this.setData({ picking: false }); },
  onRootCategory(event: WechatMiniprogram.TouchEvent) {
    const id = z.union([idSchema, z.literal('')]).parse(event.currentTarget.dataset.id);
    this.setData({ rootCategoryId: id, categoryId: id, subCategories: this.data.categories.filter(item => item.parentId === id) });
    void this.loadClothes(true);
  },
  onSubCategory(event: WechatMiniprogram.TouchEvent) { this.setData({ categoryId: idSchema.parse(event.currentTarget.dataset.id) }); void this.loadClothes(true); },
  onRetryCategories() { void this.loadCategories(); },
  onEdit() { this.setData({ edit: true }); },
  onCancelEdit() { if (!this.data.busy && this.id) { this.setData({ edit: false }); void this.load(); } },
  onMember(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/clothing-detail/clothing-detail?id=${idSchema.parse(event.currentTarget.dataset.id)}` }); },
  onToggleMember(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    const selected = this.data.memberIds.includes(id);
    if (!selected && this.data.memberIds.length >= 50) { void wx.showToast({ title: '套装最多可选 50 件单品', icon: 'none' }); return; }
    const memberIds = selected ? this.data.memberIds.filter(value => value !== id) : [...this.data.memberIds, id];
    this.setData({ memberIds, members: selected ? this.data.members.filter(item => item.id !== id) : [...this.data.members, this.data.clothes.find(item => item.id === id)!], clothes: this.data.clothes.map(item => ({ ...item, selected: memberIds.includes(item.id) })) });
  },
  async onPreview() {
    if (!this.data.coverAssetId) return;
    try {
      const urls = await imageUrls(this.scope, [this.data.coverAssetId], 'original');
      wx.previewImage({ urls: [urls[this.data.coverAssetId]] });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message }); }
  },
  onChooseExisting() { this.setData({ choosing: true }); void this.loadChoices(true); },
  onCloseChoices() { this.setData({ choosing: false }); },
  onMoreChoices() { if (!this.data.choicesLoading && !this.data.choicesError && this.data.choices.length < this.data.choicesTotal) void this.loadChoices(false); },
  onRetryChoices() { void this.loadChoices(this.choicesRetryReset); },
  onChooseSet(event: WechatMiniprogram.TouchEvent) { this.id = idSchema.parse(event.currentTarget.dataset.id); this.setData({ choosing: false, edit: true }); void this.load(true); },
  async onCover() {
    if (this.data.busy) return;
    try {
      const result = await wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'] });
      if (!this.scope.active) return;
      this.setData({ busy: true });
      const uploaded = await uploadPhoto(this.scope, result.tempFiles[0].tempFilePath);
      this.setData({ coverAssetId: uploaded.data.assetId, coverUrl: result.tempFiles[0].tempFilePath, busy: false });
    } catch (error) {
      const cancelled = z.object({ errMsg: z.string() }).safeParse(error);
      if (cancelled.success && cancelled.data.errMsg.includes('cancel')) { this.setData({ busy: false }); return; }
      const message = errorMessage(error); if (message) this.setData({ busy: false, error: message });
    }
  },
  async onDissolve() {
    if (this.data.busy || !this.id) return;
    const answer = await wx.showModal({ title: '解散这套套装？', content: '单品及穿着记录会保留。', confirmText: '解散套装' });
    if (!answer.confirm || !this.scope.active) return;
    this.setData({ busy: true, error: '' });
    try { await deleteClothingSet(this.scope, this.id); wx.navigateBack(); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ busy: false, error: message }); }
  },
  async onSave() {
    if (this.data.busy || this.data.loading || this.data.clothesLoading) return;
    if (this.data.memberIds.length < 2 && this.id) { await this.onDissolve(); return; }
    if (this.data.memberIds.length < 2 || !this.data.name.trim()) { this.setData({ error: '请填写套装名称，并至少选择两件单品' }); return; }
    this.setData({ busy: true, error: '' });
    try {
      const input = { name: this.data.name, coverAssetId: this.data.coverAssetId || null, memberIds: this.data.memberIds, moveMembers: false, ...(this.id ? { version: this.data.record!.version } : {}) };
      const result = await (this.id ? updateClothingSet(this.scope, this.id, input) : createClothingSet(this.scope, input));
      this.id = result.data.id; this.initialClothingId = '';
      this.setData({ busy: false, edit: false }); await this.load();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'SET_MEMBERSHIP_CONFLICT') {
        const answer = await wx.showModal({ title: '移动到这套套装？', content: '部分单品已有所属套装。移动后，原套装不足两件会解散。', confirmText: '确认移动' });
        if (!this.scope.active) return;
        if (!answer.confirm) { this.setData({ busy: false }); return; }
        try {
          const input = { name: this.data.name, coverAssetId: this.data.coverAssetId || null, memberIds: this.data.memberIds, moveMembers: true, ...(this.id ? { version: this.data.record!.version } : {}) };
          const result = await (this.id ? updateClothingSet(this.scope, this.id, input) : createClothingSet(this.scope, input));
          this.id = result.data.id; this.initialClothingId = ''; this.setData({ busy: false, edit: false }); await this.load();
        } catch (moveError) { const message = errorMessage(moveError); if (message) this.setData({ busy: false, error: message }); }
        return;
      }
      const message = errorMessage(error); if (message) this.setData({ busy: false, error: message });
    }
  },
  async loadChoices(reset: boolean) {
    if (this.data.choicesLoading) return;
    this.choicesRetryReset = reset;
    this.setData({ choicesLoading: true, choicesError: '', ...(reset ? { choices: [], choicesTotal: 0 } : {}) });
    try {
      const page = reset ? 1 : this.setPage + 1;
      const result = await listClothingSets(this.scope, page);
      const urls = await imageUrls(this.scope, result.data.flatMap(item => [...(item.coverAssetId ? [item.coverAssetId] : []), ...item.members.slice(0, 2).map(member => member.primaryAssetId)]), 'thumbnail');
      this.setPage = page;
      this.setData({ choicesLoading: false, choices: [...(reset ? [] : this.data.choices), ...result.data.map(item => ({ ...item, imageUrl: item.coverAssetId ? urls[item.coverAssetId] : '', previews: item.members.slice(0, 2).map(member => ({ id: member.id, url: urls[member.primaryAssetId] })) }))], choicesTotal: result.pagination.total });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ choicesLoading: false, choicesError: message }); }
  },
  async loadCategories() {
    this.setData({ taxonomyLoading: true, taxonomyError: '' });
    try {
      const result = await listCategories(this.scope);
      this.setData({ categories: result.data, rootCategories: result.data.filter(item => !item.parentId), subCategories: result.data.filter(item => item.parentId === this.data.rootCategoryId), taxonomyLoading: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ taxonomyLoading: false, taxonomyError: message }); }
  },
  async loadClothes(reset: boolean) {
    if (!reset && this.data.clothesLoading) return;
    const generation = ++this.clothesGeneration;
    this.clothesRetryReset = reset;
    this.setData({ clothesLoading: true, clothesError: '', ...(reset ? { clothes: [], total: 0 } : {}) });
    try {
      const page = reset ? 1 : this.page + 1;
      const result = await listClothes(this.scope, { page, q: this.data.q, categoryId: this.data.categoryId || undefined, status: 'active' });
      const urls = await imageUrls(this.scope, result.data.map(item => item.primaryAssetId), 'thumbnail');
      if (generation !== this.clothesGeneration) return;
      this.page = page;
      this.setData({ clothesLoading: false, total: result.pagination.total, clothes: [...(reset ? [] : this.data.clothes), ...result.data.map(item => ({ id: item.id, name: item.name, categoryName: item.categoryName, primaryAssetId: item.primaryAssetId, status: item.status, setId: item.setId, imageUrl: urls[item.primaryAssetId], selected: this.data.memberIds.includes(item.id) }))] });
    } catch (error) { const message = errorMessage(error); if (message && generation === this.clothesGeneration) this.setData({ clothesLoading: false, clothesError: message }); }
  },
  async load(keepMembers = false) {
    this.setData({ loading: true, error: '' });
    try {
      const record = this.id ? (await getClothingSet(this.scope, this.id)).data : null;
      const initial = this.initialClothingId ? (await getClothing(this.scope, this.initialClothingId)).data : null;
      const members = [...new Map([...(record?.members || []), ...(keepMembers ? this.data.members : []), ...(initial ? [initial] : [])].map(item => [item.id, item])).values()];
      const [urls, thumbnails] = await Promise.all([
        imageUrls(this.scope, record?.coverAssetId ? [record.coverAssetId] : []),
        imageUrls(this.scope, members.map(item => item.primaryAssetId), 'thumbnail')
      ]);
      this.setData({ record, name: record?.name || '', coverAssetId: record?.coverAssetId || '', coverUrl: record?.coverAssetId ? urls[record.coverAssetId] : '', members: members.map(item => ({ ...item, imageUrl: thumbnails[item.primaryAssetId] })), memberIds: members.map(item => item.id), loading: false });
      wx.setNavigationBarTitle({ title: this.id ? '套装详情' : '新建套装' });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ loading: false, error: message }); }
  }
});
