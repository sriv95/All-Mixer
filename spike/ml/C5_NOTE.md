# C5 desk note: RoFormer / HTDemucs on ORT Web WebGPU (SRI-100)

Desk research from prior knowledge only. Nothing here was built or measured, and the figures below are estimates. Re-check them before relying on any of them.

| Model | fp32 size | License | Ops / risk | RTF estimate (M1 WebGPU) |
|---|---|---|---|---|
| HTDemucs (4-stem) | ~160 MB | MIT (facebookresearch/demucs) | STFT/iSTFT inside the graph, a cross-domain transformer, and complex-as-real tensors. ONNX export needs the STFT moved out of the graph, and it has no dynamic-length support. | ~0.5–1.0 (segment 7.8 s, ~40 M params) |
| BS-RoFormer (vocals) | 200–350 MB | Weights are community-trained, with mixed licenses. | RoPE, many band-split linears, and 6–12 transformer layers over time and band axes. Attention over a long T makes it memory-bound on WebGPU. | ~1+ (likely not real-time) |
| Mel-Band RoFormer (vocals) | ~230 MB | Same as above. | Same ops as BS-RoFormer, plus a mel band-split gather. | ~1+ |

**Verdict:** not built. All three are 10× or more the size of MDX 9482 (29.7 MB fp32, 14.9 MB fp16). They are likely at or above 1.0 RTF on WebGPU, and the export is not a day-one job (STFT out of the graph, RoPE and attention shapes). Revisit only if MDX-Net cannot meet the quality bar. If so, the lowest-risk first try is a fp16 Mel-RoFormer with a fixed segment length and the STFT done in JS or WASM.
