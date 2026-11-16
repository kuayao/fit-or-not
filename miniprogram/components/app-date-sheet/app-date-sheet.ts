import { z } from 'zod';
import { currentDate } from '../../utils/format';

export type DateDetail = { value: string };
export type DateRangeDetail = { startOn: string; endOn: string };

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    visible: Boolean, title: String, value: String, range: Boolean, startOn: String, endOn: String,
    min: { type: String, value: '0001-01-01' },
    max: { type: String, value: '9999-12-31' }
  },
  data: {
    draft: '', draftStart: '', draftEnd: '', month: '', year: 0, monthNumber: 0, mode: 'day', yearStart: 0, yearEnd: 0,
    canPrevious: false, canNext: false, today: '', canToday: false,
    weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    days: Array<{ date: string; number: number; inMonth: boolean; disabled: boolean }>(),
    years: Array<number>(),
    months: Array<{ value: number; disabled: boolean }>()
  },
  observers: {
    'visible, value, range, startOn, endOn, min, max'() {
      if (!this.properties.visible) return;
      const today = currentDate();
      const value = (this.properties.range ? this.properties.startOn || this.properties.endOn : this.properties.value) || today;
      const draft = value < this.properties.min ? this.properties.min : value > this.properties.max ? this.properties.max : value;
      this.setData({ draft, draftStart: this.properties.startOn, draftEnd: this.properties.endOn, mode: 'day', today, canToday: today >= this.properties.min && today <= this.properties.max });
      this.renderMonth(draft.slice(0, 7));
    }
  },
  methods: {
    onClose() { this.triggerEvent('close'); },
    onConfirm() {
      if (this.properties.range && (!this.data.draftStart || !this.data.draftEnd)) return;
      this.triggerEvent('confirm', this.properties.range ? { startOn: this.data.draftStart, endOn: this.data.draftEnd } : { value: this.data.draft });
    },
    onDate(event: WechatMiniprogram.TouchEvent) {
      const date = z.iso.date().parse(event.currentTarget.dataset.date);
      if (!this.properties.range) { this.setData({ draft: date }); return; }
      if (!this.data.draftStart || this.data.draftEnd) { this.setData({ draftStart: date, draftEnd: '' }); return; }
      this.setData({ draftStart: date < this.data.draftStart ? date : this.data.draftStart, draftEnd: date < this.data.draftStart ? this.data.draftStart : date });
    },
    onToday() {
      this.setData(this.properties.range ? { draftStart: this.data.today, draftEnd: '', mode: 'day' } : { draft: this.data.today, mode: 'day' });
      this.renderMonth(this.data.today.slice(0, 7));
    },
    onShowYears() {
      this.setData({ mode: 'year' });
      this.renderYears(Math.max(1, this.data.year - 5));
    },
    onShowMonths() {
      this.setData({ mode: 'month' });
      this.renderMonth(this.data.month);
    },
    onYear(event: WechatMiniprogram.TouchEvent) {
      const year = z.coerce.number().int().min(Number(this.properties.min.slice(0, 4))).max(Number(this.properties.max.slice(0, 4))).parse(event.currentTarget.dataset.year);
      this.setData({ mode: 'month' });
      this.renderMonth(`${String(year).padStart(4, '0')}-${this.data.month.slice(5)}`);
    },
    onMonth(event: WechatMiniprogram.TouchEvent) {
      const month = z.coerce.number().int().min(1).max(12).parse(event.currentTarget.dataset.month);
      this.setData({ mode: 'day' });
      this.renderMonth(`${this.data.month.slice(0, 4)}-${String(month).padStart(2, '0')}`);
    },
    onNavigate(event: WechatMiniprogram.TouchEvent) {
      const offset = z.coerce.number().pipe(z.union([z.literal(-1), z.literal(1)])).parse(event.currentTarget.dataset.offset);
      if (this.data.mode === 'year') { this.renderYears(this.data.yearStart + offset * 12); return; }
      const date = new Date(`${this.data.month}-01T00:00:00Z`);
      if (this.data.mode === 'month') date.setUTCFullYear(date.getUTCFullYear() + offset);
      if (this.data.mode === 'day') date.setUTCMonth(date.getUTCMonth() + offset);
      this.renderMonth(date.toISOString().slice(0, 7));
    },
    renderYears(start: number) {
      const minYear = Number(this.properties.min.slice(0, 4));
      const maxYear = Number(this.properties.max.slice(0, 4));
      const yearStart = Math.max(minYear, Math.min(start, Math.max(minYear, maxYear - 11)));
      this.setData({
        yearStart, yearEnd: Math.min(yearStart + 11, maxYear),
        years: Array.from({ length: Math.min(12, maxYear - yearStart + 1) }, (_, index) => yearStart + index),
        canPrevious: yearStart > minYear, canNext: yearStart + 11 < maxYear
      });
    },
    renderMonth(value: string) {
      const month = value < this.properties.min.slice(0, 7) ? this.properties.min.slice(0, 7) : value > this.properties.max.slice(0, 7) ? this.properties.max.slice(0, 7) : value;
      const first = new Date(`${month}-01T00:00:00Z`);
      const offset = (first.getUTCDay() + 6) % 7;
      const days = Array.from({ length: 42 }, (_, index) => {
        const date = new Date(first.getTime() + (index - offset) * 86400000).toISOString().slice(0, 10);
        return { date, number: Number(date.slice(8)), inMonth: date.startsWith(month), disabled: date < this.properties.min || date > this.properties.max };
      });
      this.setData({
        month, year: first.getUTCFullYear(), monthNumber: first.getUTCMonth() + 1, days,
        months: Array.from({ length: 12 }, (_, index) => {
          const value = `${month.slice(0, 4)}-${String(index + 1).padStart(2, '0')}`;
          return { value: index + 1, disabled: value < this.properties.min.slice(0, 7) || value > this.properties.max.slice(0, 7) };
        }),
        canPrevious: this.data.mode === 'month' ? month.slice(0, 4) > this.properties.min.slice(0, 4) : month > this.properties.min.slice(0, 7),
        canNext: this.data.mode === 'month' ? month.slice(0, 4) < this.properties.max.slice(0, 4) : month < this.properties.max.slice(0, 7)
      });
    }
  }
});
