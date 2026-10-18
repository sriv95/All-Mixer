import { createContext, useContext, useEffect, useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { animate, motion } from 'motion/react';

/** True on a page the extension cannot run on: every control below is disabled. */
export const Blocked = createContext(false);

/** The enter / exit of a panel or banner: a short fade with a small slide. */
export const fade = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 }, transition: { duration: 0.18 } } as const;

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

/**
 * The value a slider shows. A change the user made (a drag) shows at once; any other change (a preset, Reset)
 * glides there, and the thumb, the fill and the number move together.
 */
export function useGlide(value: number): { shown: number; gliding: boolean; mine: (v: number) => void } {
  const [shown, setShown] = useState(value);
  const at = useRef(value);
  const mine = useRef<number | null>(null);
  useEffect(() => {
    if (at.current === value) return;
    if (mine.current === value || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      at.current = value;
      setShown(value);
      return;
    }
    mine.current = null;
    const run = animate(at.current, value, { duration: 0.35, ease: 'easeOut', onUpdate: (v) => { at.current = v; setShown(v); } });
    return () => run.stop();
  }, [value]);
  return { shown, gliding: shown !== value, mine: (v) => (mine.current = v) };
}

interface RangeProps extends SliderProps {
  /** The value to draw, when it differs from `value` (while gliding). */
  shown?: number;
}

export function Slider({ id, value, shown = value, min, max, step, onValue, disabled }: RangeProps) {
  const blocked = useContext(Blocked);
  const style = { '--p': ((shown - min) / (max - min)) * 100 } as CSSProperties;
  // A glide passes between the steps: let the thumb follow it.
  return <input id={id} type="range" className="mx-range" min={min} max={max} step={shown !== value ? 'any' : step} value={shown} style={style} disabled={blocked || disabled} onChange={(e) => onValue(Number(e.currentTarget.value))} />;
}

/** A labelled slider with its value (and `unit`) on the right. */
export function SliderRow({ id, label, icon, unit, hint, onValue, ...slider }: SliderProps & { label: ReactNode; icon: ReactNode; unit: string; hint?: ReactNode }) {
  const { shown, mine } = useGlide(slider.value);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="flex items-center gap-1.5 text-[13px] font-bold">
          <span className="text-brand" aria-hidden>{icon}</span>
          {label}
          {hint && <span className="text-xs font-medium text-muted">{hint}</span>}
        </label>
        <output id={`${id}-value`} htmlFor={id} className="min-w-12 text-right text-[15px] font-extrabold tabular-nums">{Math.round(shown)}{unit}</output>
      </div>
      <Slider id={id} {...slider} shown={shown} onValue={(v) => { mine(v); onValue(v); }} />
    </div>
  );
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string; id?: string }) {
  return <div {...rest} className={cx('flex flex-col gap-3.5 rounded-[20px] bg-card p-4', className)}>{children}</div>;
}

type BtnProps = ComponentProps<typeof motion.button> & { tone?: 'raised' | 'primary' | 'small' | 'preset' };
const TONE = {
  raised: 'h-11 w-full rounded-[14px] bg-card text-sm font-extrabold text-ink shadow-raised',
  primary: 'h-11 w-full rounded-[14px] bg-linear-to-br from-[#ef3a45] to-[#cf1722] text-sm font-extrabold text-white shadow-raised',
  small: 'h-8 rounded-[11px] bg-card px-3 text-xs font-extrabold text-ink shadow-raised-sm',
  // The chosen preset goes bold, the one it replaces goes back to regular: the weight glides (variable font).
  preset: 'w-full rounded-[14px] bg-card py-2.5 text-[13px] text-ink shadow-raised font-semibold transition-[font-weight,color,box-shadow] duration-300 aria-pressed:font-extrabold aria-pressed:text-brand-dark aria-pressed:shadow-pressed',
};

export function Btn({ tone = 'raised', className, disabled, type = 'button', ...rest }: BtnProps) {
  const blocked = useContext(Blocked);
  const off = blocked || disabled;
  return <motion.button {...rest} type={type} disabled={off} whileTap={off ? undefined : { scale: 0.96 }} transition={{ type: 'spring', stiffness: 600, damping: 30 }} className={cx('inline-flex cursor-pointer items-center justify-center gap-2 border-0 transition-[box-shadow,opacity] duration-150 disabled:cursor-default disabled:opacity-45', TONE[tone], className)} />;
}

/** A switch: a real checkbox with role="switch", styled as a pressed track and a raised thumb that slides. */
export function Switch({ id, checked, onChange, disabled }: { id: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  const blocked = useContext(Blocked);
  return (
    <span className="relative inline-flex shrink-0">
      <input id={id} type="checkbox" role="switch" className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-default" checked={checked} disabled={blocked || disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span aria-hidden className={cx('flex h-8 w-[54px] items-center rounded-full p-1 shadow-pressed transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand peer-disabled:opacity-45', checked ? 'justify-end bg-brand-tint' : 'justify-start bg-well')}>
        <motion.span layout transition={{ type: 'spring', stiffness: 700, damping: 35 }} className={cx('size-6 rounded-full shadow-[3px_3px_6px_#d0c6c7,-2px_-2px_5px_#fff] transition-colors', checked ? 'bg-brand' : 'bg-well')} />
      </span>
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
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }} className="grid shrink-0"><ChevronDown size={16} aria-hidden /></motion.span>
      </button>
      <motion.div initial={false} inert={!open} animate={open ? { height: 'auto', opacity: 1, marginTop: 8 } : { height: 0, opacity: 0, marginTop: 0 }} transition={{ duration: 0.22, ease: 'easeOut' }} className="overflow-hidden">
        <ul id={`${id}-list`} role="listbox" aria-labelledby={id} className="m-0 flex list-none flex-col overflow-hidden rounded-xl bg-white p-0">
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
      </motion.div>
    </div>
  );
}

/** A section that slides open: a button (aria-expanded) over a body whose height animates. The body stays mounted, inert while closed. */
export function Disclosure({ id, open, onOpen, title, className, buttonClassName, children }: { id: string; open: boolean; onOpen: (open: boolean) => void; title: ReactNode; className?: string; buttonClassName?: string; children: ReactNode }) {
  return (
    <section id={id} className={className}>
      <button id={`${id}-toggle`} type="button" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => onOpen(!open)} className={cx('flex w-full cursor-pointer items-center justify-between border-0 bg-transparent text-left text-[13px] font-bold text-ink focus-visible:outline-2 focus-visible:outline-brand', buttonClassName)}>
        {title}
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }} className="grid"><ChevronDown size={16} aria-hidden /></motion.span>
      </button>
      <motion.div id={`${id}-body`} initial={false} inert={!open} animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }} transition={{ duration: 0.25, ease: 'easeInOut' }} className="overflow-hidden">
        {children}
      </motion.div>
    </section>
  );
}
