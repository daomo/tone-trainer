export function trimSilence(pcm: Float32Array, sr: number, rmsRatio: number, padMs: number) {
  if (pcm.length === 0) return pcm;

  const win = Math.max(64, Math.round(sr * 0.02)); // 20ms
  const hop = Math.max(32, Math.round(win / 2));

  const rms: number[] = [];
  let maxR = 0;
  for (let start = 0; start + win <= pcm.length; start += hop) {
    let s = 0;
    for (let i = 0; i < win; i++) {
      const v = pcm[start + i];
      s += v * v;
    }
    const r = Math.sqrt(s / win);
    rms.push(r);
    if (r > maxR) maxR = r;
  }
  if (maxR <= 1e-9) return pcm;

  const thr = Math.max(1e-6, maxR * rmsRatio);

  let first = -1, last = -1;
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] >= thr) { first = i; break; }
  }
  for (let i = rms.length - 1; i >= 0; i--) {
    if (rms[i] >= thr) { last = i; break; }
  }
  if (first < 0 || last < 0 || last < first) return pcm;

  const pad = Math.round((padMs / 1000) * sr);

  const startSample = Math.max(0, first * hop - pad);
  const endSample = Math.min(pcm.length, (last * hop + win) + pad);

  if (endSample - startSample < Math.round(0.2 * sr)) return pcm;
  return pcm.slice(startSample, endSample);
}
