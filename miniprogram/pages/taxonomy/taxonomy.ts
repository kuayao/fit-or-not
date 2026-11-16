import { z } from 'zod';
import { listCategories, listTags, createCategory, createTag, updateCategory, updateTag, deleteTaxonomy, reorderTaxonomy, updateCategorySizeKind, listClothingOptions, createClothingOption, updateClothingOption, deleteClothingOption, reorderClothingOptions } from '../../api/client';
import { idSchema, sizeKindSchema } from '../../api/contracts';
import type { Category, ClothingOption } from '../../api/contracts';
import { RequestScope, requireSession, errorMessage } from '../../utils/request';

const optionKinds = ['brand', 'clothing-size', 'shoe-size', 'material'] as const;

Page({
  scope: new RequestScope(),
  data: { visibleCount: 0, activeName: '', activeType: 'categories', activeRootCategory: false, sizeKindOpen: false, activeSizeKind: '', sizeKinds: [{ value: 'clothing-size', label: '服装尺码', hint: 'S、M、L、XL' }, { value: 'shoe-size', label: '鞋码', hint: '36、37、38、39' }], sortRevision: 0, expandedId: '', categories: Array<Category>(), rootCategories: Array<Category>(), subCategories: Array<Category>(), rootCategoryId: '', tags: Array<{ id: string; name: string; kind: string; version: number; sortOrder: number }>(), options: Array<ClothingOption>(), visibleItems: Array<{ id: string; name: string; version: number; sortOrder: number }>(), loading: false, busy: false, error: '', kindIndex: 0, kinds: ['衣物分类', '场景标签', '风格标签', '品牌', '服装尺码', '鞋码', '面料'] },
  onLoad(options) {
    this.scope = new RequestScope();
    if (!requireSession()) return;
    const input = z.object({ parentId: idSchema.optional(), kind: z.enum(optionKinds).optional() }).parse(options);
    this.setData({ rootCategoryId: input.parentId || '', kindIndex: input.kind ? optionKinds.indexOf(input.kind) + 3 : 0 });
    void this.load();
  },
  onUnload() { this.scope.close(); },
  onRetry() { void this.load(); },
  onKindTab(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.loading) return;
    const kindIndex = z.coerce.number().int().min(0).max(6).parse(event.currentTarget.dataset.index);
    const visibleItems = kindIndex > 2 ? this.data.options.filter(item => item.kind === optionKinds[kindIndex - 3]) : this.data.tags.filter(item => item.kind === (kindIndex === 1 ? 'occasion' : 'style'));
    this.setData({ kindIndex, expandedId: '', visibleItems, visibleCount: kindIndex === 0 ? this.data.categories.length : visibleItems.length });
  },
  onExpand(event: WechatMiniprogram.CustomEvent<{ id: string }>) {
    if (this.data.busy) return;
    this.setData({ activeRootCategory: this.data.kindIndex === 0 && this.data.rootCategories.some(item => item.id === event.detail.id), activeSizeKind: this.data.rootCategories.find(item => item.id === event.detail.id)?.sizeKind || '', expandedId: event.detail.id, activeName: (this.data.kindIndex === 0 ? this.data.categories : this.data.visibleItems).find(item => item.id === event.detail.id)!.name, activeType: this.data.kindIndex === 0 ? 'categories' : this.data.kindIndex > 2 ? 'clothing-options' : 'tags' });
  },
  onCloseActions() { if (!this.data.busy) this.setData({ expandedId: '', sizeKindOpen: false }); },
  onOpenSizeKind() { this.setData({ sizeKindOpen: true }); },
  onCloseSizeKind() { if (!this.data.busy) this.setData({ sizeKindOpen: false }); },
  async onSizeKind(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const sizeKind = sizeKindSchema.parse(event.currentTarget.dataset.kind);
    const category = this.data.rootCategories.find(item => item.id === this.data.expandedId)!;
    this.setData({ busy: true, error: '' });
    try {
      await updateCategorySizeKind(this.scope, category.id, { version: category.version, sizeKind });
      this.setData({ busy: false, sizeKindOpen: false, expandedId: '' });
      await this.load();
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  onRootCategory(event: WechatMiniprogram.CustomEvent<{ id: string }>) {
    if (this.data.busy) return;
    this.setData({ rootCategoryId: event.detail.id, subCategories: this.data.categories.filter(item => item.parentId === event.detail.id) });
  },
  async onAdd(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.loading) return;
    const parentId = this.data.kindIndex === 0 ? z.union([idSchema, z.literal('')]).parse(event.currentTarget.dataset.parentId) : '';
    const maxLength = this.data.kindIndex > 2 ? 100 : 30;
    const answer = await wx.showModal({ title: this.data.kindIndex === 0 ? parentId ? '添加二级分类' : '添加一级分类' : `新增${this.data.kinds[this.data.kindIndex]}`, editable: true, placeholderText: this.data.kindIndex === 4 ? '例如 S、M、L、XL；每次添加一项' : this.data.kindIndex === 5 ? '例如 36、37、38；每次添加一项' : `1–${maxLength} 个字` });
    if (!answer.confirm || !this.scope.active) return;
    if (!answer.content.trim() || answer.content.trim().length > maxLength) { this.setData({ error: `名称需要 1–${maxLength} 个字` }); return; }
    this.setData({ busy: true, error: '' });
    try {
      if (this.data.kindIndex === 0) await createCategory(this.scope, answer.content.trim(), parentId || null);
      if (this.data.kindIndex === 1 || this.data.kindIndex === 2) await createTag(this.scope, answer.content.trim(), this.data.kindIndex === 1 ? 'occasion' : 'style');
      if (this.data.kindIndex > 2) await createClothingOption(this.scope, answer.content.trim(), optionKinds[this.data.kindIndex - 3]);
      this.setData({ busy: false, expandedId: '' }); await this.load();
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async onRename(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const input = z.object({ id: idSchema, type: z.enum(['categories', 'tags', 'clothing-options']) }).parse(event.currentTarget.dataset);
    const item = (input.type === 'categories' ? this.data.categories : this.data.visibleItems).find(value => value.id === input.id);
    if (!item) return;
    const maxLength = input.type === 'clothing-options' ? 100 : 30;
    const answer = await wx.showModal({ title: '重命名', editable: true, content: item.name, placeholderText: `1–${maxLength} 个字` });
    if (!answer.confirm || !this.scope.active) return;
    if (!answer.content.trim() || answer.content.trim().length > maxLength) { this.setData({ error: `名称需要 1–${maxLength} 个字` }); return; }
    this.setData({ busy: true, error: '' });
    try {
      if (input.type === 'categories') await updateCategory(this.scope, item.id, { version: item.version, name: answer.content.trim() });
      if (input.type === 'tags') await updateTag(this.scope, item.id, { version: item.version, name: answer.content.trim() });
      if (input.type === 'clothing-options') await updateClothingOption(this.scope, item.id, { version: item.version, name: answer.content.trim() });
      this.setData({ busy: false, expandedId: '' }); await this.load();
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async onReorder(event: WechatMiniprogram.CustomEvent<{ ids: string[] }>) {
    if (this.data.busy) return;
    if (this.data.kindIndex > 2) {
      this.setData({ busy: true, error: '' });
      try {
        await reorderClothingOptions(this.scope, optionKinds[this.data.kindIndex - 3], event.detail.ids.map(id => ({ id, version: this.data.visibleItems.find(item => item.id === id)!.version })));
        await this.load();
        if (this.scope.active) this.setData({ busy: false });
      } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false, sortRevision: this.data.sortRevision + 1 }); }
      return;
    }
    const type = this.data.kindIndex === 0 ? 'categories' : 'tags';
    const items = type === 'categories' ? this.data.categories : this.data.tags;
    const reordered = event.detail.ids.map(id => items.find(item => item.id === id)!);
    const ordered = items.map(item => event.detail.ids.includes(item.id) ? reordered.shift()! : item);
    this.setData({ busy: true, error: '' });
    try {
      await reorderTaxonomy(this.scope, type, ordered.map(item => ({ id: item.id, version: item.version })));
      await this.load();
      if (this.scope.active) this.setData({ busy: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false, sortRevision: this.data.sortRevision + 1 }); }
  },
  async onDelete(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const input = z.object({ id: idSchema, type: z.enum(['categories', 'tags', 'clothing-options']) }).parse(event.currentTarget.dataset);
    const answer = await wx.showModal({ title: '删除这一项？', content: input.type === 'categories' ? '正在使用的分类需先在衣橱中批量迁移衣物，再删除。' : input.type === 'clothing-options' ? '正在使用的品牌、尺码或面料，需先在衣物中更换或清空后再删除。' : '衣物上的关联会移除，历史场景文本会保留。', confirmText: '删除' });
    if (!answer.confirm || !this.scope.active) return;
    this.setData({ busy: true, error: '' });
    try {
      if (input.type === 'clothing-options') await deleteClothingOption(this.scope, input.id);
      if (input.type !== 'clothing-options') await deleteTaxonomy(this.scope, input.type, input.id);
      this.setData({ busy: false, expandedId: '' }); await this.load();
    }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const [categories, tags, options] = await Promise.all([listCategories(this.scope), listTags(this.scope), listClothingOptions(this.scope)]);
      const rootCategories = categories.data.filter(item => !item.parentId);
      const rootCategoryId = rootCategories.some(item => item.id === this.data.rootCategoryId) ? this.data.rootCategoryId : rootCategories[0]?.id || '';
      const visibleItems = this.data.kindIndex > 2 ? options.data.filter(item => item.kind === optionKinds[this.data.kindIndex - 3]) : tags.data.filter(item => item.kind === (this.data.kindIndex === 1 ? 'occasion' : 'style'));
      this.setData({ categories: categories.data, rootCategories, rootCategoryId, subCategories: categories.data.filter(item => item.parentId === rootCategoryId), tags: tags.data, options: options.data, visibleItems, visibleCount: this.data.kindIndex === 0 ? categories.data.length : visibleItems.length, loading: false });
    }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, loading: false }); }
  }
});
