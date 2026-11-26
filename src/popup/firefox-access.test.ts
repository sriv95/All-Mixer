import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirefoxAccess } from './FirefoxAccess';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const HOSTS = ['<all_urls>'];
let root: Root | undefined;

/** A permissions stub that behaves like the browser: `request` grants and fires onAdded. */
async function mount(granted: boolean, allow = true) {
  const listeners = new Set<() => void>();
  const permissions = {
    contains: vi.fn(async () => granted),
    request: vi.fn(async () => { if (allow) { granted = true; listeners.forEach((l) => l()); } return allow; }),
    onAdded: { addListener: (l: () => void) => listeners.add(l), removeListener: (l: () => void) => listeners.delete(l) },
  };
  vi.stubGlobal('chrome', { permissions, runtime: { getManifest: () => ({ host_permissions: HOSTS }) } });
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(FirefoxAccess)); });
  return permissions;
}
const notice = () => document.getElementById('firefox-access');

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('FirefoxAccess', () => {
  it('shows nothing when access is granted', async () => {
    const p = await mount(true);
    expect(p.contains).toHaveBeenCalledWith({ origins: HOSTS });
    expect(notice()).toBeNull();
  });
  it('asks on click and hides the notice once granted', async () => {
    const p = await mount(false);
    expect(notice()).not.toBeNull();
    expect(p.request).not.toHaveBeenCalled();
    await act(async () => document.getElementById('grant-access')!.click());
    expect(p.request).toHaveBeenCalledWith({ origins: HOSTS });
    expect(notice()).toBeNull();
  });
  it('keeps the notice when the user refuses', async () => {
    await mount(false, false);
    await act(async () => document.getElementById('grant-access')!.click());
    expect(notice()).not.toBeNull();
  });
});
