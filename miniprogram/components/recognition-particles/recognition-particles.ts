Component({
  properties: { status: String },
  data: { active: true },
  pageLifetimes: {
    show() { this.setData({ active: true }); },
    hide() { this.setData({ active: false }); }
  }
});
