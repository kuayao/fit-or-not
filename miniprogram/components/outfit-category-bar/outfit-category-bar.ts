import { z } from 'zod';
import { idSchema, outfitCategoryInputSchema } from '../../api/contracts';
import type { OutfitCategory } from '../../api/contracts';

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    items: { type: Array, value: Array<OutfitCategory>() },
    value: { type: String, value: '', observer() { this.setData({ adding: false }); } },
    all: Boolean, list: Boolean, loading: Boolean, error: String, busy: Boolean, createError: String
  },
  data: { adding: false, name: '', inputError: '', submitted: false },
  methods: {
    onSelect(event: WechatMiniprogram.TouchEvent) {
      if (this.properties.busy) return;
      this.triggerEvent('select', { id: z.union([idSchema, z.literal('')]).parse(event.currentTarget.dataset.id) });
    },
    onAdd() { this.setData({ adding: true, name: '', inputError: '', submitted: false }); },
    onClose() { if (!this.properties.busy) this.setData({ adding: false }); },
    onInput(event: WechatMiniprogram.Input) { this.setData({ name: event.detail.value, inputError: '', submitted: false }); },
    onRetry() { this.triggerEvent('retry'); },
    onCreate() {
      if (this.properties.busy) return;
      const input = outfitCategoryInputSchema.safeParse({ name: this.data.name });
      if (!input.success) { this.setData({ inputError: input.error.issues[0].message }); return; }
      this.setData({ submitted: true });
      this.triggerEvent('create', input.data);
    }
  }
});
