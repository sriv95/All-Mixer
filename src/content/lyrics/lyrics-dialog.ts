import type { FoundLyrics, LrclibRecord } from '../../lyrics/lrclib-types';
import { customFound } from '../../lyrics/custom';
import type { TrackInfo } from '../../lyrics/types';
import { cleanArtist, cleanTitle } from '../../lyrics/match';

const DIALOG_ATTR = 'data-allmixer-lyrics-dialog';

const BACKDROP_CSS = 'position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);';
const PANEL_CSS =
  'width:min(520px,92vw);max-height:80vh;display:flex;flex-direction:column;gap:10px;padding:16px;background:#212121;color:#fff;border-radius:10px;font:14px/1.4 Roboto,Arial,sans-serif;box-shadow:0 8px 40px rgba(0,0,0,.7);';
const INPUT_CSS = 'flex:1;min-width:0;font:inherit;color:#fff;background:#333;border:1px solid rgba(255,255,255,.3);border-radius:4px;padding:6px 8px;';
const BUTTON_CSS = 'font:inherit;color:#fff;background:#333;border:1px solid rgba(255,255,255,.3);border-radius:4px;padding:6px 12px;cursor:pointer;';

/** The dialog's frame: backdrop + panel with a title; Escape and a click on the backdrop close it. Only one is open at a time. */
export function openDialogShell(doc: Document, title: string): { panel: HTMLElement; close(): void } {
  doc.querySelector(`[${DIALOG_ATTR}]`)?.remove();
  const backdrop = doc.createElement('div');
  backdrop.setAttribute(DIALOG_ATTR, '');
  backdrop.style.cssText = BACKDROP_CSS;
  const panel = doc.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', title);
  panel.style.cssText = PANEL_CSS;
  const h = doc.createElement('div');
  h.textContent = title;
  h.style.cssText = 'font-size:16px;font-weight:500;';
  panel.append(h);
  backdrop.append(panel);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  // Typing here must not trigger YouTube's shortcuts (Space = pause, arrows = seek, f = fullscreen).
  for (const ev of ['keydown', 'keyup', 'keypress'] as const) {
    backdrop.addEventListener(ev, (e) => {
      e.stopPropagation();
      if (ev === 'keydown' && (e as KeyboardEvent).key === 'Escape') close();
    });
  }
  (doc.fullscreenElement ?? doc.body).append(backdrop);
  return { panel, close };
}

export function dialogInput(doc: Document, value: string, placeholder: string): HTMLInputElement {
  const input = doc.createElement('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.style.cssText = INPUT_CSS;
  return input;
}

export function dialogButton(doc: Document, text: string, onClick: () => void): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.style.cssText = BUTTON_CSS;
  b.addEventListener('click', onClick);
  return b;
}

const fmtDuration = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Synced first, then the closest in length to the video. */
export function rankRecords(records: readonly LrclibRecord[], videoDuration: number): LrclibRecord[] {
  const gap = (r: LrclibRecord) => (videoDuration > 0 ? Math.abs(r.duration - videoDuration) : 0);
  return [...records].sort((a, b) => Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics) || gap(a) - gap(b));
}

export interface FindDialogDeps {
  track?: TrackInfo;
  search(q: string): Promise<LrclibRecord[]>;
  /** The user picked a result. */
  choose(record: LrclibRecord): void;
  /** The user wants the automatic lyrics back. */
  reset(): void;
}

/** "Find other lyrics": a search box (filled from the video), the LRCLIB results, and a way back to the automatic match. */
export function openFindDialog(deps: FindDialogDeps, doc: Document = document): () => void {
  const { panel, close } = openDialogShell(doc, 'Find other lyrics');
  const wantDuration = deps.track?.duration ?? 0;
  const row = doc.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;';
  const query = deps.track ? `${cleanArtist(deps.track.artist)} ${cleanTitle(deps.track.title)}`.trim() : '';
  const input = dialogInput(doc, query, 'Artist and title');
  const status = doc.createElement('div');
  status.style.cssText = 'opacity:.7;font-size:12px;';
  const list = doc.createElement('div');
  list.style.cssText = 'overflow:auto;display:flex;flex-direction:column;gap:4px;';

  let token = 0;
  const run = () => {
    const mine = ++token;
    status.textContent = 'Searching…';
    list.replaceChildren();
    deps.search(input.value).then(
      (records) => {
        if (mine !== token) return;
        status.textContent = records.length ? 'Pick the lyrics to use for this video. This also sets Lyrics source to LRCLIB.' : 'No lyrics found. Try other words.';
        for (const r of rankRecords(records, wantDuration)) {
          const b = doc.createElement('button');
          b.type = 'button';
          b.setAttribute('data-record', String(r.id));
          b.style.cssText = `${BUTTON_CSS}text-align:left;display:block;`;
          const gap = wantDuration > 0 ? Math.round(r.duration - wantDuration) : null;
          const title = doc.createElement('div');
          title.textContent = `${r.trackName} — ${r.artistName}`;
          const meta = doc.createElement('div');
          meta.style.cssText = 'opacity:.7;font-size:12px;';
          meta.textContent = [fmtDuration(r.duration), r.syncedLyrics ? 'synced' : 'plain text', gap === null ? '' : `${gap > 0 ? '+' : ''}${gap} s vs video`].filter(Boolean).join(' · ');
          b.append(title, meta);
          b.addEventListener('click', () => {
            deps.choose(r);
            close();
          });
          list.append(b);
        }
      },
      () => {
        if (mine === token) status.textContent = 'Search failed. Check your connection.';
      },
    );
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
  });
  row.append(input, dialogButton(doc, 'Search', run));

  const footer = doc.createElement('div');
  footer.style.cssText = 'display:flex;gap:8px;justify-content:space-between;';
  footer.append(
    dialogButton(doc, 'Back to automatic', () => {
      deps.reset();
      close();
    }),
    dialogButton(doc, 'Close', close),
  );
  panel.append(row, status, list, footer);
  input.focus();
  if (query) run();
  return close;
}

/** Largest file the "Load file" button reads. */
const MAX_FILE_BYTES = 1_000_000;

export interface OwnDialogDeps {
  track?: TrackInfo;
  /** The user saved lyrics (already checked: usable). */
  choose(found: FoundLyrics): void;
  /** The user wants the automatic lyrics back. */
  reset(): void;
}

/** "Use my own lyrics": paste text or load a .lrc / .txt file. Timestamped lines make synced lyrics, anything else plain text. */
export function openOwnDialog(deps: OwnDialogDeps, doc: Document = document): () => void {
  const { panel, close } = openDialogShell(doc, 'Use my own lyrics');
  const area = doc.createElement('textarea');
  area.rows = 10;
  area.placeholder = 'Paste the lyrics here. Lines like [01:23.45] text make them synced.';
  area.style.cssText = `${INPUT_CSS}flex:none;width:100%;box-sizing:border-box;resize:vertical;`;
  const status = doc.createElement('div');
  status.style.cssText = 'opacity:.7;font-size:12px;';
  status.textContent = 'Kept for this video. This also sets Lyrics source to LRCLIB.';

  const file = doc.createElement('input');
  file.type = 'file';
  file.accept = '.lrc,.txt,text/plain';
  file.style.display = 'none';
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) {
      status.textContent = 'That file is too big for lyrics.';
      return;
    }
    void f.text().then((t) => {
      area.value = t;
      status.textContent = `Loaded ${f.name}.`;
    });
  });

  const save = () => {
    const found = customFound(area.value, deps.track);
    if (!found) {
      status.textContent = 'Need at least 4 lines of lyrics.';
      return;
    }
    deps.choose(found);
    close();
  };
  const footer = doc.createElement('div');
  footer.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:space-between;';
  footer.append(
    dialogButton(doc, 'Load file…', () => file.click()),
    dialogButton(doc, 'Back to automatic', () => {
      deps.reset();
      close();
    }),
    dialogButton(doc, 'Save', save),
    dialogButton(doc, 'Close', close),
  );
  panel.append(area, status, footer, file);
  area.focus();
  return close;
}
