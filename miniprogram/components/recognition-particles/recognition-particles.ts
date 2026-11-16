import { z } from 'zod';

const canvasSurfaceSchema = z.object({
  node: z.custom<WechatMiniprogram.Canvas>(value => typeof value === 'object' && value !== null && 'getContext' in value && 'requestAnimationFrame' in value && 'cancelAnimationFrame' in value),
  width: z.number().positive(), height: z.number().positive()
});

class ParticleAnimation {
  private readonly context;
  private frame = 0;
  private startedAt = 0;
  private lastDraw = -1;

  constructor(private readonly canvas: WechatMiniprogram.Canvas, private readonly width: number, private readonly height: number, pixelRatio: number) {
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    this.context = canvas.getContext('2d');
    this.context.scale(pixelRatio, pixelRatio);
  }

  start() {
    if (this.frame) return;
    this.startedAt = Date.now();
    this.lastDraw = -1;
    this.draw();
  }

  stop() {
    this.canvas.cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private draw() {
    const time = (Date.now() - this.startedAt) / 1000;
    if (time - this.lastDraw >= 1 / 30) {
      this.lastDraw = time;
      this.context.clearRect(0, 0, this.width, this.height);
      this.context.globalAlpha = 1;
      this.context.fillStyle = 'rgba(4, 11, 22, 0.64)';
      this.context.fillRect(0, 0, this.width, this.height);
      this.context.fillStyle = '#428FF5';
      const spacing = this.width / 28;
      for (let row = 0; row < Math.ceil(this.height / spacing); row++) {
        for (let column = 0; column < 28; column++) {
          const intensity = ((Math.sin(column * .25 + Math.sin(row * .23 - time) * 1.4 - time * 1.8) + Math.cos(row * .32 - column * .12 + time * 1.2) + 2) / 4) ** 2;
          this.context.globalAlpha = .12 + intensity * .88;
          this.context.beginPath();
          this.context.arc((column + .5) * spacing, (row + .5) * spacing, spacing * (.025 + intensity * .13), 0, Math.PI * 2);
          this.context.fill();
        }
      }
    }
    this.frame = this.canvas.requestAnimationFrame(() => this.draw());
  }
}

const animations = new WeakMap<object, ParticleAnimation>();
const mounted = new WeakSet<object>();
const hidden = new WeakSet<object>();

Component({
  lifetimes: {
    attached() { mounted.add(this); },
    ready() {
      this.createSelectorQuery().select('.recognition-particles').fields({ node: true, size: true }, (value: unknown) => {
        if (!mounted.has(this)) return;
        const surface = canvasSurfaceSchema.parse(value);
        const animation = new ParticleAnimation(surface.node, surface.width, surface.height, wx.getWindowInfo().pixelRatio);
        animations.set(this, animation);
        if (!hidden.has(this)) animation.start();
      }).exec();
    },
    detached() {
      mounted.delete(this);
      animations.get(this)?.stop();
      animations.delete(this);
      hidden.delete(this);
    }
  },
  pageLifetimes: {
    show() { hidden.delete(this); animations.get(this)?.start(); },
    hide() { hidden.add(this); animations.get(this)?.stop(); }
  }
});
