/// <reference lib="webworker" />

import type { WorkerRequest, WorkerResponse, F0Params, F0Result } from "../lib/types";

(self as any).postMessage({ type: "ready" } satisfies WorkerResponse);

(self as any).onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === "ping") {
    (self as any).postMessage({ type: "ready" } satisfies WorkerResponse);
    return;
  }

  if (msg.type === "analyze") {
    try {
      const { pcm, sr, params } = msg;

      (self as any).postMessage({ type: "progress", phase: "YIN" } satisfies WorkerResponse);
      const res = analyzeF0(pcm, sr, params);

      (self as any).postMessage({ type: "result", result: res } satisfies WorkerResponse);
    } catch (e: any) {
      (self as any).postMessage({
        type: "error",
        message: e?.message ?? String(e),
      } satisfies WorkerResponse);
    }
  }
};

function analyzeF0(pcm: Float32Array, sr: number, p: F0Params): F0Result {
  const hop = Math.max(1, Math.round(sr * (p.hopMs / 1000)));
  const frameSize = nextPow2(Math.round(sr * (p.windowMs / 1000)));

  let f0LogRaw: number[];
  if (p.dpEnabled) {
    const f0LogDp = yinCandidatesAndDp(pcm, sr, {
      frameSize,
      hop,
      fminHz: p.fminHz,
      fmaxHz: p.fmaxHz,
      thresh: p.yinThreshold,
      rmsSilence: p.rmsSilence,
      topK: clampInt(p.dpTopK, 2, 6),
      lambda: Math.max(0, p.dpLambda),
      uSwitch: Math.max(0, p.dpUSwitch),
      uPenalty: Math.max(0, p.dpUPenalty),
    });
    f0LogRaw = f0LogDp;
  } else {
    const f0 = yinTrack(pcm, sr, {
      frameSize,
      hop,
      fminHz: p.fminHz,
      fmaxHz: p.fmaxHz,
      thresh: p.yinThreshold,
      rmsSilence: p.rmsSilence,
    });
    f0LogRaw = f0.map(v => (Number.isFinite(v) && v > 0) ? Math.log(v) : NaN);
  }

  (self as any).postMessage({ type: "progress", phase: "postprocess" } satisfies WorkerResponse);

  // 1) median filter
  let f0Log = medianFilterNaN(f0LogRaw, p.medWin);

  // 2) fill short gaps
  const gapMaxFrames = Math.max(0, Math.round((p.gapFillMs / 1000) * sr / hop));
  if (gapMaxFrames > 0) f0Log = fillShortGapsLinear(f0Log, gapMaxFrames);

  // 3) moving average smooth
  f0Log = movingAverageNaN(f0Log, p.smoothWin);

  const duration = pcm.length / sr;
  const times = f0Log.map((_, i) => (i * hop) / sr);

  return { sr, duration, times, f0Log };
}

type Cand = {
  logf0: number;     // NaN for unvoiced
  obsCost: number;   // smaller is better
  isU: boolean;
};

function yinCandidatesAndDp(
  x: Float32Array,
  sr: number,
  opt: {
    frameSize: number;
    hop: number;
    fminHz: number;
    fmaxHz: number;
    thresh: number;
    rmsSilence: number;
    topK: number;
    lambda: number;
    uSwitch: number;
    uPenalty: number;
  }
): number[] {
  const { frameSize, hop, fminHz, fmaxHz, thresh, rmsSilence, topK, lambda, uSwitch, uPenalty } = opt;

  const tauMin = Math.max(2, Math.floor(sr / fmaxHz));
  const tauMax = Math.min(frameSize - 2, Math.floor(sr / fminHz));

  const nFrames = Math.max(0, Math.floor((x.length - frameSize) / hop) + 1);
  const out = new Array<number>(nFrames).fill(NaN);

  const d = new Float32Array(tauMax + 1);
  const cmnd = new Float32Array(tauMax + 1);

  // Build candidates per frame (K voiced + 1 unvoiced)
  const candLogf0 = new Float32Array(nFrames * (topK + 1));
  const candObs = new Float32Array(nFrames * (topK + 1));
  const candIsU = new Uint8Array(nFrames * (topK + 1));

  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * hop;

    // RMS
    let rms = 0;
    for (let i = 0; i < frameSize; i++) {
      const v = x[start + i] || 0;
      rms += v * v;
    }
    rms = Math.sqrt(rms / frameSize);

    // Difference function
    d[0] = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      const lim = frameSize - tau;
      for (let i = 0; i < lim; i++) {
        const delta = x[start + i] - x[start + i + tau];
        sum += delta * delta;
      }
      d[tau] = sum;
    }

    // CMND
    cmnd[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      runningSum += d[tau];
      cmnd[tau] = (d[tau] * tau) / (runningSum + 1e-12);
    }

    // Collect local minima in [tauMin, tauMax]
    // Threshold-independent selection: pick smallest CMND local minima.
    const mins: { tau: number; v: number }[] = [];
    for (let tau = tauMin + 1; tau <= tauMax - 1; tau++) {
      const v = cmnd[tau];
      if (v <= cmnd[tau - 1] && v < cmnd[tau + 1]) {
        // Do NOT gate by threshold here; DP will choose the best path globally.
        mins.push({ tau, v });
      }
    }
    mins.sort((a, b) => a.v - b.v);

    // Fill voiced candidates
    for (let k = 0; k < topK; k++) {
      const idx = fi * (topK + 1) + k;
      if (k >= mins.length) {
        candLogf0[idx] = NaN;
        candObs[idx] = 1e3;
        candIsU[idx] = 0;
        continue;
      }
      const tau0 = mins[k].tau;
      const tauRef = parabolicInterp(cmnd, tau0, 1, tauMax);
      const f0 = sr / tauRef;
      if (!(f0 >= fminHz && f0 <= fmaxHz) || !Number.isFinite(f0)) {
        candLogf0[idx] = NaN;
        candObs[idx] = 1e3;
        candIsU[idx] = 0;
        continue;
      }
      candLogf0[idx] = Math.log(f0);
      candObs[idx] = mins[k].v; // smaller better
      candIsU[idx] = 0;
    }

    // Unvoiced candidate at slot topK
    {
      const idx = fi * (topK + 1) + topK;
      candLogf0[idx] = NaN;
      candIsU[idx] = 1;
      // Make unvoiced expensive when energy exists.
      // - if rms is very small, unvoiced is cheap
      // - otherwise, cost rises quickly with rms/rmsSilence, plus a base uPenalty
      if (rms < rmsSilence) {
        candObs[idx] = 0.0;
      } else {
        const ratio = Math.min(8.0, rms / (rmsSilence + 1e-12));
        // ratio>=1 => already above silence; push unvoiced cost up strongly
        candObs[idx] = uPenalty + 0.6 * ratio;
      }
    }
  }

  // DP / Viterbi over fixed-size state per frame (topK+1)
  const S = topK + 1;
  const dp = new Float32Array(nFrames * S);
  const bp = new Int16Array(nFrames * S);

  for (let s = 0; s < S; s++) {
    dp[s] = candObs[s];
    bp[s] = -1;
  }

  for (let t = 1; t < nFrames; t++) {
    for (let s = 0; s < S; s++) {
      const curIdx = t * S + s;
      const curIsU = candIsU[curIdx] === 1;
      const curLog = candLogf0[curIdx];
      const curObs = candObs[curIdx];

      let best = 1e12;
      let bestPrev = 0;
      for (let ps = 0; ps < S; ps++) {
        const prevIdx = (t - 1) * S + ps;
        const prevIsU = candIsU[prevIdx] === 1;
        const prevLog = candLogf0[prevIdx];
        let tr = 0;
        if (curIsU !== prevIsU) tr += uSwitch;
        if (!curIsU && !prevIsU && Number.isFinite(curLog) && Number.isFinite(prevLog)) {
          const d = curLog - prevLog;
          tr += lambda * d * d;
        }
        const v = dp[prevIdx] + tr;
        if (v < best) {
          best = v;
          bestPrev = ps;
        }
      }
      dp[curIdx] = best + curObs;
      bp[curIdx] = bestPrev;
    }
  }

  // Backtrack
  let bestFinal = 1e12;
  let bestState = 0;
  const lastBase = (nFrames - 1) * S;
  for (let s = 0; s < S; s++) {
    const v = dp[lastBase + s];
    if (v < bestFinal) {
      bestFinal = v;
      bestState = s;
    }
  }

  let state = bestState;
  for (let t = nFrames - 1; t >= 0; t--) {
    const idx = t * S + state;
    const isU = candIsU[idx] === 1;
    const logf0 = candLogf0[idx];
    out[t] = (!isU && Number.isFinite(logf0)) ? logf0 : NaN;
    state = bp[idx];
    if (t > 0 && state < 0) state = 0;
  }

  return out;
}

function clampInt(v: number, lo: number, hi: number) {
  const n = Math.floor(Number.isFinite(v) ? v : lo);
  return Math.max(lo, Math.min(hi, n));
}

function yinTrack(
  x: Float32Array,
  sr: number,
  opt: {
    frameSize: number;
    hop: number;
    fminHz: number;
    fmaxHz: number;
    thresh: number;
    rmsSilence: number;
  }
) {
  const { frameSize, hop, fminHz, fmaxHz, thresh, rmsSilence } = opt;

  const tauMin = Math.max(2, Math.floor(sr / fmaxHz));
  const tauMax = Math.min(frameSize - 2, Math.floor(sr / fminHz));

  const nFrames = Math.max(0, Math.floor((x.length - frameSize) / hop) + 1);
  const out = new Array<number>(nFrames).fill(NaN);

  const d = new Float32Array(tauMax + 1);
  const cmnd = new Float32Array(tauMax + 1);

  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * hop;

    // RMS silence gate
    let rms = 0;
    for (let i = 0; i < frameSize; i++) {
      const v = x[start + i] || 0;
      rms += v * v;
    }
    rms = Math.sqrt(rms / frameSize);
    if (rms < rmsSilence) {
      out[fi] = NaN;
      continue;
    }

    // Difference function
    d[0] = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      const lim = frameSize - tau;
      for (let i = 0; i < lim; i++) {
        const delta = x[start + i] - x[start + i + tau];
        sum += delta * delta;
      }
      d[tau] = sum;
    }

    // CMND
    cmnd[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      runningSum += d[tau];
      cmnd[tau] = (d[tau] * tau) / (runningSum + 1e-12);
    }

    // First dip below threshold
    let tauEstimate = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < thresh) {
        while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
        tauEstimate = tau;
        break;
      }
    }
    if (tauEstimate < 0) {
      out[fi] = NaN;
      continue;
    }

    const betterTau = parabolicInterp(cmnd, tauEstimate, 1, tauMax);
    const f0 = sr / betterTau;

    out[fi] = (f0 >= fminHz && f0 <= fmaxHz) ? f0 : NaN;
  }

  return out;
}

function parabolicInterp(arr: Float32Array, x0: number, xmin: number, xmax: number) {
  const x1 = Math.max(xmin, x0 - 1);
  const x2 = x0;
  const x3 = Math.min(xmax, x0 + 1);

  if (x1 === x2 || x2 === x3) return x0;

  const y1 = arr[x1], y2 = arr[x2], y3 = arr[x3];
  const denom = (y1 - 2 * y2 + y3);
  if (Math.abs(denom) < 1e-12) return x0;

  const delta = 0.5 * (y1 - y3) / denom;
  return x0 + delta;
}

function nextPow2(n: number) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function medianFilterNaN(x: number[], win: number) {
  if (win <= 1) return x.slice();
  if (win % 2 === 0) win += 1;
  const r = Math.floor(win / 2);
  const out = new Array<number>(x.length);

  for (let i = 0; i < x.length; i++) {
    const buf: number[] = [];
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= x.length) continue;
      const v = x[j];
      if (Number.isFinite(v)) buf.push(v);
    }
    if (buf.length === 0) out[i] = NaN;
    else {
      buf.sort((a, b) => a - b);
      out[i] = buf[Math.floor(buf.length / 2)];
    }
  }
  return out;
}

function fillShortGapsLinear(x: number[], maxGap: number) {
  const out = x.slice();
  const n = out.length;
  let i = 0;
  while (i < n) {
    if (Number.isFinite(out[i])) { i++; continue; }
    const start = i;
    while (i < n && !Number.isFinite(out[i])) i++;
    const end = i;
    const gapLen = end - start;

    const left = start - 1;
    const right = end;
    if (gapLen <= maxGap && left >= 0 && right < n && Number.isFinite(out[left]) && Number.isFinite(out[right])) {
      const a = out[left];
      const b = out[right];
      for (let k = 1; k <= gapLen; k++) {
        out[left + k] = a + (b - a) * (k / (gapLen + 1));
      }
    }
  }
  return out;
}

function movingAverageNaN(x: number[], win: number) {
  if (win <= 1) return x.slice();
  if (win % 2 === 0) win += 1;
  const r = Math.floor(win / 2);
  const out = new Array<number>(x.length);

  for (let i = 0; i < x.length; i++) {
    let sum = 0;
    let cnt = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= x.length) continue;
      const v = x[j];
      if (Number.isFinite(v)) { sum += v; cnt++; }
    }
    out[i] = cnt > 0 ? sum / cnt : NaN;
  }
  return out;
}
