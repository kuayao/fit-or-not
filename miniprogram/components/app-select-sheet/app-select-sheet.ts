import { z } from 'zod';

export type SelectDetail = { id: string; index: number };

Component({
  options: { multipleSlots: true, styleIsolation: 'apply-shared' },
  properties: {
    visible: Boolean, title: String, value: String, loading: Boolean, error: String, hint: String,
    items: { type: Array, value: Array<{ id: string; name: string }>() },
    emptyText: { type: String, value: '还没有可选项' }
  },
  methods: {
    onClose() { this.triggerEvent('close'); },
    onRetry() { this.triggerEvent('retry'); },
    onSelect(event: WechatMiniprogram.TouchEvent) {
      const index = z.coerce.number().int().min(0).max(this.properties.items.length - 1).parse(event.currentTarget.dataset.index);
      this.triggerEvent('select', { id: this.properties.items[index].id, index });
    }
  }
});
