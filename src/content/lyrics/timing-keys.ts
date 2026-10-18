/** Step of one key press, ms. */
export const TIMING_KEY_STEP_MS = 100;

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** `]` shows the lyrics later (+), `[` earlier (−). 0 for any other key, a key with a modifier, or a key typed into a text field. */
export function timingKeyDelta(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target'>): number {
  if (e.ctrlKey || e.metaKey || e.altKey) return 0;
  if (e.key !== '[' && e.key !== ']') return 0;
  const t = e.target as HTMLElement | null;
  if (t && (EDITABLE.has(t.tagName) || t.isContentEditable)) return 0;
  return e.key === ']' ? TIMING_KEY_STEP_MS : -TIMING_KEY_STEP_MS;
}

const TOAST_ATTR = 'data-allmixer-toast';
const TOAST_MS = 1200;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** A short message at the top of the screen (one at a time; a new one replaces the old). */
export function showToast(text: string, doc: Document = document): void {
  doc.querySelector(`[${TOAST_ATTR}]`)?.remove();
  clearTimeout(toastTimer);
  const el = doc.createElement('div');
  el.setAttribute(TOAST_ATTR, '');
  el.textContent = text;
  el.style.cssText =
    'position:fixed;top:12%;left:50%;transform:translateX(-50%);z-index:2147483000;pointer-events:none;padding:8px 14px;background:rgba(0,0,0,.8);color:#fff;border-radius:6px;font:14px/1.3 Roboto,Arial,sans-serif;';
  (doc.fullscreenElement ?? doc.body).append(el);
  toastTimer = setTimeout(() => el.remove(), TOAST_MS);
}
