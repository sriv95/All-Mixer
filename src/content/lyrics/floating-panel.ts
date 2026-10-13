export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  w: number;
  h: number;
}

export interface FloatingPanelOptions {
  id: string;
  title: string;
  storageKey: string;
  defaultRect?: Rect;
}

const MIN_SIZE: Viewport = { w: 240, h: 160 };
const DEFAULT_RECT: Rect = { x: 24, y: 80, w: 340, h: 420 };
const SAVE_DEBOUNCE_MS = 300;

/** Keep a rect inside the viewport, honouring the minimum size (min wins if the viewport is smaller). */
export function clampRect(rect: Rect, viewport: Viewport, min: Viewport = MIN_SIZE): Rect {
  const w = Math.max(min.w, Math.min(rect.w, viewport.w));
  const h = Math.max(min.h, Math.min(rect.h, viewport.h));
  const x = Math.max(0, Math.min(rect.x, viewport.w - w));
  const y = Math.max(0, Math.min(rect.y, viewport.h - h));
  return { x, y, w, h };
}

/** Resize from the bottom-right corner: grow up to the viewport edge instead of pushing the panel away. */
export function resizeRect(start: Rect, dx: number, dy: number, viewport: Viewport): Rect {
  return {
    ...start,
    w: Math.min(start.w + dx, viewport.w - start.x),
    h: Math.min(start.h + dy, viewport.h - start.y),
  };
}

const STYLE = `
:host { all: initial; }
.panel {
  position: fixed; box-sizing: border-box; display: flex; flex-direction: column;
  pointer-events: auto; background: rgba(20, 20, 20, 0.88); color: #f1f1f1;
  font: 14px/1.4 Roboto, Arial, sans-serif; border: 1px solid rgba(255,255,255,0.2);
  border-radius: 8px; overflow: hidden;
}
.header {
  display: flex; align-items: center; justify-content: space-between; flex: none;
  padding: 6px 10px; cursor: move; user-select: none; touch-action: none;
  background: rgba(255,255,255,0.08);
}
.title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.close { background: none; border: 0; color: inherit; font-size: 18px; cursor: pointer; padding: 0 4px; }
.body { flex: 1; min-height: 0; overflow: auto; }
.resize {
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
  cursor: nwse-resize; touch-action: none;
  background: linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.5) 50%);
}
`;

type Area = Pick<chrome.storage.LocalStorageArea, 'get' | 'set'>;

export class FloatingPanel {
  private readonly host: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private readonly storageKey: string;
  private rect: Rect;
  private open = false;
  private destroyed = false;
  private touched = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private closeCbs: Array<() => void> = [];
  private openCbs: Array<(open: boolean) => void> = [];
  private drag: { mode: 'move' | 'resize'; px: number; py: number; start: Rect } | null = null;
  private readonly keyBlocker = (e: Event): void => e.stopPropagation();

  constructor(opts: FloatingPanelOptions) {
    this.storageKey = opts.storageKey;
    this.rect = { ...(opts.defaultRect ?? DEFAULT_RECT) };

    this.host = document.createElement('div');
    this.host.id = opts.id;
    this.host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2100;pointer-events:none;display:none;';
    const root = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    this.panel = document.createElement('div');
    this.panel.className = 'panel';

    const header = document.createElement('div');
    header.className = 'header';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = opts.title;
    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    close.addEventListener('click', () => this.close());
    header.append(title, close);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'body';
    const handle = document.createElement('div');
    handle.className = 'resize';

    this.panel.append(header, this.bodyEl, handle);
    root.append(style, this.panel);

    this.bindDrag(header, 'move');
    this.bindDrag(handle, 'resize');

    window.addEventListener('resize', this.onWindowResize);
    document.addEventListener('fullscreenchange', this.onFullscreen);

    this.apply();
    this.attach();
    void this.restore();
  }

  get body(): HTMLElement {
    return this.bodyEl;
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(): void {
    this.open = true;
    this.touched = true;
    this.host.style.display = '';
    this.reclamp();
    this.scheduleSave();
    this.emitOpen();
  }

  hide(): void {
    this.open = false;
    this.touched = true;
    this.host.style.display = 'none';
    this.scheduleSave();
    this.emitOpen();
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  /** Called after every show() / hide(), including the one that restores the saved state. */
  onOpenChange(cb: (open: boolean) => void): void {
    this.openCbs.push(cb);
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.saveTimer);
    window.removeEventListener('resize', this.onWindowResize);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    this.host.remove();
    this.closeCbs = [];
    this.openCbs = [];
  }

  private emitOpen(): void {
    for (const cb of this.openCbs) cb(this.open);
  }

  private close(): void {
    this.hide();
    for (const cb of this.closeCbs) cb();
  }

  private viewport(): Viewport {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  private reclamp(): void {
    this.rect = clampRect(this.rect, this.viewport());
    this.apply();
  }

  private apply(): void {
    const s = this.panel.style;
    s.left = `${this.rect.x}px`;
    s.top = `${this.rect.y}px`;
    s.width = `${this.rect.w}px`;
    s.height = `${this.rect.h}px`;
  }

  private attach(): void {
    const parent = document.fullscreenElement ?? document.body;
    if (this.host.parentNode !== parent) parent.appendChild(this.host);
  }

  private readonly onWindowResize = (): void => {
    this.reclamp();
    this.scheduleSave();
  };

  private readonly onFullscreen = (): void => {
    this.attach();
    this.reclamp();
  };

  private bindDrag(el: HTMLElement, mode: 'move' | 'resize'): void {
    el.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      this.drag = { mode, px: e.clientX, py: e.clientY, start: { ...this.rect } };
      el.setPointerCapture?.(e.pointerId);
      // Only while dragging: keep keys from reaching YouTube shortcuts.
      window.addEventListener('keydown', this.keyBlocker, true);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.mode !== mode) return;
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      const next =
        mode === 'move'
          ? { ...d.start, x: d.start.x + dx, y: d.start.y + dy }
          : resizeRect(d.start, dx, dy, this.viewport());
      this.rect = clampRect(next, this.viewport());
      this.apply();
    });
    const end = (e: PointerEvent): void => {
      if (!this.drag || this.drag.mode !== mode) return;
      this.drag = null;
      window.removeEventListener('keydown', this.keyBlocker, true);
      el.releasePointerCapture?.(e.pointerId);
      this.scheduleSave();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  private area(): Area | undefined {
    return typeof chrome !== 'undefined' ? chrome.storage?.local : undefined;
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (this.destroyed) return;
      void this.area()?.set({ [this.storageKey]: { ...this.rect, open: this.open } });
    }, SAVE_DEBOUNCE_MS);
  }

  private async restore(): Promise<void> {
    const area = this.area();
    if (!area) return;
    try {
      const res = await area.get(this.storageKey);
      const v = res?.[this.storageKey] as Partial<Rect & { open: boolean }> | undefined;
      if (this.destroyed || !v) return;
      const nums = [v.x, v.y, v.w, v.h];
      if (nums.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        this.rect = clampRect(v as Rect, this.viewport());
        this.apply();
      }
      // Don't override an explicit show()/hide() made before storage answered.
      if (!this.touched && typeof v.open === 'boolean') {
        if (v.open) this.show();
        else this.hide();
        clearTimeout(this.saveTimer);
      }
    } catch {
      // storage unavailable: keep defaults
    }
  }
}
