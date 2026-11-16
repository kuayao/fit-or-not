Component({
  options: { multipleSlots: true, styleIsolation: 'apply-shared' },
  properties: { visible: Boolean, title: String, size: { type: String, value: 'medium' }, busy: Boolean, scrollable: Boolean },
  data: { overlay: { backgroundColor: '#263D5138' } },
  methods: {
    onClose() { if (!this.properties.busy) this.triggerEvent('close'); }
  }
});
