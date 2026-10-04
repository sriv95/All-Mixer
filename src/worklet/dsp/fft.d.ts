export class FFT {
  constructor(n: number);
  readonly n: number;
  /** In-place complex FFT; `inverse` is unscaled (divide by n). */
  transform(re: Float64Array, im: Float64Array, inverse?: boolean): void;
}
