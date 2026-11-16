import { refreshExpiredImage } from '../../utils/refresh-image';
import { z } from 'zod';
import { listClothes, listCategories, listTags, getClothing, getOutfit, createOutfit, updateOutfit, imageUrls, listOutfitCategories, createOutfitCategory } from '../../api/client';
import { idSchema, outfitInputSchema, seasons, seasonLabels } from '../../api/contracts';
import type { Clothing, LayoutItem, OutfitCategory } from '../../api/contracts';
import { fitLayoutItem } from '../../utils/layout';
import { RequestScope, requireSession, errorMessage } from '../../utils/request';

Page({
  scope: new RequestScope(), id: '', version: 0, clothesPage: 0, clothesGeneration: 0, initialClothingId: '', dirty: false,
  canvasWidth: 1, canvasHeight: 1, history: Array<LayoutItem[]>(),
  gesture: { active: false, moved: false, resize: false, x: 0, y: 0, item: { clothingId: '', x: 0, y: 0, width: 0, height: 0, rotation: 0, zIndex: 0 } },
  sourceItems: Array<LayoutItem>(), clothingInfo: new Map<string, { name: string; imageUrl: string }>(),
  data: {
    name: '我的新搭配', occasion: '', notes: '', favorite: false, backgroundColor: '#FFFFFF', selectedId: '', selectedName: '', selectionStyle: '',
    seasonOptions: seasons.map((value, index) => ({ value, label: seasonLabels[index], selected: false })),
    settingsDraft: { notes: '', seasonOptions: seasons.map((value, index) => ({ value, label: seasonLabels[index], selected: false })) },
    sheet: '', occasionDraft: '', activeTab: 'closet', canvasStyle: '',
    items: Array<LayoutItem & { style: string; imageUrl: string; name: string }>(),
    layers: Array<{ clothingId: string; imageUrl: string; name: string }>(),
    clothes: Array<Clothing & { imageUrl: string; selected: boolean }>(),
    loading: true, busy: false, error: '', loadError: '', canUndo: false, selectedCount: 0,
    loadingClothes: true, clothesLoaded: false, clothesTotal: 0, clothesError: '', clothingCategoryId: '',
    clothingCategories: Array<{ id: string; name: string }>(), clothingCategoriesLoading: true, clothingCategoriesError: '',
    occasions: Array<{ id: string; name: string }>(), occasionsLoading: true, occasionsError: '',
    backgrounds: [{ color: '#FFFFFF', name: '纯白' }, { color: '#F0F6FB', name: '晴空蓝' }, { color: '#F8F9FB', name: '浅灰' }, { color: '#F8F3ED', name: '米白' }],
    categoryId: '', categoryName: '未分类', categories: Array<OutfitCategory>(), categoriesLoading: true, categoriesError: '', categoryBusy: false, categoryCreateError: ''
  },
  onLoad(options) {
    this.scope = new RequestScope(); this.clothingInfo = new Map();
    if (!requireSession()) return;
    const input = z.object({ id: idSchema.optional(), clothingId: idSchema.optional(), categoryId: idSchema.optional() }).parse(options);
    this.id = input.id || ''; this.initialClothingId = input.clothingId || '';
    this.setData({ categoryId: input.categoryId || '' });
    void this.load(); void this.loadClothes(true); void this.loadCategories(); void this.loadClothingCategories(); void this.loadOccasions();
    wx.setNavigationBarTitle({ title: this.id ? '编辑搭配' : '新建搭配' });
  },
  onShow() { if (this.scope.hasShown && requireSession()) void this.loadClothes(true); this.scope.hasShown = true; },
  onReady() { this.measureCanvas(); },
  onResize() { this.measureCanvas(); },
  onUnload() { this.clothesGeneration++; this.scope.close(); wx.disableAlertBeforeUnload(); },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => {
      for (const info of this.clothingInfo.values()) if (info.imageUrl === oldUrl) info.imageUrl = url;
      this.setData({ clothes: this.data.clothes.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })) });
      this.renderItems();
    }, message => this.setData({ error: message }));
  },
  onInput(event: WechatMiniprogram.Input) { this.markDirty(); this.setData({ name: event.detail.value, error: '' }); },
  onTab(event: WechatMiniprogram.TouchEvent) { this.setData({ activeTab: z.enum(['closet', 'background']).parse(event.currentTarget.dataset.tab) }); },
  onOpenSheet(event: WechatMiniprogram.TouchEvent) {
    const sheet = z.enum(['occasion', 'category', 'settings', 'layers', 'clear']).parse(event.currentTarget.dataset.sheet);
    this.setData({ sheet, occasionDraft: this.data.occasion, settingsDraft: { notes: this.data.notes, seasonOptions: this.data.seasonOptions.map(item => ({ ...item })) } });
  },
  onCloseSheet() { this.setData({ sheet: '' }); },
  onConfirmSettings() { this.markDirty(); this.setData({ ...this.data.settingsDraft, sheet: '' }); },
  onNotesInput(event: WechatMiniprogram.Input) { this.setData({ 'settingsDraft.notes': event.detail.value }); },
  onOccasionInput(event: WechatMiniprogram.Input) { this.setData({ occasionDraft: event.detail.value }); },
  onOccasion(event: WechatMiniprogram.TouchEvent) {
    this.markDirty(); this.setData({ occasion: z.string().max(60).parse(event.currentTarget.dataset.value), sheet: '' });
  },
  onConfirmOccasion() { this.markDirty(); this.setData({ occasion: this.data.occasionDraft.trim(), sheet: '' }); },
  onSeason(event: WechatMiniprogram.TouchEvent) {
    const value = z.enum(seasons).parse(event.currentTarget.dataset.value);
    this.setData({ 'settingsDraft.seasonOptions': this.data.settingsDraft.seasonOptions.map(item => ({ ...item, selected: item.value === value ? !item.selected : item.selected })) });
  },
  onBackground(event: WechatMiniprogram.TouchEvent) {
    this.markDirty(); this.setData({ backgroundColor: z.string().regex(/^#[a-fA-F0-9]{6}$/).parse(event.currentTarget.dataset.color) });
  },
  onCategory(event: WechatMiniprogram.CustomEvent<{ id: string }>) {
    this.markDirty(); this.setData({ categoryId: event.detail.id, categoryName: this.data.categories.find(item => item.id === event.detail.id)?.name || '未分类', sheet: '' });
  },
  async onCreateCategory(event: WechatMiniprogram.CustomEvent<{ name: string }>) {
    if (this.data.categoryBusy) return;
    this.setData({ categoryBusy: true, categoryCreateError: '' });
    try {
      const result = await createOutfitCategory(this.scope, event.detail.name);
      this.markDirty(); this.setData({ categories: [...this.data.categories, result.data], categoryId: result.data.id, categoryName: result.data.name, categoryBusy: false, sheet: '' });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ categoryCreateError: message, categoryBusy: false }); }
  },
  onClothingCategory(event: WechatMiniprogram.TouchEvent) {
    const id = z.union([idSchema, z.literal('')]).parse(event.currentTarget.dataset.id);
    if (id === this.data.clothingCategoryId) return;
    this.setData({ clothingCategoryId: id }); void this.loadClothes(true);
  },
  onSelect(event: WechatMiniprogram.TouchEvent) {
    const id = idSchema.parse(event.currentTarget.dataset.id);
    this.setData(this.selectionData(id));
  },
  onDeselect() { this.setData(this.selectionData('')); },
  onControlTouch() {},
  onTouchStart(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.loading) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    const action = z.enum(['drag', 'resize']).parse(event.currentTarget.dataset.action);
    this.gesture = { active: true, moved: false, resize: action === 'resize', x: event.touches[0].clientX, y: event.touches[0].clientY, item: { ...this.sourceItems.find(item => item.clothingId === id)! } };
    this.setData(this.selectionData(id));
  },
  onTouchMove(event: WechatMiniprogram.TouchEvent) {
    if (!this.gesture.active) return;
    if (!this.gesture.moved) { this.remember(); this.gesture.moved = true; }
    const dx = event.touches[0].clientX - this.gesture.x;
    const dy = event.touches[0].clientY - this.gesture.y;
    const original = this.gesture.item;
    if (this.gesture.resize) {
      const angle = original.rotation * Math.PI / 180;
      const width = original.width * this.canvasWidth;
      const height = original.height * this.canvasHeight;
      const factor = Math.max(0.08 / Math.min(original.width, original.height), 1 + 2 * (dx * (width * Math.cos(angle) - height * Math.sin(angle)) + dy * (width * Math.sin(angle) + height * Math.cos(angle))) / (width * width + height * height));
      this.sourceItems = this.sourceItems.map(item => item.clothingId === original.clothingId ? fitLayoutItem({ ...original, x: original.x + original.width * (1 - factor) / 2, y: original.y + original.height * (1 - factor) / 2, width: original.width * factor, height: original.height * factor }) : item);
      this.renderItems(false); return;
    }
    this.sourceItems = this.sourceItems.map(item => item.clothingId === original.clothingId ? fitLayoutItem({ ...original, x: original.x + dx / this.canvasWidth, y: original.y + dy / this.canvasHeight }) : item);
    this.renderItems(false);
  },
  onTouchEnd() { this.gesture.active = false; },
  onTool(event: WechatMiniprogram.TouchEvent) {
    const action = z.enum(['rotate', 'front', 'back', 'remove']).parse(event.currentTarget.dataset.action);
    if (!this.data.selectedId) return;
    this.remember();
    if (action === 'remove') { this.sourceItems = this.sourceItems.filter(item => item.clothingId !== this.data.selectedId).map((item, index) => ({ ...item, zIndex: index })); this.onDeselect(); this.renderItems(); return; }
    this.sourceItems = this.sourceItems.map(item => {
      if (item.clothingId !== this.data.selectedId) return item;
      if (action === 'rotate') return fitLayoutItem({ ...item, rotation: item.rotation >= 180 ? -165 : item.rotation + 15 });
      return { ...item, zIndex: action === 'front' ? 99 : -1 };
    }).sort((a, b) => a.zIndex - b.zIndex).map((item, index) => ({ ...item, zIndex: index }));
    this.renderItems();
  },
  onLayer(event: WechatMiniprogram.TouchEvent) { this.onSelect(event); this.setData({ sheet: '' }); },
  onLayerOrder(event: WechatMiniprogram.TouchEvent) { this.onSelect(event); this.onTool(event); },
  onAddClothing(event: WechatMiniprogram.TouchEvent) {
    const id = idSchema.parse(event.currentTarget.dataset.id);
    if (this.sourceItems.some(item => item.clothingId === id)) { this.onSelect(event); return; }
    if (this.sourceItems.length >= 12) { wx.showToast({ title: '最多加入 12 件衣物', icon: 'none' }); return; }
    this.remember();
    const index = this.sourceItems.length;
    this.sourceItems.push({ clothingId: id, x: 0.1 + index % 2 * 0.4, y: 0.08 + Math.floor(index % 4 / 2) * 0.42, width: 0.4, height: 0.4, rotation: 0, zIndex: index });
    this.setData({ selectedId: id }); this.renderItems();
  },
  onAutoLayout() {
    if (!this.sourceItems.length) return;
    this.remember();
    const columns = this.sourceItems.length <= 4 ? 2 : 3;
    const rows = Math.ceil(this.sourceItems.length / columns);
    this.sourceItems = this.sourceItems.map((item, index) => ({ ...item, x: (index % columns + 0.08) / columns, y: (Math.floor(index / columns) + 0.08) / rows, width: 0.84 / columns, height: 0.84 / rows, rotation: 0, zIndex: index }));
    this.onDeselect(); this.renderItems();
  },
  onConfirmClear() { this.remember(); this.sourceItems = []; this.setData({ selectedId: '', sheet: '' }); this.renderItems(); },
  onUndo() {
    const previous = this.history.pop();
    if (!previous) return;
    this.sourceItems = previous; this.markDirty(); this.onDeselect(); this.renderItems();
  },
  onAddNewClothing() { wx.navigateTo({ url: '/pages/clothing-import/clothing-import' }); },
  onMoreClothes() { if (this.data.clothes.length < this.data.clothesTotal) void this.loadClothes(); },
  onRetryClothes() { void this.loadClothes(); },
  onRetry() { void this.load(); },
  onRetryCategories() { void this.loadCategories(); },
  onRetryClothingCategories() { void this.loadClothingCategories(); },
  onRetryOccasions() { void this.loadOccasions(); },
  async onSave() {
    if (this.data.busy || this.data.loading || this.data.categoryBusy) return;
    const input = outfitInputSchema.safeParse({ categoryId: this.data.categoryId || null, favorite: this.data.favorite, seasons: this.data.seasonOptions.filter(item => item.selected).map(item => item.value), name: this.data.name, occasion: this.data.occasion, notes: this.data.notes, backgroundColor: this.data.backgroundColor, items: this.sourceItems });
    if (!input.success) { this.setData({ error: !this.data.name.trim() ? '请为搭配填写名称' : '请至少选择一件衣物' }); return; }
    this.setData({ busy: true, error: '' });
    try {
      const result = this.id ? await updateOutfit(this.scope, this.id, { ...input.data, version: this.version }) : await createOutfit(this.scope, input.data);
      wx.disableAlertBeforeUnload();
      wx.redirectTo({ url: `/pages/outfit-detail/outfit-detail?id=${result.data.id}` });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  markDirty() { if (this.dirty) return; this.dirty = true; wx.enableAlertBeforeUnload({ message: '搭配尚未保存，离开后本次修改会丢失' }); },
  remember() { this.history.push(this.sourceItems.map(item => ({ ...item }))); this.markDirty(); },
  measureCanvas() {
    this.createSelectorQuery().select('#canvas-stage').boundingClientRect(value => {
      const rect = z.object({ width: z.number().positive(), height: z.number().positive() }).parse(value);
      this.canvasWidth = Math.min(rect.width, rect.height * 3 / 4); this.canvasHeight = this.canvasWidth * 4 / 3;
      this.setData({ canvasStyle: `width:${this.canvasWidth}px;height:${this.canvasHeight}px;`, ...this.selectionData(this.data.selectedId) });
    }).exec();
  },
  selectionData(id: string) {
    if (!id) return { selectedId: '', selectedName: '', selectionStyle: '' };
    const item = this.sourceItems.find(value => value.clothingId === id)!;
    const width = Math.max(item.width, 88 / this.canvasWidth);
    const height = Math.max(item.height, 88 / this.canvasHeight);
    const frame = fitLayoutItem({ ...item, width, height, x: item.x + (item.width - width) / 2, y: item.y + (item.height - height) / 2 });
    return { selectedId: id, selectedName: this.clothingInfo.get(id)!.name,
      selectionStyle: `left:${frame.x * 100}%;top:${frame.y * 100}%;width:${frame.width * 100}%;height:${frame.height * 100}%;transform:rotate(${frame.rotation}deg);` };
  },
  renderItems(updateLibrary = true) {
    const items = this.sourceItems.map(item => ({ ...item, ...this.clothingInfo.get(item.clothingId)!, style: `left:${item.x * 100}%;top:${item.y * 100}%;width:${item.width * 100}%;height:${item.height * 100}%;transform:rotate(${item.rotation}deg);z-index:${item.zIndex};` }));
    this.setData({ items, ...this.selectionData(this.data.selectedId), canUndo: this.history.length > 0, selectedCount: items.length,
      ...(updateLibrary ? { layers: [...items].reverse().map(item => ({ clothingId: item.clothingId, name: item.name, imageUrl: item.imageUrl })),
        clothes: this.data.clothes.map(item => ({ ...item, selected: items.some(value => value.clothingId === item.id) })) } : {}) });
  },
  async loadCategories() {
    this.setData({ categoriesLoading: true, categoriesError: '' });
    try {
      const result = await listOutfitCategories(this.scope);
      this.setData({ categories: result.data, categoriesLoading: false, categoryName: result.data.find(item => item.id === this.data.categoryId)?.name || '未分类' });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ categoriesError: message, categoriesLoading: false }); }
  },
  async loadClothingCategories() {
    this.setData({ clothingCategoriesLoading: true, clothingCategoriesError: '' });
    try {
      const result = await listCategories(this.scope);
      this.setData({ clothingCategories: result.data.filter(item => !item.parentId), clothingCategoriesLoading: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ clothingCategoriesError: message, clothingCategoriesLoading: false }); }
  },
  async loadOccasions() {
    this.setData({ occasionsLoading: true, occasionsError: '' });
    try {
      const result = await listTags(this.scope);
      this.setData({ occasions: result.data.filter(item => item.kind === 'occasion'), occasionsLoading: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ occasionsError: message, occasionsLoading: false }); }
  },
  async loadClothes(reset = false) {
    if (!reset && this.data.loadingClothes) return;
    if (reset) { this.clothesGeneration++; this.clothesPage = 0; this.setData({ clothes: [], clothesTotal: 0, clothesLoaded: false }); }
    const generation = this.clothesGeneration;
    this.setData({ loadingClothes: true, clothesError: '' });
    try {
      const result = await listClothes(this.scope, { page: this.clothesPage + 1, pageSize: 20, categoryId: this.data.clothingCategoryId });
      const [urls, thumbnails] = await Promise.all([
        imageUrls(this.scope, result.data.map(item => item.primaryAssetId)),
        imageUrls(this.scope, result.data.map(item => item.primaryAssetId), 'thumbnail')
      ]);
      if (generation !== this.clothesGeneration) return;
      for (const item of result.data) this.clothingInfo.set(item.id, { name: item.name || '未命名衣物', imageUrl: urls[item.primaryAssetId] });
      this.clothesPage++;
      this.setData({ clothes: [...this.data.clothes, ...result.data.map(item => ({ ...item, imageUrl: thumbnails[item.primaryAssetId], selected: this.sourceItems.some(value => value.clothingId === item.id) }))], loadingClothes: false, clothesLoaded: true, clothesTotal: result.pagination.total });
      this.renderItems();
    } catch (error) { const message = errorMessage(error); if (message && generation === this.clothesGeneration) this.setData({ clothesError: message, loadingClothes: false }); }
  },
  async load() {
    this.setData({ loading: true, loadError: '' });
    try {
      if (this.id) {
        const result = await getOutfit(this.scope, this.id);
        const clothes = await Promise.all(result.data.items.map(item => getClothing(this.scope, item.clothingId)));
        const urls = await imageUrls(this.scope, clothes.map(item => item.data.primaryAssetId));
        for (const item of clothes) this.clothingInfo.set(item.data.id, { name: item.data.name || '未命名衣物', imageUrl: urls[item.data.primaryAssetId] });
        this.version = result.data.version; this.sourceItems = result.data.items;
        this.setData({ categoryId: result.data.categoryId || '', categoryName: result.data.categoryName || '未分类', favorite: result.data.favorite, seasonOptions: this.data.seasonOptions.map(item => ({ ...item, selected: result.data.seasons.includes(item.value) })), name: result.data.name, occasion: result.data.occasion, notes: result.data.notes, backgroundColor: result.data.backgroundColor });
      }
      if (this.initialClothingId) {
        const clothing = await getClothing(this.scope, this.initialClothingId);
        const urls = await imageUrls(this.scope, [clothing.data.primaryAssetId]);
        this.clothingInfo.set(clothing.data.id, { name: clothing.data.name || '未命名衣物', imageUrl: urls[clothing.data.primaryAssetId] });
        this.sourceItems = [{ clothingId: clothing.data.id, x: 0.2, y: 0.2, width: 0.6, height: 0.6, rotation: 0, zIndex: 0 }];
        this.markDirty();
      }
      this.renderItems(); this.setData({ loading: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ loadError: message, loading: false }); }
  }
});
