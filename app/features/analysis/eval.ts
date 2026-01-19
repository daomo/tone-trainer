import type { ComparisonResult } from "../../lib/types";

type EvalInput = {
  ref: number[];
  user: number[];
  refTimes: number[];
  userTimes: number[];
  path: Array<[number, number]>;
};

export function evaluateAlignment(input: EvalInput): ComparisonResult {
  const { ref, user, refTimes, userTimes, path } = input;
  const aligned = alignByPath(ref, user, path);
  const corr = pearson(aligned.ref, aligned.user);
  const rmse = rmseAligned(aligned.ref, aligned.user);
  const slopeMatch = slopeMatchRate(aligned.ref, aligned.user);
  const peakShiftMs = peakShift(ref, user, refTimes, userTimes, path);

  return { corr, rmse, slopeMatch, peakShiftMs };
}

function alignByPath(
  ref: number[],
  user: number[],
  path: Array<[number, number]>
) {
  const a: number[] = [];
  const b: number[] = [];
  for (const [i, j] of path) {
    a.push(ref[i]);
    b.push(user[j]);
  }
  return { ref: a, user: b };
}

function pearson(a: number[], b: number[]) {
  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sumA += x;
    sumB += y;
    sumAA += x * x;
    sumBB += y * y;
    sumAB += x * y;
    count++;
  }
  if (count < 2) return 0;
  const num = (count * sumAB) - (sumA * sumB);
  const denA = (count * sumAA) - (sumA * sumA);
  const denB = (count * sumBB) - (sumB * sumB);
  const den = Math.sqrt(Math.max(1e-8, denA * denB));
  return num / den;
}

function rmseAligned(a: number[], b: number[]) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const d = x - y;
    sum += d * d;
    count++;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

function slopeMatchRate(a: number[], b: number[]) {
  let match = 0;
  let count = 0;
  for (let i = 1; i < a.length; i++) {
    const a0 = a[i - 1], a1 = a[i];
    const b0 = b[i - 1], b1 = b[i];
    if (!Number.isFinite(a0) || !Number.isFinite(a1) || !Number.isFinite(b0) || !Number.isFinite(b1)) continue;
    const sa = Math.sign(a1 - a0);
    const sb = Math.sign(b1 - b0);
    if (sa === 0 && sb === 0) continue;
    if (sa === sb) match++;
    count++;
  }
  return count > 0 ? match / count : 0;
}

function peakShift(
  ref: number[],
  user: number[],
  refTimes: number[],
  userTimes: number[],
  path: Array<[number, number]>
) {
  let refPeakIdx = -1;
  let refPeak = -Infinity;
  for (let i = 0; i < ref.length; i++) {
    const v = ref[i];
    if (!Number.isFinite(v)) continue;
    if (v > refPeak) {
      refPeak = v;
      refPeakIdx = i;
    }
  }
  if (refPeakIdx < 0) return 0;

  const mapping = new Map<number, number[]>();
  for (const [ri, ui] of path) {
    const existing = mapping.get(ri);
    if (existing) {
      existing.push(ui);
    } else {
      mapping.set(ri, [ui]);
    }
  }
  const targets = mapping.get(refPeakIdx);
  if (!targets || targets.length === 0) return 0;
  const avgUi = targets.reduce((a, b) => a + b, 0) / targets.length;

  const tRef = refTimes[refPeakIdx] ?? 0;
  const tUser = userTimes[Math.round(avgUi)] ?? 0;
  return (tUser - tRef) * 1000;
}
