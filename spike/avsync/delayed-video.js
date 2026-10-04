// SRI-14 spike: show a <video> D ms late so it lines up with audio that the
// separation graph delays by D ms (decision D1).
//
// Method (a): requestVideoFrameCallback captures each decoded frame into a
// ring buffer, a requestAnimationFrame loop draws the frame whose due time
// (expectedDisplayTime + delay) has passed onto a canvas that covers the
// <video>. The <video> keeps playing underneath (it must stay rendered or
// Chrome stops producing frames), so audio, controls and YouTube's own UI
// are untouched.
//
// capture: 'bitmap'     -> createImageBitmap(video, resize to canvas size)
//                          (copies the frame, frees the decoder buffer)
//          'videoframe' -> new VideoFrame(video), held until drawn
//                          (no copy, but holds decoder-pool buffers)
//
// Delay changes are slewed: the effective delay moves toward the target at
// `slew` seconds of delay per second of wall time (0.1 => video runs at
// 0.9x / 1.1x speed until caught up). slew = Infinity jumps (freeze or skip).

export class DelayedVideo {
  constructor(video, { delayMs = 0, capture = 'bitmap', slew = 0.1, hide = 'cover', maxScale = 1 } = {}) {
    this.video = video;
    this.capture = capture;
    this.slew = slew;
    this.target = delayMs;
    this.delay = delayMs;
    this.maxScale = maxScale;
    this.ring = []; // { due, mediaTime, img, bytes }
    this.pending = 0;
    this.lastDrawn = null;
    this.lastRaf = 0;
    this.epoch = 0; // bumped on seek; captures from an older epoch are dropped
    this.stats = newStats();

    const c = (this.canvas = document.createElement('canvas'));
    c.style.cssText = 'position:absolute;pointer-events:none;z-index:1;background:#000';
    this.ctx = c.getContext('2d', { alpha: false, desynchronized: false });
    video.insertAdjacentElement('afterend', c);
    if (hide === 'opacity') video.style.opacity = '0';
    this.layout();
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(video);

    this.onSeeking = () => {
      // Frames before the seek are stale. Keep the last picture on screen
      // until the first new frame is due (YouTube shows a spinner anyway).
      this.epoch++;
      this.flush();
      this.stats.seeks++;
    };
    video.addEventListener('seeking', this.onSeeking);

    this.running = true;
    this.vfc = video.requestVideoFrameCallback((n, m) => this.onFrame(n, m));
    this.raf = requestAnimationFrame((t) => this.onRaf(t));
  }

  setDelay(ms) {
    this.target = ms;
    if (!isFinite(this.slew)) this.delay = ms;
  }

  layout() {
    const v = this.video;
    const scale = Math.min(devicePixelRatio, this.maxScale);
    const w = Math.max(2, Math.round(v.clientWidth * scale));
    const h = Math.max(2, Math.round(v.clientHeight * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.lastDrawn = null; // force redraw
    }
    Object.assign(this.canvas.style, {
      left: v.offsetLeft + 'px',
      top: v.offsetTop + 'px',
      width: v.clientWidth + 'px',
      height: v.clientHeight + 'px',
    });
  }

  onFrame(now, md) {
    if (!this.running) return;
    this.vfc = this.video.requestVideoFrameCallback((n, m) => this.onFrame(n, m));
    const s = this.stats;
    if (s.lastPresented !== null && md.presentedFrames - s.lastPresented > 1) s.srcDropped += md.presentedFrames - s.lastPresented - 1;
    s.lastPresented = md.presentedFrames;
    s.srcFrames++;

    this.advanceDelay(now);
    const due = md.expectedDisplayTime + this.delay;
    const epoch = this.epoch;
    const t0 = performance.now();
    if (this.capture === 'videoframe') {
      let f;
      try {
        f = new VideoFrame(this.video, { timestamp: Math.round(md.mediaTime * 1e6) });
      } catch {
        s.captureErrors++;
        return;
      }
      s.captureMs.push(performance.now() - t0);
      this.push({ due, mediaTime: md.mediaTime, img: f, bytes: md.width * md.height * 1.5 });
    } else {
      const { width, height } = this.canvas;
      this.pending++;
      createImageBitmap(this.video, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' }).then(
        (bmp) => {
          this.pending--;
          s.captureMs.push(performance.now() - t0);
          if (epoch !== this.epoch || !this.running) return bmp.close();
          this.push({ due, mediaTime: md.mediaTime, img: bmp, bytes: width * height * 4 });
        },
        () => {
          this.pending--;
          s.captureErrors++;
        },
      );
    }
  }

  advanceDelay(now) {
    const dt = this.lastAdvance ? (now - this.lastAdvance) / 1000 : 0;
    this.lastAdvance = now;
    if (this.delay === this.target) return;
    const step = isFinite(this.slew) ? this.slew * 1000 * dt : Infinity;
    this.delay = this.delay < this.target ? Math.min(this.target, this.delay + step) : Math.max(this.target, this.delay - step);
  }

  push(entry) {
    // Keep due-time order (bitmap captures resolve in order in practice).
    this.ring.push(entry);
    const bytes = this.ring.reduce((a, e) => a + e.bytes, 0);
    if (this.ring.length > this.stats.maxFrames) this.stats.maxFrames = this.ring.length;
    if (bytes > this.stats.maxBytes) this.stats.maxBytes = bytes;
    // Safety cap: 2 s of 60 fps.
    while (this.ring.length > 120) this.drop(this.ring.shift());
  }

  drop(e) {
    e.img.close();
  }

  flush() {
    for (const e of this.ring) this.drop(e);
    this.ring = [];
  }

  onRaf(t) {
    if (!this.running) return;
    this.raf = requestAnimationFrame((x) => this.onRaf(x));
    const s = this.stats;
    const vsync = this.lastRaf ? t - this.lastRaf : 16.7;
    this.lastRaf = t;
    s.rafs++;
    // Pick the newest frame that is due by the middle of this vsync.
    let pick = -1;
    for (let i = 0; i < this.ring.length; i++) if (this.ring[i].due <= t + vsync / 2) pick = i;
    if (pick < 0) return;
    for (let i = 0; i < pick; i++) {
      s.skipped++;
      this.drop(this.ring[i]);
    }
    const e = this.ring[pick];
    this.ring = this.ring.slice(pick + 1);
    const t0 = performance.now();
    this.ctx.drawImage(e.img, 0, 0, this.canvas.width, this.canvas.height);
    s.drawMs.push(performance.now() - t0);
    if (this.lastDrawn) this.lastDrawn.img.close();
    // Lateness: how far from its due time the frame actually hit a vsync.
    s.lateness.push(t - e.due);
    if (s.lastMedia !== null) s.mediaSteps.push(e.mediaTime - s.lastMedia);
    s.lastMedia = e.mediaTime;
    s.drawn++;
    this.lastDrawn = e;
  }

  destroy() {
    this.running = false;
    this.video.cancelVideoFrameCallback(this.vfc);
    cancelAnimationFrame(this.raf);
    this.video.removeEventListener('seeking', this.onSeeking);
    this.ro.disconnect();
    this.flush();
    if (this.lastDrawn) this.lastDrawn.img.close();
    this.canvas.remove();
    this.video.style.opacity = '';
  }
}

function newStats() {
  return {
    srcFrames: 0, srcDropped: 0, lastPresented: null, rafs: 0, drawn: 0, skipped: 0,
    captureErrors: 0, maxFrames: 0, maxBytes: 0, seeks: 0,
    captureMs: [], drawMs: [], lateness: [], mediaSteps: [], lastMedia: null,
  };
}
