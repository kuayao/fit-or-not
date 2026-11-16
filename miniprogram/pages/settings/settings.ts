import { z } from 'zod';
import { getMe, updateMe, getCapabilities, logout, deleteMe, createDataExport, getDataExport, imageUrls } from '../../api/client';
import { RequestScope, requireSession, errorMessage, clearSession, requestKey } from '../../utils/request';

Page({
  scope: new RequestScope(), version: 0, exportId: '', exportAssetId: '', exportKey: '', timer: 0, visible: true,
  data: { nickname: '', showServices: false, showDataInfo: false, cityCode: '', showArchived: false, loading: false, busy: false, error: '', exportStatus: '', exportReady: false,
    services: Array<{ name: string; available: boolean; reason: string }>()
  },
  onLoad() { this.scope = new RequestScope(); this.exportKey = requestKey(); if (requireSession()) void this.load(); },
  onShow() { this.visible = true; if (this.exportId && !this.data.exportReady) void this.pollExport(); },
  onHide() { this.visible = false; clearTimeout(this.timer); },
  onUnload() { this.visible = false; clearTimeout(this.timer); this.scope.close(); },
  onCity(event: WechatMiniprogram.Input) { this.setData({ cityCode: event.detail.value }); },
  onArchived(event: WechatMiniprogram.SwitchChange) { this.setData({ showArchived: event.detail.value }); },
  onRetry() { void this.load(); },
  onServices() { this.setData({ showServices: true }); },
  onCloseServices() { this.setData({ showServices: false }); },
  onDataInfo() { this.setData({ showDataInfo: !this.data.showDataInfo }); },
  async onNickname() {
    if (this.data.busy) return;
    const answer = await wx.showModal({ title: '修改昵称', editable: true, content: this.data.nickname, placeholderText: '1–30 个字' });
    if (!answer.confirm || !this.scope.active) return;
    if (!answer.content.trim() || answer.content.length > 30) { this.setData({ error: '昵称需要 1–30 个字' }); return; }
    this.setData({ busy: true, error: '' });
    try { const result = await updateMe(this.scope, { version: this.version, nickname: answer.content.trim() }); this.version = result.data.version; this.setData({ nickname: result.data.nickname, busy: false }); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async onSave() {
    if (this.data.busy) return; this.setData({ busy: true, error: '' });
    try { const result = await updateMe(this.scope, { version: this.version, cityCode: this.data.cityCode, preferences: { showArchived: this.data.showArchived } }); this.version = result.data.version; this.setData({ busy: false }); wx.showToast({ title: '设置已保存', icon: 'none' }); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async onExport() {
    if (this.data.busy) return; this.setData({ busy: true, error: '' });
    try {
      const result = await createDataExport(this.scope, this.exportKey); this.exportId = result.data.id;
      this.setData({ busy: false, exportStatus: '正在整理本人的数据与图片…', exportReady: false }); await this.pollExport();
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async onDownload() {
    if (this.data.busy || !this.exportAssetId) return; this.setData({ busy: true, error: '' });
    try {
      const urls = await imageUrls(this.scope, [this.exportAssetId], 'original'); const url = urls[this.exportAssetId];
      const result = await new Promise<WechatMiniprogram.DownloadFileSuccessCallbackResult>((resolve, reject) => wx.downloadFile({ url, success: resolve, fail: reject }));
      if (result.statusCode !== 200) throw new Error('download failed');
      if (!this.scope.active) return;
      await new Promise<void>((resolve, reject) => wx.shareFileMessage({ filePath: result.tempFilePath, fileName: '我的衣橱数据.zip', success: () => resolve(), fail: reject }));
      if (this.scope.active) this.setData({ busy: false });
    } catch (error) {
      const cancel = z.object({ errMsg: z.string() }).safeParse(error);
      if (cancel.success && cancel.data.errMsg.includes('cancel')) { this.setData({ busy: false }); return; }
      const message = errorMessage(error); if (message && this.scope.active) this.setData({ error: message, busy: false });
    }
  },
  async onLogout() {
    if (this.data.busy) return; this.setData({ busy: true, error: '' });
    try { await logout(this.scope); clearSession(); wx.reLaunch({ url: '/pages/welcome/welcome' }); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async onDelete() {
    if (this.data.busy) return;
    const answer = await wx.showModal({ title: '注销账号并清理全部数据？', content: '衣物、搭配、记录和图片将被清理；备份按保留周期到期处理。此操作无法在应用中恢复。', confirmText: '注销账号', confirmColor: '#A54842' });
    if (!answer.confirm || !this.scope.active) return; this.setData({ busy: true, error: '' });
    try { await deleteMe(this.scope); clearSession(); wx.reLaunch({ url: '/pages/welcome/welcome' }); }
    catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, busy: false }); }
  },
  async pollExport() {
    clearTimeout(this.timer);
    try {
      const result = await getDataExport(this.scope, this.exportId);
      if (result.data.status === 'succeeded' && (!result.data.assetId || Date.parse(result.data.expiresAt || '') <= Date.now())) {
        this.exportAssetId = ''; this.exportKey = requestKey(); this.exportId = '';
        this.setData({ exportStatus: '导出文件已过期，请重新导出', exportReady: false }); return;
      }
      if (result.data.status === 'succeeded') { this.exportAssetId = result.data.assetId || ''; this.exportKey = requestKey(); this.setData({ exportStatus: '导出已完成，文件 24 小时后过期', exportReady: true }); return; }
      if (result.data.status === 'failed') { this.setData({ exportStatus: '导出失败，请重试', error: result.data.errorCode || '导出失败' }); this.exportKey = requestKey(); return; }
      if (this.visible) this.timer = setTimeout(() => { void this.pollExport(); }, 3000);
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message }); }
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const [user, capabilities] = await Promise.all([getMe(this.scope), getCapabilities(this.scope)]); this.version = user.data.version;
      this.setData({ nickname: user.data.nickname, cityCode: user.data.cityCode, showArchived: user.data.preferences.showArchived || false, services: [ { name: 'AI 抠图与识别', ...capabilities.data.imageProcessing }, { name: '高德天气', ...capabilities.data.weather }, { name: 'AI 搭配', ...capabilities.data.recommendation }, { name: '虚拟试穿', ...capabilities.data.tryOn } ], loading: false });
    } catch (error) { const message = errorMessage(error); if (message) this.setData({ error: message, loading: false }); }
  }
});
