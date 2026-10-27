import { Download, RefreshCw } from 'lucide-react';
import { motion } from 'motion/react';
import type { MlModel } from '../worklet/protocol';
import { installModel, uninstallModel, type ModelLine } from './models';
import { Btn, type Choice } from './ui';

export const MODEL_CHOICES: readonly Choice<MlModel>[] = [
  { value: 'mdx', label: 'Default' },
  { value: 'roformer', label: 'High quality', hint: 'Optional download' },
  { value: 'deux', label: 'Best Vocal', hint: 'Needs a good GPU, optional download' },
  { value: 'sw', label: 'Focus Instrumental Splitting', hint: 'Needs a good GPU, optional download' },
];

export function ModelRow({ idPrefix, line }: { idPrefix: string; line: ModelLine }) {
  return (
    <div id={`${idPrefix}-row`} className="flex flex-col gap-2">
      <p className="m-0 flex items-center justify-between gap-3 text-xs leading-snug text-muted">
        <span id={`${idPrefix}-text`}>{line.text}</span>
        {line.button && (
          <Btn id={`${idPrefix}-btn`} tone="small" onClick={() => installModel(line.id)}>
            {line.button === 'Update' ? <RefreshCw size={13} aria-hidden /> : <Download size={13} aria-hidden />}
            {line.button}
          </Btn>
        )}
        {line.uninstall && (
          <button id={`${idPrefix}-uninstall`} type="button" onClick={() => uninstallModel(line.id)} className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-xs text-muted underline">
            Uninstall model
          </button>
        )}
      </p>
      {line.progress !== undefined && (
        <div role="progressbar" aria-label="Download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(line.progress)} className="h-2 overflow-hidden rounded-full bg-well shadow-pressed">
          <motion.div initial={false} animate={{ width: `${line.progress}%` }} transition={{ duration: 0.4, ease: 'easeOut' }} className="h-full rounded-full bg-linear-to-r from-[#f2505a] to-[#d3101c]" />
        </div>
      )}
    </div>
  );
}
