import { requireSession } from '../../utils/request';

Page({
  onLoad() { if (requireSession()) wx.switchTab({ url: '/pages/home/home' }); }
});
