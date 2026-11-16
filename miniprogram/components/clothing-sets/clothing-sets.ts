import { z } from 'zod';
import { idSchema } from '../../api/contracts';
import type { ClothingSet } from '../../api/contracts';
import { imageUrls, listClothingSets } from '../../api/client';
import { RequestScope, errorMessage } from '../../utils/request';
import { refreshExpiredImage } from '../../utils/refresh-image';
const states = new WeakMap<object, { scope: RequestScope; page: number; generation: number }>();
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { refresh: { type: Number, value: 0, observer() { if (states.has(this)) void this.load(true); } } },
  data: { sets: Array<ClothingSet & { imageUrl: string; previewUrls: { id: string; url: string }[] }>(), q: '', total: 0, loading: false, loaded: false, error: '' },
  lifetimes: { attached() { states.set(this, { scope: new RequestScope(), page: 0, generation: 0 }); void this.load(true); }, detached() { states.get(this)!.generation++; states.get(this)!.scope.close(); } },
  methods: {
    onInput(event: WechatMiniprogram.Input) { this.setData({ q: event.detail.value }); },
    onSearch() { void this.load(true); },
    onMore() { if (!this.data.loading && this.data.sets.length < this.data.total) void this.load(false); },
    onCreate() { wx.navigateTo({ url: '/pages/clothing-set/clothing-set' }); },
    onSet(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/clothing-set/clothing-set?id=${idSchema.parse(event.currentTarget.dataset.id)}` }); },
    onImageError(event: WechatMiniprogram.ImageError) { void refreshExpiredImage(states.get(this)!.scope, event, (oldUrl, url) => this.setData({ sets: this.data.sets.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl, previewUrls: item.previewUrls.map(preview => ({ ...preview, url: preview.url === oldUrl ? url : preview.url })) })) }), message => this.setData({ error: message })); },
    async load(reset: boolean) {
      if (!reset && this.data.loading) return;
      const state = states.get(this)!;
      const generation = ++state.generation;
      this.setData({ loading: true, error: '' });
      try {
        const page = reset ? 1 : state.page + 1;
        const result = await listClothingSets(state.scope, page, this.data.q);
        const urls = await imageUrls(state.scope, result.data.flatMap(item => [...(item.coverAssetId ? [item.coverAssetId] : []), ...item.members.slice(0, 2).map(member => member.primaryAssetId)]), 'thumbnail');
        if (generation !== state.generation) return;
        state.page = page;
        this.setData({ loading: false, loaded: true, total: result.pagination.total, sets: [...(reset ? [] : this.data.sets), ...result.data.map(item => ({ ...item, imageUrl: item.coverAssetId ? urls[item.coverAssetId] : '', previewUrls: item.members.slice(0, 2).map(member => ({ id: member.id, url: urls[member.primaryAssetId] })) }))] });
      } catch (error) { const message = errorMessage(error); if (message && generation === state.generation) this.setData({ loading: false, error: message }); }
    }
  }
});
