import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportOptions, ExportProgress } from '../shared/export';
import type { ContentStatus } from '../shared/messages';

const html = readFileSync('src/popup/popup.html', 'utf8');
const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, '');

const YT = { id: 7, url: 'https://www.youtube.com/watch?v=abcdefghijk' };
const status = (over: Partial<ContentStatus> = {}): ContentStatus => ({ site: 'youtube', videoFound: true, audio: 'active', gain: 1, videoDelay: { state: 'off', delayMs: 0 }, duration: 212, lyricsSynced: true, ...over });

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const has = (id: string) => document.getElementById(id) !== null;
const settle = () => new Promise((r) => setTimeout(r, 50));
function choose(id: string, v: string): void {
  el(id).click();
  el(`${id}-option-${v}`).click();
}
function slide(id: string, v: number): void {
  const e = el<HTMLInputElement>(id);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(e, String(v));
  e.dispatchEvent(new Event('input', { bubbles: true }));
}

let tabMessage: ReturnType<typeof vi.fn>;
let runtimeMessage: ReturnType<typeof vi.fn>;
const exportsSent = () => tabMessage.mock.calls.map((c) => c[1]).filter((m: { type: string }) => m.type === 'export-start');

async function load(o: { stored?: unknown; status?: ContentStatus; local?: Record<string, unknown>; answer?: unknown } = {}) {
  vi.resetModules();
  document.body.innerHTML = body;
  runtimeMessage = vi.fn((msg: { type: string }) => Promise.resolve(msg.type === 'get-tab-settings' ? (o.stored ?? { mode: 'separate' }) : undefined));
  tabMessage = vi.fn((_id: number, msg: { type: string }) => Promise.resolve(msg.type === 'export-start' ? (o.answer ?? { ok: true }) : msg.type === 'get-status' ? (o.status ?? status()) : { ok: true }));
  vi.stubGlobal('chrome', {
    tabs: { query: vi.fn().mockResolvedValue([YT]), sendMessage: tabMessage },
    runtime: { sendMessage: runtimeMessage },
    storage: { local: { get: vi.fn().mockResolvedValue(o.local ?? {}) }, onChanged: { addListener: vi.fn() } },
  });
  (await import('motion/react')).MotionGlobalConfig.skipAnimations = true;
  await import('./popup');
  await vi.waitFor(() => expect(tabMessage).toHaveBeenCalled(), { timeout: 2000 });
  await new Promise((r) => setTimeout(r, 150));
}

beforeEach(() => vi.useRealTimers());
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Export section', () => {
  it('sits below Advanced, not inside it, on the Separate tab only', async () => {
    await load();
    const advanced = el('advanced'), exp = el('export');
    expect(advanced.contains(exp)).toBe(false);
    expect(advanced.compareDocumentPosition(exp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    el('tab-default').click();
    await settle();
    expect(has('export')).toBe(false);
  });

  it('the audio options start from the live settings and changing them leaves the live settings alone', async () => {
    await load({ stored: { mode: 'separate', vocalPct: 30, instrumentalPct: 80, masterPct: 200, mlModel: 'roformer' } });
    expect(el('export-vocal-value').textContent).toBe('30%');
    expect(el('export-instrumental-value').textContent).toBe('80%');
    expect(el('export-master-value').textContent).toBe('200%');
    expect(el('export-model').textContent).toContain('High quality');
    slide('export-vocal', 0);
    choose('export-model', 'mdx');
    await settle();
    expect(el('export-vocal-value').textContent).toBe('0%');
    expect(el('export-model').textContent).toContain('Default');
    expect(el('vocal-value').textContent).toBe('30%'); // the live slider
    expect(runtimeMessage.mock.calls.some((c) => c[0].type === 'set-tab-settings')).toBe(false);
  });

  it('Match live copies the live settings back', async () => {
    await load({ stored: { mode: 'separate', vocalPct: 30 } });
    slide('export-vocal', 90);
    await settle();
    expect(el('export-vocal-value').textContent).toBe('90%');
    el('export-match').click();
    await settle();
    expect(el('export-vocal-value').textContent).toBe('30%');
  });

  it('starts an MP3 with the export options, as a message to the tab', async () => {
    await load({ stored: { mode: 'separate', vocalPct: 0, mlModel: 'deux' } });
    slide('export-vocal', 40);
    el('export-tracks-separate').click();
    await settle();
    el('export-start').click();
    await settle();
    const [msg] = exportsSent() as { options: ExportOptions }[];
    expect(msg.options).toMatchObject({ format: 'mp3', tracks: 'separate', audio: { vocalPct: 40, mlModel: 'deux' } });
    expect(tabMessage.mock.calls.find((c) => c[1].type === 'export-start')![0]).toBe(7);
  });

  it('the MP4 has the karaoke text options, starting from the lyrics settings', async () => {
    await load({ local: { lyricsPrefs: { karaokeColor: '#ffeb3b', karaokeFontSize: 150, karaokeFont: 'serif', karaokeLines: 2 } } });
    expect(el('export-start').textContent).toContain('MP3');
    el('export-format-mp4').click();
    await settle();
    expect(el('export-start').textContent).toContain('MP4');
    expect(el<HTMLInputElement>('export-color').value).toBe('#ffeb3b');
    expect(el('export-size').textContent).toContain('150%');
    expect(el('export-font').textContent).toContain('Serif');
    expect(el('export-lines').textContent).toContain('2 lines');
    expect(has('export-preview')).toBe(true);
    choose('export-outline', 'thick');
    choose('export-position', 'top');
    choose('export-height', '480');
    await settle();
    el('export-start').click();
    await settle();
    const [msg] = exportsSent() as { options: ExportOptions }[];
    expect(msg.options).toMatchObject({ format: 'mp4', height: 480, text: { karaokeColor: '#ffeb3b', karaokeFontSize: 150, karaokeFont: 'serif', karaokeOutline: 'thick', karaokeLines: 2, karaokePosition: { x: 0.5, y: 0.12 } } });
  });

  it('lists Audio options, Karaoke text, Video options (Quality), then Output', async () => {
    await load();
    el('export-format-mp4').click();
    await settle();
    const follows = (a: string, b: string) => !!(el(a).compareDocumentPosition(el(b)) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows('export-audio', 'export-text')).toBe(true);
    expect(follows('export-text', 'export-video')).toBe(true);
    expect(follows('export-video', 'export-tracks-single')).toBe(true);
    expect(el('export-video').contains(el('export-height'))).toBe(true);
    expect(el('export-text').contains(el('export-height'))).toBe(false);
    expect(document.querySelector('label[for="export-height"]')!.textContent).toBe('Quality');
  });

  it('an MP4 can leave the audio out: its options and the Output choice go, and the export says so', async () => {
    await load();
    expect(has('export-with-audio')).toBe(false); // an MP3 always has its sound
    el('export-format-mp4').click();
    await settle();
    expect(el<HTMLInputElement>('export-with-audio').checked).toBe(true);
    expect(has('export-audio') && has('export-tracks-single')).toBe(true);
    el('export-with-audio').click();
    await new Promise((r) => setTimeout(r, 500)); // the groups collapse out
    expect(has('export-audio') || has('export-tracks-single')).toBe(false);
    expect(has('export-text') && has('export-video')).toBe(true);
    el('export-start').click();
    await settle();
    const [msg] = exportsSent() as { options: ExportOptions }[];
    expect(msg.options).toMatchObject({ format: 'mp4', withAudio: false });
  });

  it('the split switches add their level sliders; the all-stems model has them all', async () => {
    await load();
    expect(has('export-drums')).toBe(false);
    el('export-split-drums').click();
    await settle();
    expect(has('export-drums')).toBe(true);
    expect(has('export-others')).toBe(true);
    expect(has('export-bass')).toBe(false);
    choose('export-model', 'sw');
    await settle();
    for (const id of ['drums', 'guitar', 'bass', 'piano', 'others']) expect(has(`export-${id}`)).toBe(true);
  });

  it('warns when the MP4 would have no text, and for a long video', async () => {
    await load({ status: status({ lyricsSynced: false, duration: 3000 }) });
    el('export-format-mp4').click();
    await settle();
    expect(el('export-lyrics-note').textContent).toMatch(/no text/);
    expect(has('export-long-note')).toBe(true);
  });

  it('shows the progress of a running export, with the detail line and Cancel', async () => {
    const progress: ExportProgress = { state: 'running', stage: 'recording', chunk: 3, chunks: 12, percent: 38, detail: 'Chunk 3/12 · 0:34 / 3:05 · 2 of 12 processed' };
    await load({ status: status({ export: progress }) });
    expect(el('export-progress').getAttribute('aria-valuenow')).toBe('38');
    expect(el('export-detail').textContent).toContain('Chunk 3/12');
    expect(el('export-detail').textContent).toContain('38%');
    expect(has('export-start')).toBe(false);
    el('export-cancel').click();
    await settle();
    expect(tabMessage.mock.calls.some((c) => c[1].type === 'export-cancel')).toBe(true);
    expect(el('export-toggle').getAttribute('aria-expanded')).toBe('true'); // opened by itself
  });

  it('shows why it stopped, and the saved file', async () => {
    await load({ status: status({ export: { state: 'error', stage: 'model', chunk: 0, chunks: 0, percent: 0, detail: 'The export stopped.', error: 'Separation is not available: no WebGPU adapter' } }) });
    expect(el('export-failure').textContent).toContain('no WebGPU adapter');
    expect(has('export-start')).toBe(true);
    await load({ status: status({ export: { state: 'done', stage: 'finishing', chunk: 0, chunks: 0, percent: 100, detail: 'Saved Song.mp3', file: { name: 'Song.mp3', bytes: 3_400_000 } } }) });
    expect(el('export-detail').textContent).toContain('Saved Song.mp3');
    expect(el('export-detail').textContent).toContain('3.4 MB');
  });

  it('shows the reason when the tab refuses to start', async () => {
    await load({ answer: { ok: false, error: 'An ad is playing. Export when the video itself plays.' } });
    el('export-start').click();
    await settle();
    expect(el('export-error').textContent).toContain('An ad is playing');
  });

  it('on a GPU without shader-f16 the model row offers the fp32 Default download', async () => {
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { gpu: { requestAdapter: async () => ({ features: new Set() }) } }));
    const compat = { format: 2, version: 1, files: { 'compat-mdx.onnx': 30 * 2 ** 20, 'compat-vocals.onnx': 39 * 2 ** 20 }, checkedAt: 0 };
    await load({ local: { 'modelRemote.compat': compat } });
    el('export-toggle').click();
    await settle();
    expect(el('export-model-text').textContent).toMatch(/no fp16 support.*69 MB/);
    expect(el('export-model-btn').textContent).toBe('Download supported models');
    choose('export-model', 'deux');
    await settle();
    expect(el('export-model-text').textContent).toMatch(/not supported on this GPU/);
  });

  it('cannot start without a video', async () => {
    await load({ status: status({ videoFound: false }) });
    expect(el<HTMLButtonElement>('export-start').disabled).toBe(true);
  });
});
