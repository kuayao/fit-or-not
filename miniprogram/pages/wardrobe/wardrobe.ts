import { refreshExpiredImage } from '../../utils/refresh-image';
import { z } from 'zod';
import { listClothes, listClothingImports, listCategories, imageUrls, listTags, listClothingOptions, batchClothes, getMe, updateClothing } from '../../api/client';
import { idSchema, colors, colorLabels, seasons, seasonLabels, patterns, patternLabels, clothingBatchSchema } from '../../api/contracts';
import type { Clothing, ClothingImport, Category, ClothingOption } from '../../api/contracts';
import { ApiError, RequestScope, errorMessage, requireSession } from '../../utils/request';
import type { SelectDetail } from '../../components/app-select-sheet/app-select-sheet';
import { COLOR_OPTIONS } from '../../config/colors';

const batchFieldSchema = z.enum(['categoryId', 'colors', 'seasons', 'pattern', 'brandId', 'sizeId', 'materialId', 'occasion', 'style']);
const BATCH_FIELDS = [
  { id: 'categoryId', name: '分类' }, { id: 'colors', name: '色系' }, { id: 'seasons', name: '季节' },
  { id: 'pattern', name: '图案' }, { id: 'brandId', name: '品牌' }, { id: 'sizeId', name: '尺码' },
  { id: 'materialId', name: '面料' }, { id: 'occasion', name: '场景' }, { id: 'style', name: '风格' }
];

Page({
  clothingOptions: Array<ClothingOption>(),
  scope: new RequestScope(), generation: 0, page: 0, timer: 0, visible: true, retryReset: true,
  data: {
    section: 'items', setRefresh: 0, imports: Array<ClothingImport & { imageUrl: string }>(), importTotal: 0,
    clothes: Array<Clothing & { imageUrl: string; selected: boolean; colorText: string; processing: boolean; processText: string; reviewText: string }>(), categories: Array<Category>(), rootCategories: Array<Category & { icon: string }>(), subCategories: Array<Category>(), rootCategoryId: '',
    tags: Array<{ id: string; name: string; kind: 'occasion' | 'style' }>(), q: '', categoryId: '', color: '', season: '', occasionIds: '', tagId: '', favorite: false,
    searchOpen: false, sidebarCollapsed: false, taxonomyLoading: true, taxonomyError: '',
    draft: false, showArchived: false, archived: false, filtersOpen: false, filterFavorite: false, sort: 'created', sortLabels: ['最新录入', '最近穿着', '穿着次数', '购买价格'], sortIndex: 0,
    filterSortIndex: 0, menuOpen: false, menuItems: Array<{ id: string; name: string }>(),
    filterColors: COLOR_OPTIONS.map(item => ({ ...item, selected: false })),
    filterSeasons: seasons.map((value, index) => ({ value, label: seasonLabels[index], selected: false })),
    filterOccasions: Array<{ id: string; name: string; selected: boolean }>(),
    batchOpen: false, batchAction: '', batchField: 'categoryId' as z.infer<typeof batchFieldSchema>, batchFields: BATCH_FIELDS,
    batchMode: 'add', batchModes: [{ id: 'add', name: '添加' }, { id: 'remove', name: '移除' }, { id: 'replace', name: '替换' }],
    batchValues: Array<string>(), batchOptions: Array<{ id: string; name: string; selected: boolean }>(),
    batchRootId: '', batchChildOptions: Array<{ id: string; name: string; selected: boolean }>(),
    batchLoading: false, batchTaxonomyError: '', batchError: '', batchMultiple: false, batchSummary: '请选择分类',
    loading: true, loaded: false, error: '', total: 0, managing: false, selectedIds: Array<string>(), busy: false
  },
  onLoad(options) {
    this.scope = new RequestScope();
    if (!requireSession()) return;
    this.setData({ archived: options.status === 'archived' });
    void this.loadPreferences();
    void this.loadTaxonomy();
  },
  onShow() {
    this.visible = true;
    this.setData({ setRefresh: this.data.setRefresh + 1 });
    this.getTabBar()?.setData({ selected: 1 });
    if (this.scope.hasShown && requireSession()) { void this.loadPreferences(); void this.loadTaxonomy(); }
    this.scope.hasShown = true;
  },
  onHide() { this.visible = false; clearTimeout(this.timer); this.generation++; this.setData({ loading: false }); },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => { this.setData({ imports: this.data.imports.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })), clothes: this.data.clothes.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })) }); }, message => this.setData({ error: message }));
  },
  onUnload() { this.visible = false; clearTimeout(this.timer); this.generation++; this.scope.close(); },
  onLoadMore() { if (!this.data.loading && (this.data.clothes.length < this.data.total || (this.data.draft && this.data.imports.length < this.data.importTotal))) void this.load(false); },
  onSection(event: WechatMiniprogram.TouchEvent) { if (this.data.busy) return; this.setData({ managing: false, selectedIds: [], batchOpen: false, section: z.enum(['items', 'sets']).parse(event.currentTarget.dataset.section) }); },
  onToggleSearch() { this.setData({ searchOpen: !this.data.searchOpen }); },
  onToggleSidebar() { this.setData({ sidebarCollapsed: !this.data.sidebarCollapsed }); },
  onRetryTaxonomy() { void this.loadTaxonomy(); },
  onRetryClothes() { void this.load(this.retryReset); },
  onSearchInput(event: WechatMiniprogram.Input) { this.setData({ q: event.detail.value }); },
  onSearch() { void this.load(true); },
  onRootCategory(event: WechatMiniprogram.TouchEvent) {
    const id = z.union([idSchema, z.literal('')]).parse(event.currentTarget.dataset.id);
    this.setData({ draft: false, categoryId: id, rootCategoryId: id, subCategories: this.data.categories.filter(item => item.parentId === id) });
    void this.load(true);
  },
  onReviewCategory() { if (!this.data.draft) this.onDrafts(); },
  onSubCategory(event: WechatMiniprogram.TouchEvent) {
    const id = idSchema.parse(event.currentTarget.dataset.id);
    this.setData({ categoryId: id });
    void this.load(true);
  },
  onTaxonomy() { wx.navigateTo({ url: `/pages/taxonomy/taxonomy${this.data.rootCategoryId ? `?parentId=${this.data.rootCategoryId}` : ''}` }); },
  onFavorite() { this.setData({ favorite: !this.data.favorite }); void this.load(true); },
  onDrafts() {
    this.setData({ draft: !this.data.draft, archived: false, managing: false, selectedIds: [], categoryId: '', rootCategoryId: '', subCategories: [], favorite: false, q: '', color: '', season: '', occasionIds: '', tagId: '' });
    void this.load(true);
  },
  onArchived() { this.setData({ draft: false, archived: !this.data.archived, managing: false, selectedIds: [] }); void this.load(true); },
  onFilters() {
    this.setData({
      filtersOpen: true, filterFavorite: this.data.favorite, filterSortIndex: this.data.sortIndex,
      filterColors: this.data.filterColors.map(item => ({ ...item, selected: this.data.color.split(',').includes(item.value) })),
      filterSeasons: this.data.filterSeasons.map(item => ({ ...item, selected: this.data.season.split(',').includes(item.value) })),
      filterOccasions: this.data.tags.filter(item => item.kind === 'occasion').map(item => ({ id: item.id, name: item.name, selected: this.data.occasionIds.split(',').includes(item.id) }))
    });
  },
  onCloseFilters() { this.setData({ filtersOpen: false }); },
  onFilterFavorite() { this.setData({ filterFavorite: !this.data.filterFavorite }); },
  onApplyFilters() {
    this.setData({
      favorite: this.data.filterFavorite, filtersOpen: false, sortIndex: this.data.filterSortIndex,
      sort: ['created', 'last-worn', 'wear-count', 'price'][this.data.filterSortIndex],
      color: this.data.filterColors.filter(item => item.selected).map(item => item.value).join(','),
      season: this.data.filterSeasons.filter(item => item.selected).map(item => item.value).join(','),
      occasionIds: this.data.filterOccasions.filter(item => item.selected).map(item => item.id).join(',')
    });
    void this.load(true);
  },
  onClearFilters() {
    this.setData({
      searchOpen: false, q: '', categoryId: '', rootCategoryId: '', subCategories: [], color: '', season: '', occasionIds: '', tagId: '', favorite: false,
      filterFavorite: false, filtersOpen: false, sort: 'created', sortIndex: 0, filterSortIndex: 0,
      filterColors: this.data.filterColors.map(item => ({ ...item, selected: false })),
      filterSeasons: this.data.filterSeasons.map(item => ({ ...item, selected: false })),
      filterOccasions: this.data.filterOccasions.map(item => ({ ...item, selected: false }))
    });
    void this.load(true);
  },
  onWardrobeMenu() {
    if (this.data.managing) { this.onManage(); return; }
    this.setData({ menuOpen: true, menuItems: [
      { id: 'manage', name: '批量整理' },
      { id: 'favorite', name: this.data.favorite ? '显示全部衣物' : '只看收藏' },
      { id: 'archived', name: this.data.archived ? '返回日常衣橱' : '归档衣物' },
      { id: 'tasks', name: '图片处理任务' },
      { id: 'drafts', name: this.data.draft ? '返回日常衣橱' : '待核对衣物' }
    ] });
  },
  onCloseMenu() { this.setData({ menuOpen: false }); },
  onMenuSelect(event: WechatMiniprogram.CustomEvent<SelectDetail>) {
    this.setData({ menuOpen: false });
    if (event.detail.id === 'manage') this.onManage();
    if (event.detail.id === 'favorite') this.onFavorite();
    if (event.detail.id === 'archived') this.onArchived();
    if (event.detail.id === 'tasks') this.onTasks();
    if (event.detail.id === 'drafts') this.onDrafts();
  },
  async onCardFavorite(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.loading) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    const item = this.data.clothes.find(item => item.id === id)!;
    if (item.processing) return;
    this.setData({ busy: true, error: '' });
    try { const result = await updateClothing(this.scope, id, { version: item.version, favorite: !item.favorite }); this.setData({ busy: false, clothes: this.data.clothes.map(item => item.id === id ? { ...item, ...result.data } : item) }); }
    catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        await this.load(true);
        if (this.scope.active) this.setData({ busy: false, error: this.data.error || '衣物资料已更新，请确认后再次点击收藏' });
        return;
      }
      const message = errorMessage(error); if (message) this.setData({ error: message, busy: false });
    }
  },
  onSort(event: WechatMiniprogram.TouchEvent) {
    this.setData({ filterSortIndex: z.coerce.number().int().min(0).max(this.data.sortLabels.length - 1).parse(event.currentTarget.dataset.index) });
  },
  onColor(event: WechatMiniprogram.TouchEvent) {
    const value = z.enum(colors).parse(event.currentTarget.dataset.value);
    this.setData({ filterColors: this.data.filterColors.map(item => ({ ...item, selected: item.value === value ? !item.selected : item.selected })) });
  },
  onSeason(event: WechatMiniprogram.TouchEvent) {
    const value = z.enum(seasons).parse(event.currentTarget.dataset.value);
    this.setData({ filterSeasons: this.data.filterSeasons.map(item => ({ ...item, selected: item.value === value ? !item.selected : item.selected })) });
  },
  onFilterOccasion(event: WechatMiniprogram.TouchEvent) {
    const id = idSchema.parse(event.currentTarget.dataset.id);
    this.setData({ filterOccasions: this.data.filterOccasions.map(item => ({ ...item, selected: item.id === id ? !item.selected : item.selected })) });
  },
  onAdd() { wx.navigateTo({ url: '/pages/clothing-import/clothing-import' }); },
  onImport(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/import-review/import-review?id=${idSchema.parse(event.currentTarget.dataset.id)}` }); },
  onTasks() { wx.navigateTo({ url: '/pages/image-jobs/image-jobs' }); },
  onManage() {
    if (this.data.busy) return;
    this.setData({ managing: !this.data.managing, selectedIds: [], clothes: this.data.clothes.map(item => ({ ...item, selected: false })) });
  },
  onClothing(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    const item = this.data.clothes.find(item => item.id === id)!;
    if (item.processing) return;
    if (!this.data.managing && item.importId && !item.singleImport) { wx.navigateTo({ url: `/pages/import-review/import-review?id=${item.importId}` }); return; }
    if (!this.data.managing) { wx.navigateTo({ url: item.status === 'draft' ? `/pages/clothing-edit/clothing-edit?id=${id}` : `/pages/clothing-detail/clothing-detail?id=${id}` }); return; }
    if (!this.data.selectedIds.includes(id) && this.data.selectedIds.length >= 50) {
      void wx.showToast({ title: '每次最多选择 50 件', icon: 'none' });
      return;
    }
    const selectedIds = this.data.selectedIds.includes(id) ? this.data.selectedIds.filter(value => value !== id) : [...this.data.selectedIds, id];
    this.setData({ selectedIds, clothes: this.data.clothes.map(item => ({ ...item, selected: selectedIds.includes(item.id) })) });
  },
  async onBatch(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.loading || !this.data.selectedIds.length) return;
    const action = z.enum(['archive', 'restore', 'edit', 'delete']).parse(event.currentTarget.dataset.action);
    if (action === 'delete') {
      this.setData({ busy: true });
      const answer = await wx.showModal({ title: `永久删除这 ${this.data.selectedIds.length} 件衣物？`, content: '删除后无法恢复。有搭配、穿搭记录或清单引用时，整批不会删除。', confirmText: '删除', confirmColor: '#c43c3c' });
      if (!this.scope.active) return;
      this.setData({ busy: false });
      if (!answer.confirm) return;
    }
    this.setData({ batchAction: action });
    if (action !== 'edit') { void this.onConfirmBatch(); return; }
    this.setData({ batchOpen: true, batchField: 'categoryId', batchSummary: '请选择分类', batchValues: [], batchRootId: '', batchChildOptions: [], batchOptions: [] });
    void this.loadBatchTaxonomy();
  },
  onCloseBatch() { if (!this.data.busy) this.setData({ batchOpen: false }); },
  onRetryBatchTaxonomy() { if (!this.data.busy && !this.data.batchLoading) void this.loadBatchTaxonomy(); },
  onBatchField(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.batchLoading) return;
    this.setData({ batchError: '', batchField: batchFieldSchema.parse(event.currentTarget.dataset.id), batchValues: [], batchRootId: '', batchChildOptions: [] });
    this.renderBatchOptions();
  },
  onBatchMode(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    this.setData({ batchError: '', batchMode: z.enum(['add', 'remove', 'replace']).parse(event.currentTarget.dataset.id) });
    this.updateBatchSummary();
  },
  onBatchOption(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.batchLoading) return;
    const id = z.string().refine(id => this.data.batchOptions.some(item => item.id === id)).parse(event.currentTarget.dataset.id);
    const values = this.data.batchMultiple
      ? this.data.batchValues.includes(id) ? this.data.batchValues.filter(value => value !== id) : [...this.data.batchValues, id]
      : [id];
    this.setData({ batchError: '', batchValues: values, batchOptions: this.data.batchOptions.map(item => ({ ...item, selected: values.includes(item.id) })),
      ...(this.data.batchField === 'categoryId' ? {
        batchRootId: id, batchChildOptions: this.data.categories.filter(item => item.parentId === id).map(item => ({ id: item.id, name: item.name, selected: false }))
      } : {}) });
    this.updateBatchSummary();
  },
  onBatchChildOption(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    this.setData({ batchError: '', batchValues: [id], batchChildOptions: this.data.batchChildOptions.map(item => ({ ...item, selected: item.id === id })) });
    this.updateBatchSummary();
  },
  renderBatchOptions() {
    const field = this.data.batchField;
    const options = field === 'categoryId' ? this.data.categories.filter(item => !item.parentId)
      : field === 'colors' ? colors.map((id, index) => ({ id, name: colorLabels[index] }))
      : field === 'seasons' ? seasons.map((id, index) => ({ id, name: seasonLabels[index] }))
      : field === 'pattern' ? [{ id: '', name: '清空' }, ...patterns.map((id, index) => ({ id, name: patternLabels[index] }))]
      : field === 'occasion' || field === 'style' ? this.data.tags.filter(item => item.kind === field)
      : [{ id: '', name: '清空' }, ...this.clothingOptions.filter(item => field === 'sizeId' ? item.kind === 'clothing-size' || item.kind === 'shoe-size' : item.kind === (field === 'brandId' ? 'brand' : 'material'))
        .map(item => ({ id: item.id, name: field === 'sizeId' ? `${item.kind === 'shoe-size' ? '鞋码' : '服装'} · ${item.name}` : item.name }))];
    this.setData({ batchOptions: options.map(item => ({ id: item.id, name: item.name, selected: false })), batchMultiple: field === 'colors' || field === 'seasons' || field === 'occasion' || field === 'style' });
    this.updateBatchSummary();
  },
  updateBatchSummary() {
    if (this.data.batchField === 'categoryId') {
      this.setData({ batchSummary: this.data.batchValues.length ? this.data.categories.find(item => item.id === this.data.batchValues[0])!.displayName : '请选择分类' });
      return;
    }
    const names = this.data.batchOptions.filter(item => item.selected).map(item => item.name).join('、');
    const label = BATCH_FIELDS.find(item => item.id === this.data.batchField)!.name;
    const mode = this.data.batchField === 'occasion' || this.data.batchField === 'style' ? this.data.batchModes.find(item => item.id === this.data.batchMode)!.name : '';
    this.setData({ batchSummary: `${mode}${label}：${names || (this.data.batchMultiple && (!mode || this.data.batchMode === 'replace') ? '清空' : '请选择')}` });
  },
  async loadBatchTaxonomy() {
    this.setData({ batchLoading: true, batchTaxonomyError: '', batchError: '', batchValues: [], batchRootId: '', batchChildOptions: [] });
    try {
      const [categories, tags, options] = await Promise.all([listCategories(this.scope), listTags(this.scope), listClothingOptions(this.scope)]);
      if (!this.scope.active) return;
      this.clothingOptions = options.data;
      this.setData({ categories: categories.data, tags: tags.data, batchLoading: false });
      this.renderBatchOptions();
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ batchLoading: false, batchTaxonomyError: message }); }
  },
  async onConfirmBatch() {
    if (this.data.busy || this.data.loading || !this.data.selectedIds.length) return;
    const field = this.data.batchField;
    const tagField = field === 'occasion' || field === 'style';
    const input = clothingBatchSchema.safeParse({
      items: this.data.clothes.filter(item => this.data.selectedIds.includes(item.id)).map(item => ({ id: item.id, version: item.version })),
      action: this.data.batchAction !== 'edit' ? this.data.batchAction : field === 'categoryId' ? 'change-category'
        : tagField ? this.data.batchMode === 'replace' ? 'replace-tags' : this.data.batchMode === 'remove' ? 'remove-tags' : 'add-tags' : 'update-attributes',
      parameters: this.data.batchAction !== 'edit' ? {} : field === 'categoryId' ? { categoryId: this.data.batchValues[0] }
        : tagField ? { tagIds: this.data.batchValues, ...(this.data.batchMode === 'replace' ? { kind: field } : {}) }
        : { [field]: field === 'colors' || field === 'seasons' ? this.data.batchValues : this.data.batchValues[0] || null }
    });
    if (!input.success) { this.setData({ batchError: '请选择要修改的标签' }); return; }
    this.setData({ busy: true, batchError: '' });
    try {
      const result = await batchClothes(this.scope, input.data);
      this.setData({ busy: false, batchOpen: false, selectedIds: [], managing: false }); await this.load(true);
      if (this.scope.active) void wx.showToast({ title: `已${input.data.action === 'delete' ? '删除' : '更新'} ${result.data.affectedCount} 件衣物`, icon: 'none', duration: 2000 });
    } catch (error) {
      const message = errorMessage(error);
      if (!message) return;
      this.setData({ busy: false, batchError: message });
      if (error instanceof ApiError && (error.code === 'VERSION_CONFLICT' || error.code === 'CLOTHING_PROCESSING')) await this.load(true, true);
      if (!this.data.batchOpen) void wx.showToast({ title: message, icon: 'none', duration: 3000 });
    }
  },
  async loadPreferences() {
    try { const user = await getMe(this.scope); if (!this.visible) return; this.setData({ showArchived: user.data.preferences.showArchived || false }); await this.load(true); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, loading: false }); }
  },
  async loadTaxonomy() {
    this.setData({ taxonomyLoading: true, taxonomyError: '' });
    try {
      const [categories, tags] = await Promise.all([listCategories(this.scope), listTags(this.scope)]);
      if (!this.visible) return;
      const rootCategoryId = categories.data.some(item => item.id === this.data.rootCategoryId) ? this.data.rootCategoryId : '';
      const categoryId = categories.data.some(item => item.id === this.data.categoryId) ? this.data.categoryId : rootCategoryId;
      const icons: Record<string, string> = { '上衣': 'shirt', '外套': 'coat', '裤子': 'pants', '裙子': 'skirt', '连衣裙': 'dress', '鞋靴': 'shoe', '箱包': 'bag', '配饰': 'necklace', '眼镜': 'glasses', '帽子': 'hat', '其他': 'category-other' };
      const selectionChanged = categoryId !== this.data.categoryId;
      this.setData({ categories: categories.data, rootCategories: categories.data.filter(item => !item.parentId).map(item => ({ ...item, icon: icons[item.name] || 'project-mark-clasp' })), rootCategoryId, categoryId, subCategories: categories.data.filter(item => item.parentId === rootCategoryId), tags: tags.data, taxonomyLoading: false,
        ...(this.data.filtersOpen ? { filterOccasions: tags.data.filter(item => item.kind === 'occasion').map(item => ({ id: item.id, name: item.name, selected: this.data.filterOccasions.find(option => option.id === item.id)?.selected ?? this.data.occasionIds.split(',').includes(item.id) })) } : {}) });
      if (selectionChanged) void this.load(true);
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ taxonomyError: message, taxonomyLoading: false }); }
  },
  async load(reset: boolean, refresh = false) {
    if (!this.visible || (!reset && this.data.loading)) return;
    clearTimeout(this.timer);
    const generation = ++this.generation;
    const pages = refresh ? Array.from({ length: Math.max(1, this.page) }, (_, index) => index + 1) : [reset ? 1 : this.page + 1];
    this.setData({ loading: !refresh, error: '' });
    try {
      const [results, importResults] = await Promise.all([Promise.all(pages.map(page => listClothes(this.scope, { q: this.data.q, categoryId: this.data.categoryId, favorite: this.data.favorite ? true : undefined, status: this.data.draft ? 'draft' : this.data.archived ? 'archived' : this.data.showArchived ? 'all' : 'wardrobe', colors: this.data.color, seasons: this.data.season, occasionIds: this.data.occasionIds, tagIds: this.data.tagId, sort: this.data.sort, page }))), this.data.draft ? Promise.all(pages.map(page => listClothingImports(this.scope, page, true))) : Promise.resolve([])]);
      if (generation !== this.generation) return;
      const clothes = results.flatMap(result => result.data);
      const imports = importResults.flatMap(result => result.data);
      const existingUrls = new Map([...this.data.clothes.map(item => [item.primaryAssetId, item.imageUrl] as const), ...this.data.imports.map(item => [item.inputAssetId, item.imageUrl] as const)]);
      const urls = await imageUrls(this.scope, [...clothes.map(item => item.primaryAssetId), ...imports.map(item => item.inputAssetId)].filter(id => !existingUrls.has(id)), 'thumbnail');
      if (generation !== this.generation) return;
      this.page = pages[pages.length - 1];
      const nextClothes = [...(reset ? [] : this.data.clothes), ...clothes.map(item => {
        const processing = item.processingStatus === 'queued' || item.processingStatus === 'running';
        return {
          ...item, imageUrl: existingUrls.get(item.primaryAssetId) || urls[item.primaryAssetId],
          selected: !processing && this.data.selectedIds.includes(item.id), processing,
          colorText: item.colors.map(value => colorLabels[colors.indexOf(value)]).join('、'),
          processText: item.processingStatus === 'queued' ? '等待处理' : item.processingPhase || '正在处理中',
          reviewText: item.processingStatus === 'failed' || item.processingStatus === 'cancelled' ? '处理未完成 · 点击核对' : item.status === 'draft' ? '待核对' : ''
        };
      })];
      const nextImports = [...(reset ? [] : this.data.imports), ...imports.map(item => ({ ...item, imageUrl: existingUrls.get(item.inputAssetId) || urls[item.inputAssetId] }))];
      this.setData({ imports: nextImports, importTotal: importResults[0]?.pagination.total || 0, clothes: nextClothes, selectedIds: nextClothes.filter(item => item.selected).map(item => item.id), total: results[0].pagination.total, loading: false, loaded: true });
      if (nextClothes.some(item => item.processing) || nextImports.some(item => item.pending)) this.timer = setTimeout(() => { void this.load(true, true); }, 3000);
    } catch (error) {
      const message = errorMessage(error);
      if (generation !== this.generation || !message) return;
      this.retryReset = reset;
      this.setData({ error: message, loading: false });
    }
  }
});
