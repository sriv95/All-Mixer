import { CircleCheck, Download, HardDriveDownload, LoaderCircle, Radio, RefreshCw, Square, TriangleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { PreloadStatus } from '../shared/preload';
import type { MixerSettings } from '../shared/settings';
import { Btn, Collapse, fade } from './ui';

export interface PreloadApi {
  status: PreloadStatus | undefined;
  /** Starts the preload of the open video; resolves to the reason when it could not start. */
  start(): Promise<string | undefined>;
  cancel(): void;
}

const icon = 'grid size-9 shrink-0 place-items-center rounded-full';
// The Export section is open in Preload mode unless the user closed it: open it and bring it into view.
const showExport = (): void => {
  const t = document.getElementById('export-toggle');
  if (t?.getAttribute('aria-expanded') !== 'true') t?.click();
  document.getElementById('export')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
};
const mb = (n: number): string => `${Math.round(n / 1e6)} MB`;

/** Under the Separate tab while Preload Audio is the mode: the progress of the preload, then what plays. */
export function PreloadBanner({ api, settings, update, compact }: { api: PreloadApi; settings: MixerSettings; update: (patch: Partial<MixerSettings>) => void; compact: boolean }) {
  const s = api.status ?? { state: 'idle' as const };
  const p = s.progress;
  const live = (
    <Btn id="preload-live" onClick={() => update({ preload: false })}>
      <Radio size={16} aria-hidden />Use Live mode
    </Btn>
  );
  const pitched = settings.pitch !== 0 || (settings.pitchSplit && (settings.vocalPitch !== 0 || settings.instrPitch !== 0));
  let tone: 'brand' | 'stop' = 'brand';
  let head: ReactNode;
  let title: string;
  let text: string;
  let actions: ReactNode = null;
  switch (s.state) {
    case 'loading':
      head = <span className={`${icon} bg-white text-brand`}><motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, ease: 'linear', duration: 1 }} className="grid"><LoaderCircle size={20} aria-hidden /></motion.span></span>;
      title = 'Preloading audio';
      text = 'Separating the whole video first. Keep this tab open.';
      break;
    case 'ready':
      head = <span className={`${icon} bg-brand text-white`}><CircleCheck size={20} aria-hidden /></span>;
      title = 'Playing the preloaded audio';
      text = `Separated up front: no live delay, no deadline (${mb(s.bytes ?? 0)} in memory).`;
      if (s.holding) text = `The original audio plays now: ${s.holding}.`;
      else if (s.stale) text = 'This was preloaded with another model or split setting. Preload again to apply it.';
      else if (pitched) text += ' Pitch shift does not apply in this mode.';
      actions = (
        <>
          {s.stale && !s.holding && <Btn tone="primary" id="preload-again" onClick={() => void api.start()}><RefreshCw size={16} aria-hidden />Preload again</Btn>}
          {live}
        </>
      );
      break;
    case 'error':
      tone = 'stop';
      head = <span className={`${icon} bg-brand text-white`}><TriangleAlert size={20} aria-hidden /></span>;
      title = 'Preloading stopped';
      text = `${(p?.error ?? 'Something went wrong').replace(/[.\s]*$/, '.')} The original audio plays.`;
      actions = (
        <>
          {s.tooBig ? (
            <Btn tone="primary" id="preload-export" onClick={showExport}><Download size={16} aria-hidden />Export instead</Btn>
          ) : (
            <Btn tone="primary" id="preload-retry" onClick={() => void api.start()}><RefreshCw size={16} aria-hidden />Try again</Btn>
          )}
          {live}
        </>
      );
      break;
    default:
      head = <span className={`${icon} bg-brand text-white`}><HardDriveDownload size={20} aria-hidden /></span>;
      title = s.state === 'cancelled' ? 'Preloading cancelled' : 'Not preloaded yet';
      text = 'The original audio plays. Preload separates this video up front.';
      actions = (
        <>
          <Btn tone="primary" id="preload-start" onClick={() => void api.start()}><HardDriveDownload size={16} aria-hidden />Preload audio</Btn>
          {live}
        </>
      );
  }
  return (
    <motion.div {...fade} className="flex flex-col gap-3.5">
      <div id="preload-banner" role="status" data-state={s.state} className={`flex items-start gap-3 rounded-[20px] p-3.5 transition-colors duration-300 ${tone === 'stop' ? 'bg-stop text-white' : 'bg-brand-tint'}`}>
        <motion.span key={`icon-${s.state}`} initial={{ scale: 0.4, opacity: 0, rotate: -30 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 22 }} className="shrink-0">{head}</motion.span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-sm font-extrabold">{title}</h2>
          <Collapse show={!compact || s.state === 'error'}><p id="preload-text" className={`m-0 mt-0.5 text-[12.5px] leading-snug ${tone === 'stop' ? 'text-[#ddd0d2]' : 'text-banner'}`}>{text}</p></Collapse>
          {s.state === 'loading' && p && (
            <div className="mt-2.5 flex flex-col gap-2">
              <div id="preload-progress" role="progressbar" aria-label="Preload" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(p.percent)} className="h-1.5 overflow-hidden rounded-full bg-surface">
                {p.stage === 'model' || p.stage === 'preparing' || p.stage === 'fetching' ? (
                  <motion.span animate={{ x: ['-100%', '300%'] }} transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }} className="block h-full w-1/3 rounded-full bg-brand" />
                ) : (
                  <motion.div initial={false} animate={{ width: `${p.percent}%` }} transition={{ duration: 0.4, ease: 'easeOut' }} className="h-full rounded-full bg-brand" />
                )}
              </div>
              <p id="preload-detail" className="m-0 text-xs leading-snug text-banner">{p.stage === 'recording' ? `${Math.floor(p.percent)}% · ` : ''}{p.detail}</p>
            </div>
          )}
        </div>
      </div>
      {s.state === 'loading' && (
        <Btn id="preload-cancel" onClick={api.cancel}><Square size={14} aria-hidden />Cancel</Btn>
      )}
      {actions && <div className="flex flex-col gap-2.5">{actions}</div>}
    </motion.div>
  );
}

/** Advanced: Live or Preload Audio. */
export function ProcessingRow({ settings, update }: { settings: MixerSettings; update: (patch: Partial<MixerSettings>) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-bold">Processing</span>
      <div className="grid grid-cols-2 gap-2.5" role="group" aria-label="Processing">
        <Btn id="processing-live" tone="preset" aria-pressed={!settings.preload} onClick={() => update({ preload: false })}><Radio size={15} aria-hidden />Live</Btn>
        <Btn id="processing-preload" tone="preset" aria-pressed={settings.preload} onClick={() => update({ preload: true })}><HardDriveDownload size={15} aria-hidden />Preload audio</Btn>
      </div>
      <p id="processing-note" className="m-0 text-xs leading-snug text-muted">
        {settings.preload ? 'Processes the whole video first, then plays it. No pitch shift.' : 'Processes while it plays.'}
      </p>
    </div>
  );
}
