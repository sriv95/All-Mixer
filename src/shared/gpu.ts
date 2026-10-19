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
