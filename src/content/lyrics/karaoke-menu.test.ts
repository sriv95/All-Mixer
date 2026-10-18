import { afterEach, describe, expect, it, vi } from 'vitest';
import { openContextMenu } from './karaoke-menu';

const root = () => {
  const r = document.createElement('div');
  document.body.append(r);
  return r;
};
const menu = () => document.querySelector<HTMLElement>('[data-allmixer-karaoke-menu]');

afterEach(() => {
  document.body.replaceChildren();
});

describe('openContextMenu', () => {
  it('lists headings and radio items with the checked one marked, and runs a pick then closes', () => {
    const run = vi.fn();
    openContextMenu(root(), { x: 5, y: 5 }, [{ label: 'Position', heading: true }, { label: 'Top', run }, { label: 'Bottom', checked: true }]);
    const items = [...menu()!.querySelectorAll('button')];
    expect(items.map((b) => [b.textContent, b.getAttribute('aria-checked')])).toEqual([['Top', 'false'], ['✓ Bottom', 'true']]);
    expect(menu()!.textContent).toContain('Position');
    items[0].click();
    expect(run).toHaveBeenCalled();
    expect(menu()).toBeNull();
  });

  it('closes on Escape and on a press outside, not on a press inside; only one at a time', () => {
    const r = root();
    openContextMenu(r, { x: 0, y: 0 }, [{ label: 'A' }]);
    menu()!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menu()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu()).toBeNull();
    openContextMenu(r, { x: 0, y: 0 }, [{ label: 'A' }]);
    openContextMenu(r, { x: 0, y: 0 }, [{ label: 'B' }]);
    expect(document.querySelectorAll('[data-allmixer-karaoke-menu]')).toHaveLength(1);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menu()).toBeNull();
  });

  it('close() removes it and its listeners', () => {
    const close = openContextMenu(root(), { x: 0, y: 0 }, [{ label: 'A' }]);
    close();
    expect(menu()).toBeNull();
  });
});
