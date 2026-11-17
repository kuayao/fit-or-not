import { refreshExpiredImage } from '../../utils/refresh-image';
import { z } from 'zod';
import { idSchema, dateSchema, wearInputSchema, wearPatchSchema } from '../../api/contracts';
import type { Category, Clothing, Outfit } from '../../api/contracts';
import { listCategories, listClothes, listOutfits, getOutfit, getClothing, listWearRecords, createWearRecord, updateWearRecord, deleteWearRecord, uploadPhoto, imageUrls } from '../../api/client';
import { RequestScope, requireSession, errorMessage } from '../../utils/request';
import type { DateDetail } from '../../components/app-date-sheet/app-date-sheet';
import { currentDate } from '../../utils/format';

Page({
  scope: new RequestScope(), id: '', version: 0, dirty: false, sourceOutfitId: '', clothesPage: 0, outfitsPage: 0, clothesGeneration: 0,
  data: { dateOpen: false, draftIds: Array<string>(), draftOutfitId: '', draftOccasion: '', loadingClothes: false, loadingOutfits: false, choosing: false, wornOn: currentDate(), today: currentDate(), occasion: '', notes: '', bodyAssetId: '', bodyUrl: '',
    clothes: Array<Clothing & { imageUrl: string; selected: boolean; draftSelected: boolean; visible: boolean }>(), outfits: Array<Outfit & { imageUrl: string; layers: { clothingId: string; imageUrl: string; style: string }[] }>(), selectedIds: Array<string>(),
    chooseTab: 'clothes', searchText: '', q: '', categoryId: '', rootCategoryId: '', categories: Array<Category>(), rootCategories: Array<Category & { icon: string }>(), subCategories: Array<Category>(),
    loadingCategories: true, categoriesError: '', clothesError: '', outfitsError: '', clothesLoaded: false, clothesCount: 0,
    loading: false, busy: false, error: '', clothesTotal: 0, outfitsTotal: 0
  },
  onLoad(options) {
    this.scope = new RequestScope(); if (!requireSession()) return;
    const input = z.object({ id: idSchema.optional(), wornOn: dateSchema.optional(), clothingId: idSchema.optional(), outfitId: idSchema.optional() }).parse(options);
    this.id = input.id || ''; this.sourceOutfitId = input.outfitId || '';
    wx.setNavigationBarTitle({ title: this.id ? '编辑记录' : '记录穿搭' });
    this.setData({ wornOn: input.wornOn || currentDate() }); void this.load(input.clothingId);
  },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => { this.setData({ bodyUrl: this.data.bodyUrl === oldUrl ? url : this.data.bodyUrl, clothes: this.data.clothes.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })), outfits: this.data.outfits.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl, layers: item.layers.map(layer => ({ ...layer, imageUrl: layer.imageUrl === oldUrl ? url : layer.imageUrl })) })) }); }, message => this.setData({ error: message }));
  },
  onUnload() { this.clothesGeneration++; this.scope.close(); wx.disableAlertBeforeUnload(); },
  onChoose() { if (this.data.busy || this.data.loading) return; this.setData({ choosing: true, error: '', draftIds: [...this.data.selectedIds], draftOutfitId: this.sourceOutfitId, draftOccasion: this.data.occasion, clothes: this.data.clothes.map(item => ({ ...item, draftSelected: this.data.selectedIds.includes(item.id) })) }); },
  onChooseTab(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    this.setData({ chooseTab: z.enum(['outfits', 'clothes']).parse(event.currentTarget.dataset.tab) });
  },
  onSearchInput(event: WechatMiniprogram.Input) { this.setData({ searchText: event.detail.value }); },
  onSearch() { if (this.data.busy) return; this.setData({ q: this.data.searchText.trim() }); void this.loadClothes(true); },
  onClearSearch() { if (this.data.busy) return; this.setData({ searchText: '', q: '' }); void this.loadClothes(true); },
  onRootCategory(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const id = z.union([idSchema, z.literal('')]).parse(event.currentTarget.dataset.id);
    if (id === this.data.rootCategoryId && id === this.data.categoryId) return;
    this.setData({ rootCategoryId: id, categoryId: id, subCategories: this.data.categories.filter(item => item.parentId === id) });
    void this.loadClothes(true);
  },
  onSubCategory(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    if (id === this.data.categoryId) return;
    this.setData({ categoryId: id }); void this.loadClothes(true);
  },
  onCloseChoose() { this.setData({ choosing: false }); },
  onConfirmChoose() {
    if (this.sourceOutfitId !== this.data.draftOutfitId || this.data.occasion !== this.data.draftOccasion || this.data.selectedIds.length !== this.data.draftIds.length || this.data.draftIds.some(id => !this.data.selectedIds.includes(id))) this.markDirty();
    this.sourceOutfitId = this.data.draftOutfitId;
    this.setData({ choosing: false, selectedIds: this.data.draftIds, occasion: this.data.draftOccasion, clothes: this.data.clothes.map(item => ({ ...item, selected: this.data.draftIds.includes(item.id) })) });
  },
  onOpenDate() { if (!this.data.busy && !this.data.loading) this.setData({ dateOpen: true }); },
  onCloseDate() { this.setData({ dateOpen: false }); },
  onDate(event: WechatMiniprogram.CustomEvent<DateDetail>) { if (event.detail.value !== this.data.wornOn) this.markDirty(); this.setData({ wornOn: event.detail.value, dateOpen: false }); },
  onInput(event: WechatMiniprogram.Input) { const field = z.enum(['occasion', 'notes']).parse(event.currentTarget.dataset.field); if (event.detail.value !== this.data[field]) this.markDirty(); this.setData({ [field]: event.detail.value }); },
  onClothing(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    const draftIds = this.data.draftIds.includes(id) ? this.data.draftIds.filter(value => value !== id) : [...this.data.draftIds, id];
    if (draftIds.length > 12) { this.setData({ error: '一条记录最多选择 12 件衣物' }); return; }
    this.setData({ draftIds, draftOutfitId: '', error: '', clothes: this.data.clothes.map(item => ({ ...item, draftSelected: draftIds.includes(item.id) })) });
  },
  async onOutfit(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    const outfit = this.data.outfits.find(item => item.id === id)!;
    this.setData({ busy: true, error: '' });
    try {
      await this.addSelectedClothes(outfit.items.map(item => item.clothingId));
      this.setData({ draftIds: outfit.items.map(item => item.clothingId), draftOccasion: outfit.occasion, draftOutfitId: id, busy: false, clothes: this.data.clothes.map(item => ({ ...item, draftSelected: outfit.items.some(value => value.clothingId === item.id) })) });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  onMoreClothes() { void this.loadClothes(); },
  onMoreOutfits() { void this.loadOutfits(); },
  onRetryCategories() { void this.loadCategories(); },
  onRetry() { void this.load(); },
  onRemovePhoto() { if (this.data.bodyAssetId) this.markDirty(); this.setData({ bodyAssetId: '', bodyUrl: '' }); },
  async onPhoto() {
    if (this.data.busy) return;
    try {
      const selected = await wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'] });
      if (!this.scope.active) return;
      this.setData({ busy: true, error: '' });
      const uploaded = await uploadPhoto(this.scope, selected.tempFiles[0].tempFilePath, 'body-photo');
      this.markDirty();
      this.setData({ bodyAssetId: uploaded.data.assetId, bodyUrl: selected.tempFiles[0].tempFilePath, busy: false });
    } catch (error) {
      const cancel = z.object({ errMsg: z.string() }).safeParse(error);
      if (cancel.success && cancel.data.errMsg.includes('cancel')) return;
      const message = errorMessage(error); if (message) this.setData({ error: message, busy: false });
    }
  },
  async onSave() {
    if (this.data.busy) return;
    if (!this.data.selectedIds.length) { this.setData({ error: '请至少选择一件实际穿着的衣物' }); return; }
    if (this.data.wornOn > this.data.today) { this.setData({ error: '不能记录未来的实际穿着' }); return; }
    const common = { wornOn: this.data.wornOn, occasion: this.data.occasion, notes: this.data.notes, bodyAssetId: this.data.bodyAssetId || null };
    this.setData({ busy: true, error: '' });
    try {
      if (this.id) await updateWearRecord(this.scope, this.id, wearPatchSchema.parse({ ...common, version: this.version, clothingIds: this.data.selectedIds }));
      if (!this.id) await createWearRecord(this.scope, wearInputSchema.parse({ ...common, ...(this.sourceOutfitId ? { outfitId: this.sourceOutfitId } : { clothingIds: this.data.selectedIds }) }));
      this.dirty = false;
      wx.disableAlertBeforeUnload();
      this.setData({ busy: false }); wx.navigateBack();
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async onDelete() {
    if (!this.id || this.data.busy) return;
    const answer = await wx.showModal({ title: '删除这条穿搭记录？', content: '穿着次数和最近穿着日期会同步更新。', confirmText: '删除' });
    if (!answer.confirm || !this.scope.active) return; this.setData({ busy: true, error: '' });
    try { await deleteWearRecord(this.scope, this.id); this.dirty = false; wx.disableAlertBeforeUnload(); wx.navigateBack(); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  markDirty() { if (this.dirty) return; this.dirty = true; wx.enableAlertBeforeUnload({ message: '穿搭记录尚未保存，离开后本次修改会丢失' }); },
  async addSelectedClothes(ids: string[]) {
    const missing = ids.filter(id => !this.data.clothes.some(item => item.id === id));
    const additions = await Promise.all(missing.map(id => getClothing(this.scope, id)));
    const urls = await imageUrls(this.scope, additions.map(item => item.data.primaryAssetId), 'thumbnail');
    this.setData({ clothes: [...this.data.clothes, ...additions.map(item => ({ ...item.data, imageUrl: urls[item.data.primaryAssetId], selected: false, draftSelected: false, visible: false }))].map(item => ({ ...item, selected: this.data.selectedIds.includes(item.id) })) });
  },
  async loadCategories() {
    this.setData({ loadingCategories: true, categoriesError: '' });
    try {
      const result = await listCategories(this.scope);
      const icons: Record<string, string> = { '上衣': 'shirt', '外套': 'coat', '裤子': 'pants', '裙子': 'skirt', '连衣裙': 'dress', '鞋靴': 'shoe', '箱包': 'bag', '配饰': 'necklace', '眼镜': 'glasses', '帽子': 'hat', '其他': 'category-other' };
      this.setData({ categories: result.data, rootCategories: result.data.filter(item => !item.parentId).map(item => ({ ...item, icon: icons[item.name] || 'project-mark-clasp' })) });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ categoriesError: message }); }
    finally { if (this.scope.active) this.setData({ loadingCategories: false }); }
  },
  async loadClothes(reset = false) {
    if (!reset && (this.data.loadingClothes || (this.data.clothesLoaded && this.data.clothesCount >= this.data.clothesTotal))) return;
    const generation = ++this.clothesGeneration;
    if (reset) {
      this.clothesPage = 0;
      this.setData({ clothes: this.data.clothes.filter(item => item.selected || this.data.draftIds.includes(item.id)).map(item => ({ ...item, visible: false })), clothesCount: 0, clothesTotal: 0, clothesLoaded: false });
    }
    this.setData({ loadingClothes: true, clothesError: '' });
    try {
      const result = await listClothes(this.scope, { page: this.clothesPage + 1, categoryId: this.data.categoryId, q: this.data.q });
      if (generation !== this.clothesGeneration) return;
      const urls = await imageUrls(this.scope, result.data.map(item => item.primaryAssetId), 'thumbnail');
      if (!this.scope.active || generation !== this.clothesGeneration) return;
      this.clothesPage++;
      this.setData({ clothes: [...new Map([...this.data.clothes.filter(item => item.visible || !result.data.some(value => value.id === item.id)), ...result.data.map(item => ({ ...item, imageUrl: urls[item.primaryAssetId], selected: this.data.selectedIds.includes(item.id), draftSelected: this.data.draftIds.includes(item.id), visible: true }))].map(item => [item.id, item])).values()], clothesCount: this.data.clothesCount + result.data.length, clothesTotal: result.pagination.total, clothesLoaded: true });
    } catch (error) { const message = errorMessage(error); if (message && generation === this.clothesGeneration) this.setData({ clothesError: message }); }
    finally { if (this.scope.active && generation === this.clothesGeneration) this.setData({ loadingClothes: false }); }
  },
  async loadOutfits() {
    if (this.data.loadingOutfits) return;
    this.setData({ loadingOutfits: true, outfitsError: '' });
    try {
      const result = await listOutfits(this.scope, { page: this.outfitsPage + 1 });
      const urls = await imageUrls(this.scope, result.data.flatMap(item => item.coverAssetId ? [item.coverAssetId] : item.previewAssets.map(asset => asset.assetId)), 'thumbnail');
      this.outfitsPage++;
      this.setData({ outfits: [...this.data.outfits, ...result.data.map(item => ({ ...item,
        imageUrl: item.coverAssetId ? urls[item.coverAssetId] : '',
        layers: item.coverAssetId ? [] : item.items.map(layer => ({ clothingId: layer.clothingId, imageUrl: urls[item.previewAssets.find(asset => asset.clothingId === layer.clothingId)!.assetId], style: `left:${layer.x * 100}%;top:${layer.y * 100}%;width:${layer.width * 100}%;height:${layer.height * 100}%;transform:rotate(${layer.rotation}deg);z-index:${layer.zIndex};` }))
      }))], outfitsTotal: result.pagination.total });
    }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ outfitsError: message }); }
    finally { if (this.scope.active) this.setData({ loadingOutfits: false }); }
  },
  async load(clothingId?: string) {
    this.setData({ loading: true, error: '' });
    try {
      if (this.id) {
        const result = await listWearRecords(this.scope, this.data.wornOn, this.data.wornOn);
        const record = result.data.find(item => item.id === this.id);
        if (!record) { this.setData({ error: '这条记录已不存在', loading: false }); return; }
        this.version = record.version;
        const urls = record.bodyAssetId ? await imageUrls(this.scope, [record.bodyAssetId]) : {};
        this.setData({ wornOn: record.wornOn, occasion: record.occasion, notes: record.notes, bodyAssetId: record.bodyAssetId || '', bodyUrl: record.bodyAssetId ? urls[record.bodyAssetId] : '', selectedIds: record.items.map(item => item.clothingId) });
      }
      if (this.sourceOutfitId) { const result = await getOutfit(this.scope, this.sourceOutfitId); this.setData({ selectedIds: result.data.items.map(item => item.clothingId), occasion: result.data.occasion }); }
      if (clothingId) this.setData({ selectedIds: [clothingId] });
      if (!this.id && this.data.selectedIds.length) this.markDirty();
      await Promise.all([this.loadClothes(), this.loadOutfits(), this.loadCategories()]); await this.addSelectedClothes(this.data.selectedIds); this.setData({ loading: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, loading: false }); }
  }
});
