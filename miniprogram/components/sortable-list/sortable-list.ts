import { z } from 'zod';

type SortableItem = { id: string; name: string };
type Layout = { stepX: number; stepY: number; width: number };
type Gesture = Layout & { index: number; target: number; x: number; y: number };
const gestures = new WeakMap<object, Gesture>();
const layouts = new WeakMap<object, Layout>();
const attached = new WeakSet<object>();

Component({
  properties: {
    items: { type: Array, value: Array<SortableItem>() },
    columns: { type: Number, value: 1 },
    selectedId: String, icon: String, disabled: Boolean, revision: Number
  },
  data: { rows: Array<SortableItem & { style: string }>(), draggingId: '', dropStyle: '' },
  observers: {
    'items, columns, revision'() {
      gestures.delete(this);
      this.setData({ rows: this.properties.items.map(item => ({ ...item, style: '' })), draggingId: '', dropStyle: '' }, () => {
        if (attached.has(this)) this.measure();
      });
    }
  },
  lifetimes: {
    ready() { attached.add(this); this.measure(); },
    detached() { attached.delete(this); gestures.delete(this); layouts.delete(this); }
  },
  methods: {
    onSelect(event: WechatMiniprogram.TouchEvent) {
      if (!this.properties.disabled && !this.data.draggingId) this.triggerEvent('select', { id: z.string().min(1).parse(event.currentTarget.dataset.id) });
    },
    onActions(event: WechatMiniprogram.TouchEvent) {
      if (!this.properties.disabled && !this.data.draggingId) this.triggerEvent('actions', { id: z.string().min(1).parse(event.currentTarget.dataset.id) });
    },
    onDragStart(event: WechatMiniprogram.TouchEvent) {
      if (this.properties.disabled || this.data.rows.length < 2) return;
      const layout = layouts.get(this);
      if (!layout) return;
      const index = z.coerce.number().int().min(0).max(this.data.rows.length - 1).parse(event.currentTarget.dataset.index);
      gestures.set(this, { ...layout, index, target: index, x: event.touches[0].clientX, y: event.touches[0].clientY });
      this.setData({ draggingId: this.data.rows[index].id });
      this.renderDrag(0, 0);
    },
    onDragMove(event: WechatMiniprogram.TouchEvent) {
      const gesture = gestures.get(this);
      if (!gesture) return;
      const columns = this.properties.columns;
      const x = Math.max(-(gesture.index % columns) * gesture.stepX, Math.min((columns - 1 - gesture.index % columns) * gesture.stepX, event.touches[0].clientX - gesture.x));
      const y = Math.max(-Math.floor(gesture.index / columns) * gesture.stepY, Math.min((Math.ceil(this.data.rows.length / columns) - 1 - Math.floor(gesture.index / columns)) * gesture.stepY, event.touches[0].clientY - gesture.y));
      gesture.target = Math.min(this.data.rows.length - 1, Math.round((gesture.index % columns * gesture.stepX + x) / gesture.stepX) + Math.round((Math.floor(gesture.index / columns) * gesture.stepY + y) / gesture.stepY) * columns);
      this.renderDrag(x, y);
    },
    onDragEnd() {
      const gesture = gestures.get(this);
      gestures.delete(this);
      if (!gesture) return;
      const rows = [...this.data.rows];
      rows.splice(gesture.target, 0, rows.splice(gesture.index, 1)[0]);
      this.setData({ rows: rows.map(item => ({ ...item, style: '' })), draggingId: '', dropStyle: '' });
      if (gesture.index !== gesture.target) this.triggerEvent('reorder', { ids: rows.map(item => item.id) });
    },
    onDragCancel() {
      gestures.delete(this);
      this.setData({ draggingId: '', dropStyle: '', rows: this.data.rows.map(item => ({ ...item, style: '' })) });
    },
    measure() {
      if (this.data.rows.length < 2) return;
      this.createSelectorQuery().selectAll('.sortable-list__cell').boundingClientRect((value: unknown) => {
        if (!attached.has(this)) return;
        const rects = z.array(z.object({ left: z.number(), width: z.number().positive(), height: z.number().positive() })).min(2).parse(value);
        layouts.set(this, { stepX: this.properties.columns === 2 ? rects[1].left - rects[0].left : rects[0].width, stepY: rects[0].height, width: rects[0].width });
      }).exec();
    },
    renderDrag(x: number, y: number) {
      const gesture = gestures.get(this)!;
      const columns = this.properties.columns;
      const order = this.data.rows.map((item, index) => index);
      order.splice(gesture.target, 0, order.splice(gesture.index, 1)[0]);
      this.setData({
        dropStyle: `left:${gesture.target % columns * gesture.stepX}px;top:${Math.floor(gesture.target / columns) * gesture.stepY}px;width:${gesture.width}px;height:${gesture.stepY}px;`,
        rows: this.data.rows.map((item, index) => ({ ...item, style: index === gesture.index ? `transform:translate(${x}px,${y}px);` : `transform:translate(${(order.indexOf(index) % columns - index % columns) * gesture.stepX}px,${(Math.floor(order.indexOf(index) / columns) - Math.floor(index / columns)) * gesture.stepY}px);` }))
      });
    }
  }
});
