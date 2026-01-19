type MfccOptions = {
  sr: number;
  frameSize: number;
  hopSize: number;
  nMels: number;
  nMfcc: number;
  fMinHz?: number;
  fMaxHz?: number;
  preEmphasis?: number;
};

export function computeMfcc(pcm: Float32Array, opts: MfccOptions) {
  const {
    sr,
    frameSize,
    hopSize,
    nMels,
    nMfcc,
    fMinHz = 20,
    fMaxHz = sr / 2,
    preEmphasis = 0.97,
  } = opts;

  const padded =
    pcm.length < frameSize
      ? padToFrame(pcm, frameSize)
      : pcm;
  const nFrames = Math.max(1, Math.floor((padded.length - frameSize) / hopSize) + 1);
  const window = buildHamming(frameSize);
  const melBank = buildMelFilterBank(sr, frameSize, nMels, fMinHz, fMaxHz);
  const dct = buildDctTable(nMfcc, nMels);

  const features: number[][] = [];
  const times: number[] = [];
  const frame = new Float32Array(frameSize);
  const real = new Float32Array(frameSize);
  const imag = new Float32Array(frameSize);

  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * hopSize;
    let prev = 0;
    for (let i = 0; i < frameSize; i++) {
      const x = padded[start + i] ?? 0;
      const y = x - preEmphasis * prev;
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
    times.push((start / sr));
  }

  return { features, times };
}

function buildHamming(n: number) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return w;
}

function hzToMel(hz: number) {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number) {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

function buildMelFilterBank(
  sr: number,
  nFft: number,
  nMels: number,
  fMinHz: number,
  fMaxHz: number
) {
  const melMin = hzToMel(fMinHz);
  const melMax = hzToMel(fMaxHz);
  const melPoints = new Array(nMels + 2)
    .fill(0)
    .map((_, i) => melMin + ((melMax - melMin) * i) / (nMels + 1));
  const hzPoints = melPoints.map(melToHz);
  const binPoints = hzPoints.map((hz) => Math.floor(((nFft + 1) * hz) / sr));

  const filters: Float32Array[] = [];
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

function buildDctTable(nMfcc: number, nMels: number) {
  const table: number[][] = [];
  for (let k = 0; k < nMfcc; k++) {
    const row: number[] = [];
    for (let n = 0; n < nMels; n++) {
      row.push(Math.cos((Math.PI * k * (n + 0.5)) / nMels));
    }
    table.push(row);
  }
  return table;
}

function fftInPlace(real: Float32Array, imag: Float32Array) {
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

function powerSpectrum(real: Float32Array, imag: Float32Array) {
  const nBins = Math.floor(real.length / 2) + 1;
  const out = new Float32Array(nBins);
  for (let i = 0; i < nBins; i++) {
    out[i] = real[i] * real[i] + imag[i] * imag[i];
  }
  return out;
}

function applyMelBank(power: Float32Array, bank: Float32Array[]) {
  return bank.map((f) => {
    let sum = 0;
    for (let i = 0; i < power.length; i++) {
      sum += power[i] * f[i];
    }
    return sum;
  });
}

function applyDct(logE: number[], dct: number[][]) {
  const out: number[] = [];
  for (let k = 0; k < dct.length; k++) {
    let sum = 0;
    const row = dct[k];
    for (let n = 0; n < logE.length; n++) sum += logE[n] * row[n];
    out.push(sum);
  }
  return out;
}

function padToFrame(pcm: Float32Array, frameSize: number) {
  const out = new Float32Array(frameSize);
  out.set(pcm.slice(0, frameSize));
  return out;
}
