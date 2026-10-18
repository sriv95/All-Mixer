import { createContext, useContext, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';

/** True on a page the extension cannot run on: every control below is disabled. */
export const Blocked = createContext(false);

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

interface SliderProps {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onValue: (v: number) => void;
  disabled?: boolean;
}

export function Slider({ id, value, min, max, step, onValue, disabled }: SliderProps) {
  const blocked = useContext(Blocked);
  const style = { '--p': ((value - min) / (max - min)) * 100 } as CSSProperties;
  return <input id={id} type="range" className="mx-range" min={min} max={max} step={step} value={value} style={style} disabled={blocked || disabled} onChange={(e) => onValue(Number(e.currentTarget.value))} />;
}

/** A labelled slider with its value on the right. */
export function SliderRow({ id, label, icon, valueText, hint, ...slider }: SliderProps & { label: ReactNode; icon: ReactNode; valueText: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="flex items-center gap-1.5 text-[13px] font-bold">
          <span className="text-brand" aria-hidden>{icon}</span>
          {label}
          {hint && <span className="text-xs font-medium text-muted">{hint}</span>}
        </label>
        <output id={`${id}-value`} htmlFor={id} className="min-w-12 text-right text-[15px] font-extrabold tabular-nums">{valueText}</output>
      </div>
      <Slider id={id} {...slider} />
    </div>
  );
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string; id?: string }) {
  return <div {...rest} className={cx('flex flex-col gap-3.5 rounded-[20px] bg-card p-4', className)}>{children}</div>;
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'raised' | 'primary' | 'small' };
const TONE = {
  raised: 'h-11 w-full rounded-[14px] bg-card text-sm text-ink shadow-raised',
  primary: 'h-11 w-full rounded-[14px] bg-linear-to-br from-[#ef3a45] to-[#cf1722] text-sm text-white shadow-raised',
  small: 'h-8 rounded-[11px] bg-card px-3 text-xs text-ink shadow-raised-sm',
};

export function Btn({ tone = 'raised', className, disabled, type = 'button', ...rest }: BtnProps) {
  const blocked = useContext(Blocked);
  return <button {...rest} type={type} disabled={blocked || disabled} className={cx('inline-flex cursor-pointer items-center justify-center gap-2 border-0 font-extrabold disabled:cursor-default disabled:opacity-45', TONE[tone], className)} />;
}

/** A switch: a real checkbox with role="switch", styled as a pressed track and a raised thumb. */
export function Switch({ id, checked, onChange, disabled }: { id: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  const blocked = useContext(Blocked);
  return (
    <span className="relative inline-flex shrink-0">
      <input id={id} type="checkbox" role="switch" className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-default" checked={checked} disabled={blocked || disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span aria-hidden className="h-8 w-[54px] rounded-full bg-well shadow-pressed transition-colors peer-checked:bg-brand-tint peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand peer-disabled:opacity-45" />
      <span aria-hidden className="pointer-events-none absolute left-1 top-1 size-6 rounded-full bg-well shadow-[3px_3px_6px_#d0c6c7,-2px_-2px_5px_#fff] transition-transform peer-checked:translate-x-[22px] peer-checked:bg-brand" />
    </span>
  );
}
