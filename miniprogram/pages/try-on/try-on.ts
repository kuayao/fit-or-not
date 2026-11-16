import { z } from 'zod';
import { idSchema } from '../../api/contracts';
import { getCapabilities, listOutfits } from '../../api/client';
import { RequestScope, requireSession, errorMessage } from '../../utils/request';

Page({
  scope: new RequestScope(), page: 0, loadingOutfits: false,
  data: { outfits: Array<{ id: string; name: string }>(), outfitId: '', reason: '', loading: false, error: '', total: 0 },
  onLoad(options) { this.scope = new RequestScope(); if (!requireSession()) return; const input = z.object({ outfitId: idSchema.optional() }).parse(options); this.setData({ outfitId: input.outfitId || '' }); void this.load(); },
  onUnload() { this.scope.close(); },
  onRetry() { void this.load(); },
  onOutfit(event: WechatMiniprogram.TouchEvent) { this.setData({ outfitId: idSchema.parse(event.currentTarget.dataset.id) }); },
  onMore() { void this.loadOutfits(); },
  async loadOutfits() {
    if (this.loadingOutfits) return;
    this.loadingOutfits = true;
    try { const result = await listOutfits(this.scope, { page: this.page + 1 }); this.page++; this.setData({ outfits: [...this.data.outfits, ...result.data.map(item => ({ id: item.id, name: item.name }))], total: result.pagination.total }); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message }); }
    finally { this.loadingOutfits = false; }
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try { const result = await getCapabilities(this.scope); this.setData({ reason: result.data.tryOn.reason }); if (!this.page) await this.loadOutfits(); this.setData({ loading: false }); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, loading: false }); }
  }
});
