import { z } from 'zod';

Component({
  options: { styleIsolation: 'apply-shared' },
  data: { selected: 1, tabs: [
    { path: '/pages/home/home', label: '首页', icon: 'home' },
    { path: '/pages/wardrobe/wardrobe', label: '衣橱', icon: 'shirt' },
    { path: '/pages/outfits/outfits', label: '搭配', icon: 'layers' },
    { path: '/pages/profile/profile', label: '我的', icon: 'user' }
  ] },
  methods: {
    onAdd() {
      wx.navigateTo({ url: '/pages/clothing-import/clothing-import' });
    },
    onChange(event: WechatMiniprogram.TouchEvent) {
      const index = z.coerce.number().int().min(0).max(3).parse(event.currentTarget.dataset.index);
      wx.switchTab({ url: this.data.tabs[index].path });
    }
  }
});
