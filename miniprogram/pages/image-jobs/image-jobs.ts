import { refreshExpiredImage } from '../../utils/refresh-image';
import { getClothingImport, listImageJobs, listClothingImports, imageUrls, retryImageJob } from '../../api/client';
import type { ClothingImport, ImageJob } from '../../api/contracts';
import { idSchema } from '../../api/contracts';
import { ApiError, RequestScope, errorMessage, requireSession } from '../../utils/request';
import { prepareImageJobRetry } from '../../utils/image-job-retry';
import type { ImageJobRetryAttempt } from '../../utils/image-job-retry';

const STEP_LABELS = { queued: '等待中', running: '处理中', succeeded: '已完成', failed: '未完成', skipped: '已跳过' };

Page({
  scope: new RequestScope(), timer: 0, visible: true, page: 0, opening: false,
  retryAttempts: new Map<string, ImageJobRetryAttempt>(),
  data: { imports: Array<ClothingImport & { imageUrl: string; statusText: string }>(), importTotal: 0, jobs: Array<ImageJob & { imageUrl: string; resultUrl: string; statusText: string; pending: boolean; recognitionText: string; cutoutText: string }>(), loading: false, busy: false, error: '', total: 0 },
  onLoad() { this.scope = new RequestScope(); this.retryAttempts = new Map(); if (requireSession()) void this.load(true); },
  onShow() { this.visible = true; if (this.scope.hasShown && requireSession()) void this.load(true); this.scope.hasShown = true; },
  onHide() { this.visible = false; clearTimeout(this.timer); },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => { this.setData({ imports: this.data.imports.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl })), jobs: this.data.jobs.map(item => ({ ...item, imageUrl: item.imageUrl === oldUrl ? url : item.imageUrl, resultUrl: item.resultUrl === oldUrl ? url : item.resultUrl })) }); }, message => this.setData({ error: message }));
  },
  onUnload() { this.visible = false; clearTimeout(this.timer); this.scope.close(); },
  onReachBottom() { if (!this.data.loading && (this.data.jobs.length < this.data.total || this.data.imports.length < this.data.importTotal)) void this.load(false); },
  async onImport(event: WechatMiniprogram.TouchEvent) {
    if (this.opening) return;
    this.opening = true;
    try {
      const record = (await getClothingImport(this.scope, idSchema.parse(event.currentTarget.dataset.id))).data;
      const clothing = record.mode === 'single' && !record.saveAsSet && record.items.length === 1 ? record.items[0].clothing : null;
      wx.navigateTo({ url: clothing ? `/pages/clothing-edit/clothing-edit?id=${clothing.id}` : `/pages/import-review/import-review?id=${record.id}` });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message }); }
    finally { this.opening = false; }
  },
  onJob(event: WechatMiniprogram.TouchEvent) { const id = idSchema.parse(event.currentTarget.dataset.id); const job = this.data.jobs.find(item => item.id === id)!; if (job.clothingId) wx.navigateTo({ url: `/pages/clothing-edit/clothing-edit?id=${job.clothingId}` }); },
  onRetry() { void this.load(true); },
  async onRetryJob(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const id = idSchema.parse(event.currentTarget.dataset.id);
    this.setData({ busy: true, error: '' });
    try {
      const attempt = this.retryAttempts.get(id) || await prepareImageJobRetry(this.scope, id);
      if (!attempt) { this.setData({ busy: false }); return; }
      this.retryAttempts.set(id, attempt);
      await retryImageJob(this.scope, id, attempt.key, attempt.confirmUncertain);
      this.retryAttempts.delete(id);
      this.setData({ busy: false });
      await this.load(true);
    } catch (error) {
      if (error instanceof ApiError && !['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(error.code)) this.retryAttempts.delete(id);
      const message = errorMessage(error); if (message) this.setData({ busy: false, error: message });
    }
  },
  async load(reset: boolean) {
    if (this.data.loading) return;
    clearTimeout(this.timer);
    this.setData({ loading: true, error: '' });
    try {
      const pages = reset ? Array.from({ length: Math.max(1, this.page) }, (_, index) => index + 1) : [this.page + 1];
      const [results, imports] = await Promise.all([Promise.all(pages.map(page => listImageJobs(this.scope, page))), Promise.all(pages.map(page => listClothingImports(this.scope, page)))]);
      const records = imports.flatMap(result => result.data);
      const jobs = results.flatMap(result => result.data);
      const urls = await imageUrls(this.scope, [...records.map(item => item.inputAssetId), ...jobs.flatMap(item => [item.inputAssetId, item.result?.cutoutAssetId].filter((id): id is string => Boolean(id)))], 'thumbnail');
      if (!this.visible) { this.setData({ loading: false }); return; }
      const labels = { queued: '等待处理', running: '处理中', succeeded: '已完成', failed: '未完成', cancelled: '已取消' };
      this.page = pages[pages.length - 1];
      this.setData({ imports: [...(reset ? [] : this.data.imports), ...records.map(item => ({ ...item, imageUrl: urls[item.inputAssetId], statusText: item.status === 'cancelled' ? '已取消' : item.pending ? '处理中' : item.status === 'needs-attention' ? '识别未完成' : '待核对' }))], importTotal: imports[0].pagination.total, jobs: [...(reset ? [] : this.data.jobs), ...jobs.map(item => ({
        ...item, imageUrl: item.inputAssetId ? urls[item.inputAssetId] : '', resultUrl: item.result?.cutoutAssetId ? urls[item.result.cutoutAssetId] : '',
        statusText: item.result?.outcome === 'partial' ? '部分完成' : labels[item.status],
        pending: item.status === 'queued' || item.status === 'running',
        recognitionText: item.result?.steps ? STEP_LABELS[item.result.steps.recognition.status] : '',
        cutoutText: item.result?.steps ? STEP_LABELS[item.result.steps.cutout.status] : ''
      }))], loading: false, total: results[0].pagination.total });
      if (this.visible && (this.data.jobs.some(item => item.pending) || this.data.imports.some(item => item.pending))) this.timer = setTimeout(() => { void this.load(true); }, 3000);
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, loading: false }); }
  }
});
