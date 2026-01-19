import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const INDEX_PATH = path.join(ROOT, "data", "reference", "index.json");
const AUDIO_PUBLIC_DIR = path.join(ROOT, "public", "audio");
const OUT_DIR = path.join(ROOT, "public", "reference", "features");
const OUT_INDEX_PATH = path.join(ROOT, "public", "reference", "index.json");
const OUT_DATA_INDEX_PATH = path.join(ROOT, "data", "reference", "index.json");

const SAMPLE_RATE = 16000;
const DEFAULT_PARAMS = {
  hopMs: 4,
  windowMs: 100,
  fminHz: 70,
  fmaxHz: 500,
  rmsSilence: 0.02,
  yinThreshold: 0.12,
  dpEnabled: true,
  dpTopK: 5,
  dpLambda: 80,
  dpUSwitch: 0.5,
  dpUPenalty: 0.6,
  voicedPrior: 0.55,
  nearSilenceRatio: 1.1,
  nearSilenceVoicedBias: 0.2,
  nearSilenceUnvoicedBias: 0.15,
  gapFillMs: 30,
  medWin: 3,
  smoothWin: 7,
};
const MFCC_PARAMS = {
  nMels: 24,
  nMfcc: 12,
  fMinHz: 20,
  fMaxHz: SAMPLE_RATE / 2,
  preEmphasis: 0.97,
};

function decodeMp3ToF32(pathToFile) {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", pathToFile,
      "-f", "f32le",
      "-ac", "1",
      "-ar", String(SAMPLE_RATE),
      "-",
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let err = "";

    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => { err += d.toString(); });
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg failed (${code}): ${err.trim()}`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      resolve(new Float32Array(ab));
    });
  });
}

function analyzeF0(pcm, sr, p) {
  const hop = Math.max(1, Math.round(sr * (p.hopMs / 1000)));
  const frameSize = nextPow2(Math.round(sr * (p.windowMs / 1000)));

  let f0LogRaw;
  if (p.dpEnabled) {
    f0LogRaw = yinCandidatesAndDp(pcm, sr, {
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
      voicedPrior: Math.min(0.95, Math.max(0.05, p.voicedPrior)),
      nearSilenceRatio: Math.max(1.0, p.nearSilenceRatio),
      nearSilenceVoicedBias: Math.max(0, p.nearSilenceVoicedBias),
      nearSilenceUnvoicedBias: Math.max(0, p.nearSilenceUnvoicedBias),
    });
  } else {
    const f0 = yinTrack(pcm, sr, {
      frameSize,
      hop,
      fminHz: p.fminHz,
      fmaxHz: p.fmaxHz,
      thresh: p.yinThreshold,
      rmsSilence: p.rmsSilence,
    });
    f0LogRaw = f0.map((v) => (Number.isFinite(v) && v > 0) ? Math.log(v) : NaN);
  }

  let f0Log = medianFilterNaN(f0LogRaw, p.medWin);
  const gapMaxFrames = Math.max(0, Math.round((p.gapFillMs / 1000) * sr / hop));
  if (gapMaxFrames > 0) f0Log = fillShortGapsLinear(f0Log, gapMaxFrames);
  f0Log = movingAverageNaN(f0Log, p.smoothWin);

  return { f0Log, hop };
}

function computeMfcc(pcm, sr, params, mfccOpt) {
  const hop = Math.max(1, Math.round(sr * (params.hopMs / 1000)));
  const frameSize = nextPow2(Math.round(sr * (params.windowMs / 1000)));
  const nFrames = Math.max(0, Math.floor((pcm.length - frameSize) / hop) + 1);
  const window = buildHamming(frameSize);
  const melBank = buildMelFilterBank(sr, frameSize, mfccOpt.nMels, mfccOpt.fMinHz, mfccOpt.fMaxHz);
  const dct = buildDctTable(mfccOpt.nMfcc, mfccOpt.nMels);

  const features = [];
  const frame = new Float32Array(frameSize);
  const real = new Float32Array(frameSize);
  const imag = new Float32Array(frameSize);

  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * hop;
    let prev = 0;
    for (let i = 0; i < frameSize; i++) {
      const x = pcm[start + i] || 0;
      const y = x - mfccOpt.preEmphasis * prev;
      prev = x;
      frame[i] = y * window[i];
      real[i] = frame[i];
      imag[i] = 0;
    }

    fftInPlace(real, imag);
    const power = powerSpectrum(real, imag);
    const melE = applyMelBank(power, melBank);
    const logE = melE.map((v) => Math.log(Math.max(1e-12, v)));
    const mfcc = applyDct(logE, dct);
    features.push(mfcc);
  }

  return features;
}

async function main() {
  const raw = await fs.readFile(INDEX_PATH, "utf8");
  const index = JSON.parse(raw);

  await fs.mkdir(OUT_DIR, { recursive: true });

  for (const item of index.items) {
    for (const audio of item.audio) {
      const filename = path.basename(audio.path);
      const src = path.join(AUDIO_PUBLIC_DIR, filename);
      const pcm = await decodeMp3ToF32(src);
      const { f0Log, hop } = analyzeF0(pcm, SAMPLE_RATE, DEFAULT_PARAMS);
      const times = f0Log.map((_, i) => (i * hop) / SAMPLE_RATE);
      const mfcc = computeMfcc(pcm, SAMPLE_RATE, DEFAULT_PARAMS, MFCC_PARAMS);

      const payload = {
        id: item.id,
        key: item.key,
        audioId: audio.id,
        sr: SAMPLE_RATE,
        duration: pcm.length / SAMPLE_RATE,
        hopMs: DEFAULT_PARAMS.hopMs,
        windowMs: DEFAULT_PARAMS.windowMs,
        featureType: "mfcc",
        featureDim: MFCC_PARAMS.nMfcc,
        features: mfcc,
        mfcc: MFCC_PARAMS,
        times,
        f0Log,
      };

      const outName = `${audio.id}.json`;
      audio.featurePath = `reference/features/${outName}`;
      await fs.writeFile(path.join(OUT_DIR, outName), JSON.stringify(payload), "utf8");
    }
  }

  index.generatedAt = new Date().toISOString();
  await fs.writeFile(OUT_INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
  await fs.writeFile(OUT_DATA_INDEX_PATH, JSON.stringify(index, null, 2), "utf8");

  console.log(`features: ${index.items.length} items`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number.isFinite(v) ? v : lo);
  return Math.max(lo, Math.min(hi, n));
}

function yinCandidatesAndDp(x, sr, opt) {
  const {
    frameSize,
    hop,
    fminHz,
    fmaxHz,
    thresh,
    rmsSilence,
    topK,
    lambda,
    uSwitch,
    uPenalty,
    voicedPrior,
    nearSilenceRatio,
    nearSilenceVoicedBias,
    nearSilenceUnvoicedBias,
  } = opt;

  const tauMin = Math.max(2, Math.floor(sr / fmaxHz));
  const tauMax = Math.min(frameSize - 2, Math.floor(sr / fminHz));
  const nFrames = Math.max(0, Math.floor((x.length - frameSize) / hop) + 1);
  const out = new Array(nFrames).fill(NaN);

  const d = new Float32Array(tauMax + 1);
  const cmnd = new Float32Array(tauMax + 1);

  const candLogf0 = new Float32Array(nFrames * (topK + 1));
  const candObs = new Float32Array(nFrames * (topK + 1));
  const candIsU = new Uint8Array(nFrames * (topK + 1));

  const unvoicedPrior = 1.0 - voicedPrior;
  const priorVoicedCost = -Math.log(Math.max(1e-6, voicedPrior));
  const priorUnvoicedCost = -Math.log(Math.max(1e-6, unvoicedPrior));

  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * hop;

    let rms = 0;
    for (let i = 0; i < frameSize; i++) {
      const v = x[start + i] || 0;
      rms += v * v;
    }
    rms = Math.sqrt(rms / frameSize);

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

    const mins = [];
    for (let tau = tauMin + 1; tau <= tauMax - 1; tau++) {
      const v = cmnd[tau];
      if (v <= cmnd[tau - 1] && v < cmnd[tau + 1]) {
        mins.push({ tau, v });
      }
    }
    mins.sort((a, b) => a.v - b.v);

    const isNearSilence = rms < rmsSilence * nearSilenceRatio;

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
      candObs[idx] = mins[k].v + (isNearSilence ? nearSilenceVoicedBias : 0.0);
      candIsU[idx] = 0;
    }

    {
      const idx = fi * (topK + 1) + topK;
      candLogf0[idx] = NaN;
      candIsU[idx] = 1;
      if (rms < rmsSilence) {
        candObs[idx] = 0.0;
      } else {
        const ratio = Math.min(8.0, rms / (rmsSilence + 1e-12));
        candObs[idx] = uPenalty + 0.6 * ratio;
      }
    }

    let minObs = Infinity;
    let maxObs = -Infinity;
    for (let k = 0; k < topK; k++) {
      const v = candObs[fi * (topK + 1) + k];
      if (!Number.isFinite(v)) continue;
      if (v < minObs) minObs = v;
      if (v > maxObs) maxObs = v;
    }
    const denom = Math.max(1e-6, maxObs - minObs);
    for (let k = 0; k < topK; k++) {
      const idx = fi * (topK + 1) + k;
      if (!Number.isFinite(candObs[idx])) continue;
      candObs[idx] = (candObs[idx] - minObs) / denom + priorVoicedCost;
    }
    const uIdx = fi * (topK + 1) + topK;
    candObs[uIdx] = candObs[uIdx] + priorUnvoicedCost - (isNearSilence ? nearSilenceUnvoicedBias : 0.0);
  }

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

function yinTrack(x, sr, opt) {
  const { frameSize, hop, fminHz, fmaxHz, thresh, rmsSilence } = opt;

  const tauMin = Math.max(2, Math.floor(sr / fmaxHz));
  const tauMax = Math.min(frameSize - 2, Math.floor(sr / fminHz));

  const nFrames = Math.max(0, Math.floor((x.length - frameSize) / hop) + 1);
  const out = new Array(nFrames).fill(NaN);

  const d = new Float32Array(tauMax + 1);
  const cmnd = new Float32Array(tauMax + 1);

  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * hop;

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

function parabolicInterp(arr, x0, xmin, xmax) {
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

function medianFilterNaN(x, win) {
  if (win <= 1) return x.slice();
  if (win % 2 === 0) win += 1;
  const r = Math.floor(win / 2);
  const out = new Array(x.length);

  for (let i = 0; i < x.length; i++) {
    const buf = [];
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

function fillShortGapsLinear(x, maxGap) {
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

function movingAverageNaN(x, win) {
  if (win <= 1) return x.slice();
  if (win % 2 === 0) win += 1;
  const r = Math.floor(win / 2);
  const out = new Array(x.length);

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

function buildHamming(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return w;
}

function hzToMel(hz) {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel) {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

function buildMelFilterBank(sr, nFft, nMels, fMinHz, fMaxHz) {
  const melMin = hzToMel(fMinHz);
  const melMax = hzToMel(fMaxHz);
  const melPoints = new Array(nMels + 2)
    .fill(0)
    .map((_, i) => melMin + ((melMax - melMin) * i) / (nMels + 1));
  const hzPoints = melPoints.map(melToHz);
  const binPoints = hzPoints.map((hz) => Math.floor(((nFft + 1) * hz) / sr));

  const filters = [];
  const nBins = Math.floor(nFft / 2) + 1;
  for (let m = 1; m <= nMels; m++) {
    const f = new Float32Array(nBins);
    const left = binPoints[m - 1];
    const center = binPoints[m];
    const right = binPoints[m + 1];
    for (let k = left; k < center; k++) {
      if (k >= 0 && k < nBins) f[k] = (k - left) / Math.max(1, center - left);
    }
    for (let k = center; k < right; k++) {
      if (k >= 0 && k < nBins) f[k] = (right - k) / Math.max(1, right - center);
    }
    filters.push(f);
  }
  return filters;
}

function buildDctTable(nMfcc, nMels) {
  const table = [];
  for (let k = 0; k < nMfcc; k++) {
    const row = [];
    for (let n = 0; n < nMels; n++) {
      row.push(Math.cos((Math.PI * k * (n + 0.5)) / nMels));
    }
    table.push(row);
  }
  return table;
}

function fftInPlace(real, imag) {
  const n = real.length;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenCos = Math.cos(ang);
    const wlenSin = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wCos = 1;
      let wSin = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = real[i + j];
        const uIm = imag[i + j];
        const vRe = real[i + j + len / 2] * wCos - imag[i + j + len / 2] * wSin;
        const vIm = real[i + j + len / 2] * wSin + imag[i + j + len / 2] * wCos;

        real[i + j] = uRe + vRe;
        imag[i + j] = uIm + vIm;
        real[i + j + len / 2] = uRe - vRe;
        imag[i + j + len / 2] = uIm - vIm;

        const nextCos = wCos * wlenCos - wSin * wlenSin;
        const nextSin = wCos * wlenSin + wSin * wlenCos;
        wCos = nextCos;
        wSin = nextSin;
      }
    }
  }
}

function powerSpectrum(real, imag) {
  const nBins = Math.floor(real.length / 2) + 1;
  const out = new Float32Array(nBins);
  for (let i = 0; i < nBins; i++) {
    out[i] = real[i] * real[i] + imag[i] * imag[i];
  }
  return out;
}

function applyMelBank(power, bank) {
  return bank.map((f) => {
    let sum = 0;
    for (let i = 0; i < power.length; i++) {
      sum += power[i] * f[i];
    }
    return sum;
  });
}

function applyDct(logE, dct) {
  const out = [];
  for (let k = 0; k < dct.length; k++) {
    let sum = 0;
    const row = dct[k];
    for (let n = 0; n < logE.length; n++) sum += logE[n] * row[n];
    out.push(sum);
  }
  return out;
}
