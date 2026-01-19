export function normalizeLogF0(values: number[]) {
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    sum += v;
    sumSq += v * v;
    count++;
  }
  if (count === 0) return values.slice();

  const mean = sum / count;
  const variance = Math.max(1e-6, (sumSq / count) - mean * mean);
  const std = Math.sqrt(variance);

  return values.map((v) => (Number.isFinite(v) ? (v - mean) / std : NaN));
}
