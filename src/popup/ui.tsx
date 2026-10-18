import { createContext, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';

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
  return <button {...rest} type={type} disabled={blocked || disabled} className={cx('inline-flex cursor-pointer items-center justify-center gap-2 border-0 font-extrabold transition-[transform,box-shadow,opacity] duration-150 active:scale-[0.97] disabled:cursor-default disabled:opacity-45 disabled:active:scale-100', TONE[tone], className)} />;
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

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** A listbox dropdown: the options open inline under the button (no OS popup, nothing clipped) with a slide. */
export function Select<T extends string>({ id, value, options, onValue }: { id: string; value: T; options: readonly Choice<T>[]; onValue: (v: T) => void }) {
  const blocked = useContext(Blocked);
  const [open, setOpen] = useState(false);
  const selected = Math.max(0, options.findIndex((o) => o.value === value));
  const [active, setActive] = useState(selected);
  const root = useRef<HTMLDivElement>(null);
  const cur = options[selected];
  const optionId = (v: string) => `${id}-option-${v}`;

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const show = () => {
    setActive(selected);
    setOpen(true);
  };
  const pick = (v: T) => {
    setOpen(false);
    if (v !== value) onValue(v);
  };
  const key = (e: KeyboardEvent) => {
    const last = options.length - 1;
    const move = { ArrowDown: Math.min(last, active + 1), ArrowUp: Math.max(0, active - 1), Home: 0, End: last }[e.key];
    if (move !== undefined) {
      e.preventDefault();
      if (open) setActive(move);
      else show();
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div ref={root} className="flex flex-col" onKeyDown={key}>
      <button id={id} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} aria-activedescendant={open ? optionId(options[active].value) : undefined} disabled={blocked}
        // A keyboard Enter / Space on an open list picks the highlighted option; a mouse click toggles it.
        onClick={(e) => (open && e.detail === 0 ? pick(options[active].value) : open ? setOpen(false) : show())}
        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl border-0 bg-well px-3 py-2.5 text-left text-ink shadow-pressed transition-[box-shadow,opacity] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-default disabled:opacity-45">
        <span className="min-w-0">
          <span className="block text-[13px] font-bold">{cur.label}</span>
          {cur.hint && <span className="block text-xs text-muted">{cur.hint}</span>}
        </span>
        <ChevronDown size={16} className={cx('shrink-0 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
      </button>
      <div inert={!open} className={cx('grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out', open ? 'mt-2 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}>
        <ul id={`${id}-list`} role="listbox" aria-labelledby={id} className="m-0 flex min-h-0 list-none flex-col overflow-hidden rounded-xl bg-white p-0">
          {options.map((o, i) => (
            <li key={o.value} id={optionId(o.value)} role="option" aria-selected={o.value === value} data-value={o.value} data-active={open && i === active} onClick={() => pick(o.value)} onPointerMove={() => setActive(i)}
              className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2.5 transition-colors data-[active=true]:bg-brand-tint">
              <span className="min-w-0">
                <span className={cx('block text-[13px]', o.value === value ? 'font-extrabold text-brand-dark' : 'font-semibold')}>{o.label}</span>
                {o.hint && <span className="block text-xs text-muted">{o.hint}</span>}
              </span>
              <Check size={16} className={cx('shrink-0 text-brand transition-opacity', o.value === value ? 'opacity-100' : 'opacity-0')} aria-hidden />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
