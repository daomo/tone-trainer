"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { F0Params, F0Result, WorkerResponse } from "./lib/types";
import { startRecording, decodeToMonoPCM, resampleMonoPCM } from "./lib/audio";
import { drawBase, makeDrawState, redrawWithCursor } from "./lib/draw";

const DEFAULT_PARAMS: F0Params = {
  targetSr: 16000,

  // Speech (tones) tends to look better with denser hop.
  hopMs: 10,
  windowMs: 40,

  fminHz: 70,
  fmaxHz: 380,

  yinThreshold: 0.12,
  rmsSilence: 0.008,

  trimRmsRatio: 0.02,
  trimPadMs: 60,

  maxJumpSemitone: 4,
  gapFillMs: 120,
  medWin: 7,
  smoothWin: 9,
};

export default function Page() {
  const [params, setParams] = useState<F0Params>(DEFAULT_PARAMS);
  const [status, setStatus] = useState<string>("ready");
  const [busy, setBusy] = useState(false);
  const [debugOpen, setDebugOpen] = useState(true);

  const [blobUrl, setBlobUrl] = useState<string>("");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const cvRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawState = useMemo(() => makeDrawState(), []);

  const workerRef = useRef<Worker | null>(null);

  const lastPcmRef = useRef<Float32Array | null>(null); // resampled PCM for re-analyze
  const lastSrRef = useRef<number>(DEFAULT_PARAMS.targetSr);

  const analysisRef = useRef<F0Result | null>(null);
  const rafRef = useRef<number | null>(null);

  const recCtlRef = useRef<{ stop: () => void } | null>(null);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    const cv = cvRef.current!;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctxRef.current = ctx;

    const w = new Worker(new URL("./workers/f0Worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;

    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === "ready") {
        // no-op
      } else if (msg.type === "progress") {
        setStatus(`analyzing: ${msg.phase}`);
      } else if (msg.type === "result") {
        analysisRef.current = msg.result;
        setBusy(false);
        setStatus(`done: ${msg.result.duration.toFixed(2)}s, frames=${msg.result.times.length}`);

        const ctx2 = ctxRef.current;
        const cv2 = cvRef.current;
        if (ctx2 && cv2) {
          drawBase(ctx2, cv2, msg.result, params, drawState);
        }
      } else if (msg.type === "error") {
        setBusy(false);
        setStatus(`error: ${msg.message}`);
      }
    };

    return () => {
      stopRaf();
      w.terminate();
      workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onEnded = () => {
      stopRaf();
      const a = analysisRef.current;
      const ctx = ctxRef.current;
      const cv = cvRef.current;
      if (a && ctx && cv) redrawWithCursor(ctx, cv, a, params, drawState, a.duration);
    };

    audio.addEventListener("ended", onEnded);
    return () => audio.removeEventListener("ended", onEnded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  function stopRaf() {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }

  function startRaf() {
    stopRaf();
    const tick = () => {
      const a = analysisRef.current;
      const audio = audioRef.current;
      const ctx = ctxRef.current;
      const cv = cvRef.current;
      if (a && audio && ctx && cv) {
        redrawWithCursor(ctx, cv, a, params, drawState, audio.currentTime);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  async function handleRecord() {
    setStatus("requesting mic…");
    try {
      setRecording(true);
      const ctl = await startRecording(
        async (b) => {
          setRecording(false);
          setStatus("recorded. decoding…");

          // auto analyze immediately (this will also set playback audio)
          await analyzeBlob(b);
        },
        (err) => {
          console.error(err);
          setRecording(false);
          setStatus("record error (check permission/https/localhost)");
        }
      );
      recCtlRef.current = ctl;
      setStatus("recording…");
    } catch (e) {
      console.error(e);
      setRecording(false);
      setStatus("mic failed (permission/https/localhost)");
    }
  }

  function handleStop() {
    recCtlRef.current?.stop();
    recCtlRef.current = null;
  }

  async function analyzeBlob(b: Blob) {
    setBusy(true);
    setStatus("decoding…");

    try {
      stopRaf();

      const { mono, sr } = await decodeToMonoPCM(b);
      setStatus("resampling…");

      const target = params.targetSr;
      let pcm = await resampleMonoPCM(mono, sr, target);

      // Trim leading/trailing silence (whole recording)
      pcm = trimSilence(pcm, target, params.trimRmsRatio, params.trimPadMs);

      // Make playback audio match analysis (trimmed WAV)
      const wavBlob = encodeWav16(pcm, target);
      const url = URL.createObjectURL(wavBlob);
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });


      // stash for re-analyze
      lastPcmRef.current = pcm;
      lastSrRef.current = target;

      setStatus("sending to worker…");
      const w = workerRef.current;
      if (!w) throw new Error("worker not ready");

      // transfer the buffer for speed
      // send a separate buffer to worker (transfer only this one)
      const pcmSend = pcm.slice();
      w.postMessage(
        { type: "analyze", pcm: pcmSend, sr: target, params } as any,
        [pcmSend.buffer]
      );
    } catch (e: any) {
      console.error(e);
      setBusy(false);
      setStatus(`analyze failed: ${e?.message ?? String(e)}`);
    }
  }

  async function reAnalyze() {
    const pcm = lastPcmRef.current;
    const sr = lastSrRef.current;
    if (!pcm) {
      setStatus("no audio yet");
      return;
    }
    setBusy(true);
    setStatus("re-analyzing…");

    // If the buffer is detached (can happen if you transferred it), ask user to re-record
    if (pcm.buffer.byteLength === 0) {
      setBusy(false);
      setStatus("pcm buffer detached. もう一度録音してください。");
      return;
    }

    const w = workerRef.current;
    if (!w) {
      setBusy(false);
      setStatus("worker not ready");
      return;
    }

    const pcmSend = pcm.slice();
    w.postMessage(
      { type: "analyze", pcm: pcmSend, sr, params } as any,
      [pcmSend.buffer]
    );
  }

  function onPlay() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.play();
    startRaf();
  }

  function onPause() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    stopRaf();

    const a = analysisRef.current;
    const ctx = ctxRef.current;
    const cv = cvRef.current;
    if (a && ctx && cv) redrawWithCursor(ctx, cv, a, params, drawState, audio.currentTime);
  }

  return (
    <div className="container">
      <h2 style={{ margin: "10px 0 6px" }}>F0可視化（YIN + WebWorker）</h2>

      <div className="row">
        <button onClick={handleRecord} disabled={busy || recording}>
          録音開始
        </button>
        <button onClick={handleStop} disabled={!recording}>
          停止
        </button>

        <button onClick={onPlay} disabled={busy || !blobUrl}>
          再生
        </button>
        <button onClick={onPause} disabled={!blobUrl}>
          一時停止
        </button>

        <span className="badge">{recording ? "REC" : "IDLE"}</span>
        <span className="small">{status}</span>
      </div>

      <div className="canvasWrap">
        <canvas ref={cvRef} width={980} height={280} />
        {busy && (
          <div className="overlay" aria-label="analyzing">
            <div style={{ display: "grid", placeItems: "center", gap: 10 }}>
              <div className="spinner" />
              <div className="small">解析中…</div>
            </div>
          </div>
        )}
      </div>

      {blobUrl ? (
      <audio
        ref={audioRef}
        controls
        src={blobUrl}
        style={{ width: "100%", marginTop: 10 }}
        onPlay={() => startRaf()}
        onPause={() => onPause()}
      />
    ) : null}
<p className="small" style={{ marginTop: 10 }}>
        録音停止後に自動で解析します（16kHz→YIN→中央値平滑化）。描画はCanvas、縦線は再生位置に同期。
      </p>

      {debugOpen ? (
        <div className="debugPanel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>Debug Params</h3>
            <button onClick={() => setDebugOpen(false)} style={{ padding: "6px 10px" }}>
              閉じる
            </button>
          </div>

          <Field label="targetSr" value={params.targetSr} step={1000} min={8000} max={48000}
            onChange={(v) => setParams(p => ({ ...p, targetSr: v }))} />

          <Field label="hopMs" value={params.hopMs} step={1} min={8} max={40}
            onChange={(v) => setParams(p => ({ ...p, hopMs: v }))} />

          <Field label="windowMs" value={params.windowMs} step={1} min={20} max={80}
            onChange={(v) => setParams(p => ({ ...p, windowMs: v }))} />

          <Field label="fminHz" value={params.fminHz} step={1} min={40} max={200}
            onChange={(v) => setParams(p => ({ ...p, fminHz: v }))} />

          <Field label="fmaxHz" value={params.fmaxHz} step={1} min={200} max={800}
            onChange={(v) => setParams(p => ({ ...p, fmaxHz: v }))} />

          <Field label="yinThreshold" value={params.yinThreshold} step={0.01} min={0.05} max={0.30}
            onChange={(v) => setParams(p => ({ ...p, yinThreshold: v }))} />

          <Field label="rmsSilence" value={params.rmsSilence} step={0.001} min={0.001} max={0.05}
            onChange={(v) => setParams(p => ({ ...p, rmsSilence: v }))} />


          <Field label="trimRmsRatio" value={params.trimRmsRatio} step={0.005} min={0.005} max={0.08}
            onChange={(v) => setParams(p => ({ ...p, trimRmsRatio: v }))} />

          <Field label="trimPadMs" value={params.trimPadMs} step={10} min={0} max={200}
            onChange={(v) => setParams(p => ({ ...p, trimPadMs: v }))} />

          <Field label="maxJumpSemitone" value={params.maxJumpSemitone} step={1} min={0} max={12}
            onChange={(v) => setParams(p => ({ ...p, maxJumpSemitone: v }))} />

          <Field label="gapFillMs" value={params.gapFillMs} step={10} min={0} max={400}
            onChange={(v) => setParams(p => ({ ...p, gapFillMs: v }))} />
          <Field label="medWin (odd)" value={params.medWin} step={2} min={1} max={21}
            onChange={(v) => setParams(p => ({ ...p, medWin: v % 2 === 0 ? v + 1 : v }))} />

          <Field label="smoothWin (odd)" value={params.smoothWin} step={2} min={1} max={41}
            onChange={(v) => setParams(p => ({ ...p, smoothWin: v % 2 === 0 ? v + 1 : v }))} />

          <div className="debugActions">
            <button onClick={reAnalyze} disabled={busy}>
              再解析
            </button>
            <button
              onClick={() => setParams(DEFAULT_PARAMS)}
              disabled={busy}
            >
              デフォルトへ
            </button>
          </div>

          <div className="small" style={{ marginTop: 10 }}>
            Tip: 声調の階段っぽさは <b>hopMs=10</b> / <b>smoothWin</b>↑ / <b>maxJumpSemitone</b>↓ が効きます。無音が残るなら <b>trimRmsRatio</b>↑。
          </div>
        </div>
      ) : (
        <div className="debugPanel" style={{ width: 180 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>Debug</h3>
            <button onClick={() => setDebugOpen(true)} style={{ padding: "6px 10px" }}>
              開く
            </button>
          </div>
          <div className="small">パラメータ調整を表示します</div>
        </div>
      )}
    </div>
  );
}

function Field(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      <label>
        {props.label}
        <div className="small">{String(props.value)}</div>
      </label>
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </div>
  );
}


function trimSilence(pcm: Float32Array, sr: number, rmsRatio: number, padMs: number) {
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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    const v = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, v, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
