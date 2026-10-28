import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentStatus } from '../shared/messages';

// The composition root with its audio parts replaced: only the status answer and the badge reports are under test.
const fake = vi.hoisted(() => ({
  chain: { sepState: 'off', sepError: undefined as string | undefined, onStateChange: () => {} },
  selector: { status: { state: 'off' } as { state: string; cause?: string }, onChange: null as ((c: unknown) => void) | null },
}));
vi.mock('./audio/master-chain', () => ({
  MasterChain: class {
    state = 'idle';
    requestedGain = 1;
    error = undefined;
    latency = { processingMs: 0 };
    constructor(onStateChange: () => void) {
      fake.chain.onStateChange = onStateChange;
    }
    get separationState() {
      return fake.chain.sepState;
    }
    get separationError() {
      return fake.chain.sepError;
    }
    setVideo() {}
    setGain() {}
    setSeparation() {}
    setPreloadActive() {}
    onLatencyChange() {}
    whenAudible() {}
  },
}));
vi.mock('./audio/engine-select', () => ({
  EngineSelector: class {
    get status() {
      return fake.selector.status;
    }
    set onChange(cb: ((c: unknown) => void) | null) {
      fake.selector.onChange = cb;
    }
    update() {}
    reload() {}
  },
}));

type Listener = (msg: { type: string }, sender: unknown, sendResponse: (r: unknown) => void) => boolean;
let listener: Listener;
let sendMessage: ReturnType<typeof vi.fn>;

async function load(o: { video: boolean; top?: boolean; mode?: string }) {
  vi.resetModules();
  document.body.innerHTML = o.video ? '<audio></audio>' : '';
  sendMessage = vi.fn((m: { type: string }) => Promise.resolve(m.type === 'get-my-tab-settings' ? { mode: o.mode ?? 'default' } : undefined));
  vi.stubGlobal('chrome', {
    runtime: { sendMessage, onMessage: { addListener: (l: Listener) => (listener = l) } },
    storage: { onChanged: { addListener: vi.fn() } },
  });
  if (o.top === false) vi.stubGlobal('top', {});
  await import('./content');
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 10));
}

/** What the popup would get from this frame: the first answer, or nothing. */
function ask(): { answered: () => ContentStatus | undefined; keptOpen: boolean } {
  let got: ContentStatus | undefined;
  const keptOpen = listener({ type: 'get-status' }, {}, (r) => (got = r as ContentStatus));
  return { answered: () => got, keptOpen };
}
const badges = () => sendMessage.mock.calls.map((c) => c[0]).filter((m: { type: string }) => m.type === 'set-badge').map((m: { view: unknown }) => m.view);

beforeEach(() => {
  fake.chain.sepState = 'off';
  fake.chain.sepError = undefined;
  fake.selector.status = { state: 'off' };
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('get-status in a page with several frames', () => {
  it('a frame with media answers at once', async () => {
    await load({ video: true });
    expect(ask().answered()?.videoFound).toBe(true);
  });

  it('a frame without media stays silent, so it cannot win the popup\'s race against the frame that has the media', async () => {
    await load({ video: false, top: false });
    const q = ask();
    await new Promise((r) => setTimeout(r, 300));
    expect(q.answered()).toBeUndefined();
  });

  it('the top frame without media answers late, after a frame with media had its chance', async () => {
    await load({ video: false });
    const q = ask();
    expect(q.answered()).toBeUndefined();
    expect(q.keptOpen).toBe(true);
    await vi.waitFor(() => expect(q.answered()?.videoFound).toBe(false), { timeout: 1000 });
  });
});

describe('toolbar badge', () => {
  it('follows the engine choice', async () => {
    await load({ video: true, mode: 'separate' });
    fake.chain.sepState = 'on';
    fake.selector.status = { state: 'on' };
    fake.selector.onChange!(fake.selector.status);
    expect(badges().at(-1)).toMatchObject({ kind: 'live' });
  });

  it('shows the stop when the separator fails after the engine choice', async () => {
    await load({ video: true, mode: 'separate' });
    fake.chain.sepState = 'on';
    fake.selector.status = { state: 'on' };
    fake.selector.onChange!(fake.selector.status);
    fake.chain.sepState = 'error';
    fake.chain.sepError = 'separator stopped';
    fake.chain.onStateChange();
    expect(badges().at(-1)).toEqual({ kind: 'error', cause: 'separator stopped' });
  });
});
