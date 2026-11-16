import { loginWithWechat, redeemInvitation } from '../../api/client';
import type { loginSchema } from '../../api/contracts';
import type { z } from 'zod';
import { RequestScope, errorMessage, hasSession, saveSession } from '../../utils/request';

Page({
  scope: new RequestScope(), registrationToken: '',
  data: { busy: false, error: '', requiresInvitation: false, invitationCode: '' },
  onLoad() {
    this.scope = new RequestScope();
    if (hasSession()) wx.switchTab({ url: '/pages/home/home' });
  },
  onUnload() { this.scope.close(); },
  onInvitationInput(event: WechatMiniprogram.Input) { this.setData({ invitationCode: event.detail.value }); },
  onSubmit() { if (this.data.requiresInvitation) { void this.onRedeem(); return; } void this.onLogin(); },
  async onLogin() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      const login = await wx.login({ timeout: 10000 });
      const response = await loginWithWechat(this.scope, login.code);
      this.finishLogin(response.data);
    } catch (error) {
      const message = errorMessage(error);
      if (message) this.setData({ error: message, busy: false });
    }
  },
  async onRedeem() {
    if (this.data.busy) return;
    if (!this.data.invitationCode.trim()) { this.setData({ error: '请输入邀请码' }); return; }
    this.setData({ busy: true, error: '' });
    try {
      const response = await redeemInvitation(this.scope, this.registrationToken, this.data.invitationCode.trim());
      this.finishLogin(response.data);
    } catch (error) {
      const message = errorMessage(error);
      if (message) this.setData({ error: message, busy: false });
    }
  },
  finishLogin(result: z.infer<typeof loginSchema>) {
    if ('token' in result) {
      saveSession(result.token);
      this.setData({ busy: false });
      if (result.user.nickname === '新成员' || !result.user.avatarAssetId) {
        wx.redirectTo({ url: '/pages/profile-edit/profile-edit?from=login' });
        return;
      }
      wx.switchTab({ url: '/pages/home/home' });
      return;
    }
    this.registrationToken = result.registrationToken;
    this.setData({ requiresInvitation: true, busy: false });
  }
});
