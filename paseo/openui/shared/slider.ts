/** Position of `value` along a slider, 0 at min and 1 at max. */
export function sliderFraction(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** The value a slider holds at `fraction` of its track, snapped to `step` and kept inside the range. */
export function sliderValue(fraction: number, min: number, max: number, step: number): number {
  const size = step > 0 ? step : 1;
  const raw = min + Math.min(1, Math.max(0, fraction)) * (max - min);
  const snapped = min + Math.round((raw - min) / size) * size;
  const bounded = Math.min(max, Math.max(min, snapped));
  return Number(bounded.toFixed(10));
}
