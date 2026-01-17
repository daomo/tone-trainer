"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { F0Params, F0Result, WorkerResponse } from "./lib/types";
import { startRecording, decodeToMonoPCM, resampleMonoPCM } from "./lib/audio";
import { drawBase, makeDrawState, redrawWithCursor } from "./lib/draw";

const DEFAULT_PARAMS: F0Params = {
  targetSr: 16000,
  hopMs: 20,
  windowMs: 40,
  fminHz: 80,
  fmaxHz: 350,
  yinThreshold: 0.12,
  rmsSilence: 0.008,
  medWin: 7,
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

          const url = URL.createObjectURL(b);
          setBlobUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return url;
          });

          // auto analyze immediately
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
      const pcm = await resampleMonoPCM(mono, sr, target);

      // stash for re-analyze
      lastPcmRef.current = pcm;
      lastSrRef.current = target;

      setStatus("sending to worker…");
      const w = workerRef.current;
      if (!w) throw new Error("worker not ready");

      // transfer the buffer for speed
      w.postMessage(
        { type: "analyze", pcm, sr: target, params } as any,
        [pcm.buffer]
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

    // If last buffer was transferred, make a fresh copy for worker transfer
    const pcmCopy = new Float32Array(pcm);

    const w = workerRef.current;
    if (!w) {
      setBusy(false);
      setStatus("worker not ready");
      return;
    }

    w.postMessage(
      { type: "analyze", pcm: pcmCopy, sr, params } as any,
      [pcmCopy.buffer]
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

      <audio
        ref={audioRef}
        controls
        src={blobUrl}
        style={{ width: "100%", marginTop: 10 }}
        onPlay={() => startRaf()}
        onPause={() => onPause()}
      />

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

          <Field label="medWin (odd)" value={params.medWin} step={2} min={1} max={21}
            onChange={(v) => setParams(p => ({ ...p, medWin: v % 2 === 0 ? v + 1 : v }))} />

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
            Tip: 倍音ジャンプが気になるなら <b>medWin</b> を上げる / <b>yinThreshold</b> を少し下げる。
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
