type DtwResult = {
  cost: number;
  path: Array<[number, number]>;
};

export function dtwBand(
  a: number[],
  b: number[],
  bandRatio = 0.15,
  nanCost = 1.0
): DtwResult {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return { cost: Number.POSITIVE_INFINITY, path: [] };

  const band = Math.max(1, Math.floor(Math.max(n, m) * bandRatio) + Math.abs(n - m));
  const dp = new Float32Array(n * m);
  const bp = new Int8Array(n * m);
  dp.fill(Number.POSITIVE_INFINITY);
  bp.fill(-1);

  const idx = (i: number, j: number) => i * m + j;

  for (let i = 0; i < n; i++) {
    const jMin = Math.max(0, i - band);
    const jMax = Math.min(m - 1, i + band);
    for (let j = jMin; j <= jMax; j++) {
      const cost = frameCost(a[i], b[j], nanCost);
      const k = idx(i, j);

      if (i === 0 && j === 0) {
        dp[k] = cost;
        bp[k] = -1;
        continue;
      }

      let best = Number.POSITIVE_INFINITY;
      let dir = -1;
      if (i > 0 && j > 0) {
        const v = dp[idx(i - 1, j - 1)];
        if (v < best) { best = v; dir = 0; }
      }
      if (i > 0) {
        const v = dp[idx(i - 1, j)];
        if (v < best) { best = v; dir = 1; }
      }
      if (j > 0) {
        const v = dp[idx(i, j - 1)];
        if (v < best) { best = v; dir = 2; }
      }

      dp[k] = best + cost;
      bp[k] = dir;
    }
  }

  const endIdx = idx(n - 1, m - 1);
  const cost = dp[endIdx];
  if (!Number.isFinite(cost)) return { cost, path: [] };

  const path: Array<[number, number]> = [];
  let i = n - 1;
  let j = m - 1;
  while (i >= 0 && j >= 0) {
    path.push([i, j]);
    const dir = bp[idx(i, j)];
    if (dir === 0) { i -= 1; j -= 1; }
    else if (dir === 1) { i -= 1; }
    else if (dir === 2) { j -= 1; }
    else break;
  }

  path.reverse();
  return { cost, path };
}

export function dtwBandFeatures(
  a: number[][],
  b: number[][],
  bandRatio = 0.15
): DtwResult {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return { cost: Number.POSITIVE_INFINITY, path: [] };

  const band = Math.max(1, Math.floor(Math.max(n, m) * bandRatio) + Math.abs(n - m));
  const dp = new Float32Array(n * m);
  const bp = new Int8Array(n * m);
  dp.fill(Number.POSITIVE_INFINITY);
  bp.fill(-1);

  const idx = (i: number, j: number) => i * m + j;

  for (let i = 0; i < n; i++) {
    const jMin = Math.max(0, i - band);
    const jMax = Math.min(m - 1, i + band);
    for (let j = jMin; j <= jMax; j++) {
      const cost = frameCostVec(a[i], b[j]);
      const k = idx(i, j);

      if (i === 0 && j === 0) {
        dp[k] = cost;
        bp[k] = -1;
        continue;
      }

      let best = Number.POSITIVE_INFINITY;
      let dir = -1;
      if (i > 0 && j > 0) {
        const v = dp[idx(i - 1, j - 1)];
        if (v < best) { best = v; dir = 0; }
      }
      if (i > 0) {
        const v = dp[idx(i - 1, j)];
        if (v < best) { best = v; dir = 1; }
      }
      if (j > 0) {
        const v = dp[idx(i, j - 1)];
        if (v < best) { best = v; dir = 2; }
      }

      dp[k] = best + cost;
      bp[k] = dir;
    }
  }

  const endIdx = idx(n - 1, m - 1);
  const cost = dp[endIdx];
  if (!Number.isFinite(cost)) return { cost, path: [] };

  const path: Array<[number, number]> = [];
  let i = n - 1;
  let j = m - 1;
  while (i >= 0 && j >= 0) {
    path.push([i, j]);
    const dir = bp[idx(i, j)];
    if (dir === 0) { i -= 1; j -= 1; }
    else if (dir === 1) { i -= 1; }
    else if (dir === 2) { j -= 1; }
    else break;
  }

  path.reverse();
  return { cost, path };
}

function frameCost(a: number, b: number, nanCost: number) {
  const aOk = Number.isFinite(a);
  const bOk = Number.isFinite(b);
  if (!aOk && !bOk) return 0;
  if (!aOk || !bOk) return nanCost;
  const d = a - b;
  return d * d;
}

function frameCostVec(a: number[], b: number[]) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}
