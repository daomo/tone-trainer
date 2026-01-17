export async function startRecording(
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
  };
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
