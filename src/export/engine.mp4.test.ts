import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LYRICS_PREFS } from '../shared/lyrics-prefs';
import { defaultExportOptions, type ExportProgress } from '../shared/export';
import { DEFAULT_SETTINGS } from '../shared/settings';

const sink = vi.hoisted(() => ({
  frames: [] as [number, number][],
  audio: [] as [string, number][],
  tracks: undefined as unknown,
  size: undefined as unknown,
}));
vi.mock('./encode', async (orig) => ({
  ...(await orig<typeof import('./encode')>()),
  mp4Sink: vi.fn(async (tracks: unknown, _name: string, size: unknown) => {
    sink.tracks = tracks;
    sink.size = size;
    const ctx = { fillRect: vi.fn(), fillStyle: '' };
    return {
      canvas: { width: 8, height: 4, getContext: () => ctx },
      addAudio: async (t: string, l: Float32Array) => void sink.audio.push([t, l.length]),
      addFrame: async (s: number, d: number) => void sink.frames.push([s, d]),
      describe: () => 'fake',
      finish: async () => ({ name: 'x.mp4', blob: new Blob(['x']) }),
      cancel: async () => {},
    };
  }),
}));
const karaoke = vi.hoisted(() => ({ drawKaraoke: vi.fn(), karaokeRows: vi.fn(() => []) }));
vi.mock('./karaoke-render', () => karaoke);

import { runExport } from './engine';

const video = (duration: number) =>
  Object.assign(new EventTarget(), { duration, currentSrc: 'blob:v', currentTime: 5, paused: false, muted: false, playbackRate: 1, seeking: false, ended: false, pause: vi.fn(), play: vi.fn(async () => {}) });

beforeEach(() => {
  sink.frames.length = 0;
  sink.audio.length = 0;
  karaoke.drawKaraoke.mockClear();
});

describe('an MP4 without audio', () => {
  it('draws the text frame by frame at 30 fps; nothing is recorded, separated or touched on the video', async () => {
    const v = video(2);
    const openSession = vi.fn();
    const reports: ExportProgress[] = [];
    const o = { ...defaultExportOptions(DEFAULT_SETTINGS, DEFAULT_LYRICS_PREFS, 'mp4'), withAudio: false, tracks: 'separate' as const, height: 360 };
    const file = await runExport({ video: v as unknown as HTMLVideoElement, options: o, lyrics: { lines: [], offsetMs: 0 }, title: 'x', signal: new AbortController().signal, report: (p) => reports.push(p), openSession });
    expect(file.name).toBe('x.mp4');
    expect(sink.frames).toHaveLength(60);
    expect(sink.frames[0]).toEqual([0, 1 / 30]);
    expect(sink.frames[59]![0]).toBeCloseTo(59 / 30, 6);
    expect(sink.tracks).toEqual([]);
    expect(sink.size).toEqual({ w: 640, h: 360 });
    expect(sink.audio).toEqual([]);
    expect(openSession).not.toHaveBeenCalled();
    expect(karaoke.drawKaraoke).toHaveBeenCalledTimes(60);
    expect(v.pause).not.toHaveBeenCalled();
    expect(v.play).not.toHaveBeenCalled();
    expect(v.currentTime).toBe(5);
    expect(reports.some((r) => /Drawing the text/.test(r.detail))).toBe(true);
  });

  it('draws no text when the video has no lyrics, and stops on cancel', async () => {
    const ac = new AbortController();
    const o = { ...defaultExportOptions(DEFAULT_SETTINGS, DEFAULT_LYRICS_PREFS, 'mp4'), withAudio: false };
    sink.frames.length = 0;
    const done = runExport({ video: video(600) as unknown as HTMLVideoElement, options: o, lyrics: null, title: 'x', signal: ac.signal, report: () => {} });
    setTimeout(() => ac.abort(), 20);
    await expect(done).rejects.toThrow('Export cancelled');
    expect(karaoke.drawKaraoke).not.toHaveBeenCalled();
    expect(sink.frames.length).toBeLessThan(18000);
  });
});
