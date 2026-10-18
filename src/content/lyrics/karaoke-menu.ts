export interface ContextEntry {
  label: string;
  /** A section title (not clickable). */
  heading?: boolean;
  checked?: boolean;
  run?(): void;
}

const MENU_ATTR = 'data-allmixer-karaoke-menu';
const MENU_CSS =
  'position:absolute;z-index:1;pointer-events:auto;min-width:170px;padding:6px 0;background:rgba(33,33,33,.96);color:#fff;border-radius:8px;font:13px/1.4 Roboto,Arial,sans-serif;box-shadow:0 4px 24px rgba(0,0,0,.6);user-select:none;';
const ITEM_CSS = 'display:block;width:100%;text-align:left;font:inherit;color:inherit;background:none;border:0;padding:5px 14px 5px 26px;cursor:pointer;';

/**
 * A small context menu inside `root` (the karaoke overlay), at `at` (px from root's top-left), kept inside root.
 * Closes on a pick, Escape, a press elsewhere or window blur. Returns the close function.
 */
export function openContextMenu(root: HTMLElement, at: { x: number; y: number }, entries: ContextEntry[]): () => void {
  const doc = root.ownerDocument;
  root.querySelector(`[${MENU_ATTR}]`)?.remove();
  const menu = doc.createElement('div');
  menu.setAttribute(MENU_ATTR, '');
  menu.setAttribute('role', 'menu');
  menu.style.cssText = MENU_CSS;
  for (const e of entries) {
    if (e.heading) {
      const h = doc.createElement('div');
      h.textContent = e.label;
      h.style.cssText = 'padding:4px 14px;opacity:.6;font-size:11px;text-transform:uppercase;letter-spacing:.04em;';
      menu.append(h);
      continue;
    }
    const b = doc.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(!!e.checked));
    b.textContent = (e.checked ? '✓ ' : '') + e.label;
    b.style.cssText = `${ITEM_CSS}${e.checked ? 'padding-left:10px;' : ''}`;
    b.addEventListener('click', () => {
      close();
      e.run?.();
    });
    menu.append(b);
  }
  root.append(menu);
  const r = root.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(at.x, (r.width || at.x + menu.offsetWidth) - menu.offsetWidth))}px`;
  menu.style.top = `${Math.max(0, Math.min(at.y, (r.height || at.y + menu.offsetHeight) - menu.offsetHeight))}px`;

  const onOutside = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) close();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      close();
    }
  };
  const win = doc.defaultView;
  doc.addEventListener('pointerdown', onOutside, true);
  doc.addEventListener('keydown', onKey, true);
  win?.addEventListener('blur', close);
  function close(): void {
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('keydown', onKey, true);
    win?.removeEventListener('blur', close);
    menu.remove();
  }
  return close;
}
