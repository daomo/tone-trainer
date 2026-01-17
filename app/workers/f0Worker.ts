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
  const targetSr = sr; // already resampled on main thread
  const hop = Math.max(1, Math.round(targetSr * (p.hopMs / 1000)));
  const frameSize = nextPow2(Math.round(targetSr * (p.windowMs / 1000)));

  const f0 = yinTrack(pcm, targetSr, {
    frameSize,
    hop,
    fminHz: p.fminHz,
    fmaxHz: p.fmaxHz,
    thresh: p.yinThreshold,
    rmsSilence: p.rmsSilence,
  });

  const f0Log = f0.map(v => (Number.isFinite(v) && v > 0) ? Math.log(v) : NaN);
  const smoothed = medianFilterNaN(f0Log, p.medWin);

  const duration = pcm.length / targetSr;
  const times = smoothed.map((_, i) => (i * hop) / targetSr);

  return { sr: targetSr, duration, times, f0Log: smoothed };
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

    cmnd[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      runningSum += d[tau];
      cmnd[tau] = (d[tau] * tau) / (runningSum + 1e-12);
    }

    // first dip below threshold
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
