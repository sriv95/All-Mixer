import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRICS_PREFS } from './lyrics-prefs';
import { DEFAULT_SETTINGS } from './settings';
import { clock, defaultExportOptions, needsSeparation, normalizeExportOptions, partsOf, safeFileName, stemsOf, tracksOf } from './export';

const audio = (over: object) => ({ ...DEFAULT_SETTINGS, ...over });

describe('export options', () => {
  it('the parts of the instrumental follow the model and the split switches', () => {
    expect(partsOf(audio({}))).toEqual([]);
    expect(partsOf(audio({ splitInstrumental: true }))).toEqual(['drums']);
    expect(partsOf(audio({ splitGuitar: true, splitInstrumental: true }))).toEqual(['drums', 'guitar']);
    expect(partsOf(audio({ mlModel: 'sw' }))).toEqual(['drums', 'guitar', 'bass', 'piano']);
  });

  it('separate tracks: the mix, the vocals, then the instrumental or its parts and the rest', () => {
    expect(tracksOf({ tracks: 'single', audio: audio({}) })).toEqual(['mix']);
    expect(tracksOf({ tracks: 'separate', audio: audio({}) })).toEqual(['mix', 'vocals', 'instrumental']);
    expect(tracksOf({ tracks: 'separate', audio: audio({ splitGuitar: true }) })).toEqual(['mix', 'vocals', 'guitar', 'others']);
    expect(stemsOf(audio({ mlModel: 'sw' }))).toEqual(['vocals', 'drums', 'guitar', 'bass', 'piano', 'others']);
  });

  it('the model is needed for stems and for any level that is not 100 %, not for a plain recording', () => {
    expect(needsSeparation({ tracks: 'single', audio: audio({}) })).toBe(false);
    expect(needsSeparation({ tracks: 'single', audio: audio({ masterPct: 300 }) })).toBe(false);
    expect(needsSeparation({ tracks: 'single', audio: audio({ vocalPct: 0 }) })).toBe(true);
    expect(needsSeparation({ tracks: 'single', audio: audio({ instrumentalPct: 95 }) })).toBe(true);
    expect(needsSeparation({ tracks: 'single', audio: audio({ splitInstrumental: true, drumsPct: 50 }) })).toBe(true);
    expect(needsSeparation({ tracks: 'single', audio: audio({ drumsPct: 50 }) })).toBe(false); // the drums switch is off: the level does not apply
    expect(needsSeparation({ tracks: 'separate', audio: audio({}) })).toBe(true);
  });

  it('starts from the live settings and the live text look, and keeps them as a copy', () => {
    const live = audio({ vocalPct: 20, mlModel: 'deux' });
    const o = defaultExportOptions(live, { ...DEFAULT_LYRICS_PREFS, karaokeColor: '#ff0000', karaokeLines: 2 }, 'mp4');
    expect(o).toMatchObject({ format: 'mp4', tracks: 'single', height: 720, audio: { vocalPct: 20, mlModel: 'deux' }, text: { karaokeColor: '#ff0000', karaokeLines: 2 } });
    o.audio.vocalPct = 99;
    expect(live.vocalPct).toBe(20);
  });

  it('any message becomes valid options', () => {
    expect(normalizeExportOptions(null)).toMatchObject({ format: 'mp3', tracks: 'single', height: 720, audio: { masterPct: 100 } });
    const o = normalizeExportOptions({ format: 'mp4', tracks: 'separate', height: 500, audio: { vocalPct: 500, mlModel: 'nope' }, text: { karaokeColor: 'red', karaokeFontSize: 9000 } });
    expect(o).toMatchObject({ format: 'mp4', tracks: 'separate', height: 480, audio: { vocalPct: 100, mlModel: 'mdx' }, text: { karaokeColor: '#ffffff', karaokeFontSize: 200 } });
  });
});

describe('export helpers', () => {
  it('clock', () => {
    expect([clock(0), clock(9.9), clock(65), clock(3600), clock(3725)]).toEqual(['0:00', '0:09', '1:05', '1:00:00', '1:02:05']);
  });

  it('file names lose path and reserved characters', () => {
    expect(safeFileName('AC/DC: Back in Black?')).toBe('AC DC Back in Black');
    expect(safeFileName('   ')).toBe('all-mixer');
    expect(safeFileName('a\u0000b\nc')).toBe('a b c');
    expect(safeFileName('x'.repeat(300))).toHaveLength(80);
  });
});
