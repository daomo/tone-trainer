export async function startRecording(
  onStop: (blob: Blob) => void,
  onError: (err: unknown) => void
) {
  // Prefer MediaRecorder when available, but iOS Safari can be flaky.
  // Fallback: capture PCM via WebAudio (ScriptProcessor) and build WAV for playback.
  try {
    if (supportsMediaRecorder()) {
      return await startMediaRecorder(onStop, onError);
    }
    return await startPcmRecorder(onStop, onError);
  } catch (e) {
    onError(e);
    throw e;
  }
}

function supportsMediaRecorder() {
  return typeof window !== "undefined" && typeof (window as any).MediaRecorder !== "undefined";
}

async function startMediaRecorder(
  onStop: (blob: Blob) => void,
  onError: (err: unknown) => void
) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onerror = (e) => onError(e);
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType });
    cleanupStream(stream);
    onStop(blob);
  };

  recorder.start();

  return {
    stop: () => {
      if (recorder.state === "recording") recorder.stop();
    },
    stream,
    recorder,
    mode: "mediarecorder" as const,
  };
}

// iOS-friendly PCM recorder (ScriptProcessor fallback)
// Note: ScriptProcessor is deprecated but still the most broadly supported fallback (incl. iOS).
async function startPcmRecorder(
  onStop: (blob: Blob) => void,
  onError: (err: unknown) => void
) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const ac = new (window.AudioContext || (window as any).webkitAudioContext)();
  // iOS often starts suspended until a user gesture.
  await ac.resume().catch(() => {});

  const source = ac.createMediaStreamSource(stream);

  // Buffer size tradeoff: larger is lighter, smaller is lower latency.
  const bufferSize = 4096;
  const sp = ac.createScriptProcessor(bufferSize, 1, 1);

  const chunks: Float32Array[] = [];
  sp.onaudioprocess = (e) => {
    try {
      const input = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(input));
    } catch (err) {
      onError(err);
    }
  };

  source.connect(sp);

  // Some browsers require connecting to destination even if muted.
  const gain = ac.createGain();
  gain.gain.value = 0;
  sp.connect(gain);
  gain.connect(ac.destination);

  let stopped = false;

  async function stop() {
    if (stopped) return;
    stopped = true;
    try {
      sp.disconnect();
      source.disconnect();
      gain.disconnect();
    } catch {}
    cleanupStream(stream);
    await ac.close().catch(() => {});

    const pcm = concatFloat32(chunks);
    const wavBlob = encodeWav16(pcm, ac.sampleRate);
    onStop(wavBlob);
  }

  return {
    stop,
    stream,
    recorder: null,
    mode: "pcm" as const,
  };
}

function concatFloat32(parts: Float32Array[]) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function encodeWav16(samples: Float32Array, sampleRate: number) {
  // mono, 16-bit PCM WAV
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    s = Math.max(-1, Math.min(1, s));
    const v = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, v, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function cleanupStream(stream: MediaStream) {
  for (const t of stream.getTracks()) t.stop();
}

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  for (const c of candidates) {
    if ((window as any).MediaRecorder?.isTypeSupported?.(c)) return c;
  }
  return "";
}

export async function decodeToMonoPCM(blob: Blob) {
  const arrayBuf = await blob.arrayBuffer();
  const ac = new (window.AudioContext || (window as any).webkitAudioContext)();
  const audioBuf = await ac.decodeAudioData(arrayBuf);
  const mono = toMono(audioBuf);
  const sr = audioBuf.sampleRate;
  await ac.close();
  return { mono, sr };
}

function toMono(audioBuffer: AudioBuffer): Float32Array {
  const ch = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  if (ch === 1) return audioBuffer.getChannelData(0).slice();

  const out = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += d[i];
  }
  for (let i = 0; i < len; i++) out[i] /= ch;
  return out;
}

export async function resampleMonoPCM(
  mono: Float32Array,
  srcSr: number,
  dstSr: number
): Promise<Float32Array> {
  if (srcSr === dstSr) return mono;

  const len = Math.round(mono.length * (dstSr / srcSr));
  const oac = new OfflineAudioContext(1, len, dstSr);

  const b = oac.createBuffer(1, mono.length, srcSr);
  b.copyToChannel(mono, 0);

  const src = oac.createBufferSource();
  src.buffer = b;
  src.connect(oac.destination);
  src.start(0);

  const rendered = await oac.startRendering();
  return rendered.getChannelData(0).slice();
}
