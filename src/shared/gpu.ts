import type { GpuPreference } from '../worklet/protocol';

export interface GpuInfoLike {
  vendor?: string;
  architecture?: string;
  description?: string;
}

/** The adapter's name as WebGPU reports it (vendor, architecture, description), unchanged. */
export const adapterName = (info: GpuInfoLike | undefined): string =>
  [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ') || 'unknown';

type Gpu = { requestAdapter(o?: { powerPreference: string }): Promise<{ isFallbackAdapter?: boolean; info?: GpuInfoLike } | null> };

/** What each GPU preference resolves to on this machine (a preference with no real adapter is left out). */
export async function probeGpuNames(gpu: Gpu | undefined = (navigator as Navigator & { gpu?: Gpu }).gpu): Promise<Partial<Record<GpuPreference, string>>> {
  const out: Partial<Record<GpuPreference, string>> = {};
  if (!gpu) return out;
  await Promise.all(
    (['auto', 'high-performance', 'low-power'] as const).map(async (p) => {
      try {
        const a = await gpu.requestAdapter(p === 'auto' ? undefined : { powerPreference: p });
        if (a && !a.isFallbackAdapter) out[p] = adapterName(a.info);
      } catch {
        // no adapter for this preference: keep the generic hint
      }
    }),
  );
  return out;
}

export type GpuNames = Partial<Record<GpuPreference, string>>;

/** The GPUs to choose from, by raw name (one entry per distinct name); generic labels while no name is known. */
export function gpuOptions(names: GpuNames): { value: GpuPreference; label: string }[] {
  const seen = new Set<string>();
  const out: { value: GpuPreference; label: string }[] = [];
  for (const value of ['high-performance', 'low-power'] as const) {
    const label = names[value];
    if (label && !seen.has(label)) {
      seen.add(label);
      out.push({ value, label });
    }
  }
  return out.length ? out : [{ value: 'auto', label: 'Automatic' }, { value: 'high-performance', label: 'Fast GPU' }, { value: 'low-power', label: 'Built-in GPU' }];
}

/** The option that shows `pref`: the one with the same GPU name (Automatic and a name shared by both preferences resolve this way). */
export function gpuSelected(names: GpuNames, pref: GpuPreference): GpuPreference {
  const opts = gpuOptions(names);
  if (opts.some((o) => o.value === pref)) return pref;
  return opts.find((o) => o.label === names[pref])?.value ?? pref;
}
