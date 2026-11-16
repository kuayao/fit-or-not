import { z } from 'zod';
import { getMe, updateMe, uploadPhoto, imageUrls } from '../../api/client';
import { userInputSchema } from '../../api/contracts';
import { RequestScope, requireSession, errorMessage } from '../../utils/request';
import { refreshExpiredImage } from '../../utils/refresh-image';

Page({
  scope: new RequestScope(), version: 0, avatarPath: '', avatarAssetId: '',
  data: { fromLogin: false, nickname: '', avatarUrl: '', loading: true, loaded: false, busy: false, error: '', nicknameError: '' },
  onLoad(options) {
    this.scope = new RequestScope();
    this.setData({ fromLogin: z.object({ from: z.literal('login').optional() }).parse(options).from === 'login' });
    if (requireSession()) void this.load();
  },
  onUnload() { this.scope.close(); },
  onRetry() { if (!this.data.loading) void this.load(); },
  onChooseAvatar(event: WechatMiniprogram.CustomEvent<{ avatarUrl: unknown }>) {
    if (this.data.busy || !this.data.loaded) return;
    const selected = z.object({ avatarUrl: z.string().min(1) }).safeParse(event.detail);
    if (!selected.success) { this.setData({ error: '头像读取失败，请重新选择' }); return; }
    this.avatarPath = selected.data.avatarUrl;
    this.setData({ avatarUrl: selected.data.avatarUrl, error: '' });
  },
  onImageError(event: WechatMiniprogram.ImageError) {
    void refreshExpiredImage(this.scope, event, (oldUrl, url) => {
      if (this.data.avatarUrl === oldUrl) this.setData({ avatarUrl: url });
    }, message => this.setData({ error: message }));
  },
  onLeave() {
    if (this.data.busy) return;
    if (this.data.fromLogin) { wx.switchTab({ url: '/pages/home/home' }); return; }
    wx.navigateBack();
  },
  async onSave(event: WechatMiniprogram.CustomEvent<{ value: unknown }>) {
    if (this.data.busy || !this.data.loaded) return;
    const input = userInputSchema.pick({ nickname: true }).required().safeParse(event.detail.value);
    if (!input.success) { this.setData({ nicknameError: '昵称需要 1–30 个字' }); return; }
    this.setData({ busy: true, error: '', nicknameError: '' });
    try {
      if (this.avatarPath) {
        const uploaded = await uploadPhoto(this.scope, this.avatarPath, 'avatar');
        this.avatarAssetId = uploaded.data.assetId;
        this.avatarPath = '';
      }
      await updateMe(this.scope, { version: this.version, nickname: input.data.nickname, ...(this.avatarAssetId ? { avatarAssetId: this.avatarAssetId } : {}) });
      this.setData({ busy: false });
      this.onLeave();
    } catch (error) {
      const message = errorMessage(error);
      if (message) this.setData({ error: message, busy: false });
    }
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await getMe(this.scope);
      const urls = result.data.avatarAssetId ? await imageUrls(this.scope, [result.data.avatarAssetId], 'thumbnail') : {};
      this.version = result.data.version;
      this.setData({ nickname: result.data.nickname === '新成员' ? '' : result.data.nickname, avatarUrl: result.data.avatarAssetId ? urls[result.data.avatarAssetId] : '', loading: false, loaded: true });
    } catch (error) {
      const message = errorMessage(error);
      if (message) this.setData({ error: message, loading: false });
    }
  }
});
