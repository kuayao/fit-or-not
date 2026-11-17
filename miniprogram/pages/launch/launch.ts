import { hasSession } from '../../utils/request';

Page({
  onReady() {
    if (hasSession()) {
      wx.switchTab({ url: '/pages/home/home' });
      return;
    }
    wx.redirectTo({ url: '/pages/welcome/welcome' });
  }
});
