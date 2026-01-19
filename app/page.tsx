"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  F0Params,
  F0Result,
  WorkerResponse,
  ReferenceIndex,
  ReferenceAudio,
  ReferenceItem,
  ReferenceFeature,
  ComparisonResult,
} from "./lib/types";
import { startRecording, decodeToMonoPCM, resampleMonoPCM } from "./lib/audio";
import { drawBase, drawReferenceOnly, makeDrawState, redrawCursorOnly, redrawWithCursor } from "./lib/draw";
import AudioControls from "./components/AudioControls";
import PitchCanvas from "./components/PitchCanvas";
import DebugPanel from "./components/DebugPanel";
import PlaybackPlayer from "./components/PlaybackPlayer";
import ReferenceList from "./components/ReferenceList";
import { DEFAULT_PARAMS } from "./features/analysis/constants";
import { trimSilence } from "./features/analysis/trim";
import { encodeWav16 } from "./features/analysis/wav";
import { dtwBandFeatures } from "./features/analysis/dtw";
import { computeMfcc } from "./features/analysis/mfcc";

export default function Page() {
  const [params, setParams] = useState<F0Params>(DEFAULT_PARAMS);
  const [status, setStatus] = useState<string>("ready");
  const [busy, setBusy] = useState(false);
  const isProd = process.env.NODE_ENV === "production";
  const [debugAllowed, setDebugAllowed] = useState(!isProd);
  const [debugOpen, setDebugOpen] = useState(!isProd);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [voiceVariant, setVoiceVariant] = useState<"A" | "B">("A");
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [referencePlaying, setReferencePlaying] = useState(false);

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
  const [analysisVersion, setAnalysisVersion] = useState(0);

  const recCtlRef = useRef<{ stop: () => void } | null>(null);
  const [recording, setRecording] = useState(false);
  const [referenceIndex, setReferenceIndex] = useState<ReferenceIndex | null>(null);
  const [referenceError, setReferenceError] = useState<string>("");
  const [selectedReference, setSelectedReference] = useState<ReferenceItem | null>(null);
  const [selectedReferenceAudio, setSelectedReferenceAudio] = useState<ReferenceAudio | null>(null);
  const [referenceFeature, setReferenceFeature] = useState<ReferenceFeature | null>(null);
  const [referenceFeatureError, setReferenceFeatureError] = useState<string>("");
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [alignmentError, setAlignmentError] = useState("");
  const [alignedReference, setAlignedReference] = useState<F0Result | null>(null);
  const referenceAudioRef = useRef<HTMLAudioElement | null>(null);
  const refRafRef = useRef<number | null>(null);

  const stopRaf = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const renderBase = useCallback((opts?: {
    user?: F0Result | null;
    reference?: ReferenceFeature | null;
    alignedReference?: F0Result | null;
  }) => {
    const ctx = ctxRef.current;
    const cv = cvRef.current;
    if (!ctx || !cv) return;
    const user = opts?.user ?? analysisRef.current;
    const reference = opts?.reference ?? referenceFeature;
    const aligned = opts?.alignedReference ?? alignedReference;

    if (user) {
      const ref = aligned
        ? { times: aligned.times, f0Log: aligned.f0Log, duration: aligned.duration }
        : undefined;
      drawBase(ctx, cv, user, params, drawState, ref);
      return;
    }

    if (reference) {
      drawReferenceOnly(ctx, cv, params, drawState, {
        times: reference.times,
        f0Log: reference.f0Log,
        duration: reference.duration,
      });
    }
  }, [alignedReference, drawState, params, referenceFeature]);

  const clearRecording = useCallback(() => {
    analysisRef.current = null;
    setAlignedReference(null);
    setAlignmentError("");
    setComparison(null);
    setBlobUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
    stopRaf();
    setPlaying(false);
    renderBase({ user: null, reference: referenceFeature ?? null });
  }, [referenceFeature, renderBase, stopRaf]);

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
        setAnalysisVersion((v) => v + 1);
        setStatus(`done: ${msg.result.duration.toFixed(2)}s, frames=${msg.result.times.length}`);

        const ctx2 = ctxRef.current;
        const cv2 = cvRef.current;
        if (ctx2 && cv2) renderBase();
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
    let alive = true;
    fetch("/reference/index.json")
      .then((res) => {
        if (!res.ok) throw new Error(`index fetch failed (${res.status})`);
        return res.json();
      })
      .then((data: ReferenceIndex) => {
        if (!alive) return;
        setReferenceIndex(data);
      })
      .catch((err) => {
        if (!alive) return;
        console.error(err);
        setReferenceError("お手本一覧の読み込みに失敗しました。");
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!selectedReference) return;
    const nextAudio = pickReferenceAudio(selectedReference, voiceVariant);
    setSelectedReferenceAudio(nextAudio);
  }, [selectedReference, voiceVariant]);

  useEffect(() => {
    if (!selectedReferenceAudio?.featurePath) {
      setReferenceFeature(null);
      setReferenceFeatureError("");
      return;
    }
    let alive = true;
    const url = selectedReferenceAudio.featurePath.startsWith("/")
      ? selectedReferenceAudio.featurePath
      : `/${selectedReferenceAudio.featurePath}`;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`feature fetch failed (${res.status})`);
        return res.json();
      })
      .then((data: ReferenceFeature) => {
        if (!alive) return;
        setReferenceFeature(data);
        setReferenceFeatureError("");
      })
      .catch((err) => {
        if (!alive) return;
        console.error(err);
        setReferenceFeature(null);
        setReferenceFeatureError("お手本特徴量の読み込みに失敗しました。");
      });
    return () => { alive = false; };
  }, [selectedReferenceAudio]);

  useEffect(() => {
    renderBase();
  }, [referenceFeature, renderBase]);

  useEffect(() => {
    if (!selectedReference) return;
    clearRecording();
  }, [selectedReference, clearRecording]);

  useEffect(() => {
    const user = analysisRef.current;
    if (!user) {
      setComparison(null);
      setAlignmentError("");
      setAlignedReference(null);
      renderBase({ user: null, reference: referenceFeature ?? null });
      return;
    }
    if (!referenceFeature) {
      setComparison(null);
      setAlignmentError("");
      setAlignedReference(null);
      renderBase({ user, reference: null });
      return;
    }
    const refFeatures = referenceFeature.features;
    const userFeatures = buildUserMfccFeatures(
      lastPcmRef.current,
      lastSrRef.current,
      referenceFeature
    );
    if (!userFeatures) {
      setAlignmentError("解析に失敗しました。");
      setComparison(null);
      setAlignedReference(null);
      renderBase({ user, reference: referenceFeature });
      return;
    }
    const { path } = dtwBandFeatures(refFeatures, userFeatures);
    if (path.length === 0) {
      setAlignmentError("解析に失敗しました。");
      setComparison(null);
      setAlignedReference(null);
      renderBase({ user, reference: referenceFeature });
      return;
    }
    setAlignmentError("");
    setComparison(null);
    const aligned = buildAlignedReference(user, referenceFeature, path);
    setAlignedReference(aligned);
    renderBase({
      user,
      reference: referenceFeature,
      alignedReference: aligned,
    });
  }, [referenceFeature, analysisVersion, renderBase]);

  useEffect(() => {
    if (!isProd) return;
    const isGhPages = window.location.hostname.endsWith("github.io");
    const hasDebug = new URLSearchParams(window.location.search).has("debug");
    const allow = isGhPages && hasDebug;
    setDebugAllowed(allow);
    setDebugOpen(allow);
  }, [isProd]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onEnded = () => {
      stopRaf();
      setPlaying(false);
      const a = analysisRef.current;
      const ctx = ctxRef.current;
      const cv = cvRef.current;
      if (a && ctx && cv) redrawWithCursor(ctx, cv, a, params, drawState, a.duration);
    };

    audio.addEventListener("ended", onEnded);
    return () => audio.removeEventListener("ended", onEnded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = playbackRate;
    audio.defaultPlaybackRate = playbackRate;
  }, [playbackRate, blobUrl]);

  function stopRefRaf() {
    if (refRafRef.current != null) cancelAnimationFrame(refRafRef.current);
    refRafRef.current = null;
  }

  function startRefRaf(refAudio: HTMLAudioElement) {
    stopRefRaf();
    const tick = () => {
      const ctx = ctxRef.current;
      const cv = cvRef.current;
      if (ctx && cv) {
        redrawCursorOnly(ctx, cv, drawState, refAudio.currentTime);
      }
      refRafRef.current = requestAnimationFrame(tick);
    };
    refRafRef.current = requestAnimationFrame(tick);
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
    if (playing || referencePlaying) {
      setStatus("再生中は録音できません");
      return;
    }
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
    if (recording) {
      setStatus("録音中は再生できません");
      return;
    }
    if (referenceAudioRef.current) {
      referenceAudioRef.current.pause();
      setReferencePlaying(false);
      stopRefRaf();
    }
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = playbackRate;
    audio.play();
  }

  function onPause() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
  }

  return (
    <div className="container">
      <h2 style={{ margin: "10px 0 6px" }}>Tone Trainer</h2>

      <AudioControls
        busy={busy}
        recording={recording}
        playing={playing}
        blobUrl={blobUrl}
        status={status}
        playbackRate={playbackRate}
        onRecord={handleRecord}
        onStop={handleStop}
        onPlay={onPlay}
        onPause={onPause}
        onToggleRate={() => setPlaybackRate((prev) => (prev === 0.5 ? 1 : 0.5))}
        onClearRecording={clearRecording}
      />

      <PitchCanvas canvasRef={cvRef} busy={busy} />

      {comparison && (
        <div className="resultPanel">
          <div className="resultRow">
            <span>相関</span>
            <b>{comparison.corr.toFixed(2)}</b>
          </div>
          <div className="resultRow">
            <span>RMSE</span>
            <b>{comparison.rmse.toFixed(2)}</b>
          </div>
          <div className="resultRow">
            <span>上昇/下降一致率</span>
            <b>{(comparison.slopeMatch * 100).toFixed(0)}%</b>
          </div>
          <div className="resultRow">
            <span>ピーク差</span>
            <b>{comparison.peakShiftMs.toFixed(0)}ms</b>
          </div>
        </div>
      )}
      {alignmentError && (
        <div className="resultPanel">
          <div className="resultRow">
            <span>{alignmentError}</span>
          </div>
        </div>
      )}

      <PlaybackPlayer
        audioRef={audioRef}
        blobUrl={blobUrl}
        onPlay={() => {
          if (recording) {
            audioRef.current?.pause();
            setStatus("録音中は再生できません");
            return;
          }
          setPlaying(true);
          startRaf();
        }}
        onPause={() => {
          setPlaying(false);
          stopRaf();
          const a = analysisRef.current;
          const ctx = ctxRef.current;
          const cv = cvRef.current;
          const audio = audioRef.current;
          if (a && ctx && cv && audio) redrawWithCursor(ctx, cv, a, params, drawState, audio.currentTime);
        }}
      />

      <p className="small" style={{ marginTop: 10 }}>
        録音停止後に自動で解析します。
      </p>

      <div className="referenceSummary">
        <div className="referenceSummaryText">
          <div className="small">お手本</div>
          <div>
            {selectedReference ? selectedReference.text : "未選択"}
          </div>
          {selectedReference && (
            <div className="small">
              {selectedReference.pinyin} / 音声{voiceVariant}
            </div>
          )}
        </div>
        <div className="referenceSummaryActions">
          <button
            onClick={() => {
              if (!selectedReferenceAudio) {
                setStatus("お手本を選んでください");
                return;
              }
              if (!referenceFeature) {
                setStatus("お手本特徴量を読み込み中です");
                return;
              }
              if (recording) {
                setStatus("録音中は再生できません");
                return;
              }
              if (playing) {
                audioRef.current?.pause();
                setPlaying(false);
                stopRaf();
              }
              const url = selectedReferenceAudio.path.startsWith("/")
                ? selectedReferenceAudio.path
                : `/${selectedReferenceAudio.path}`;
              if (!referenceAudioRef.current) referenceAudioRef.current = new Audio();
              const refAudio = referenceAudioRef.current;
              refAudio.pause();
              refAudio.src = url;
              renderBase();
              refAudio.onended = () => {
                stopRefRaf();
                setReferencePlaying(false);
              };
              refAudio.play()
                .then(() => {
                  setReferencePlaying(true);
                  startRefRaf(refAudio);
                })
                .catch((e) => console.error(e));
            }}
            disabled={!selectedReferenceAudio || !referenceFeature || recording || referencePlaying}
          >
            お手本を再生
          </button>
          <button
            onClick={() => {
              if (recording) {
                setStatus("録音中はお手本を変更できません");
                return;
              }
              setReferenceOpen(true);
            }}
            disabled={recording}
          >
            お手本を選ぶ
          </button>
          <button
            onClick={() => {
              setSelectedReference(null);
              setSelectedReferenceAudio(null);
              setReferenceFeature(null);
              setComparison(null);
              setAlignmentError("");
              setAlignedReference(null);
              if (referenceAudioRef.current) {
                referenceAudioRef.current.pause();
                referenceAudioRef.current = null;
              }
              setReferencePlaying(false);
              stopRefRaf();
              renderBase();
            }}
            className="referenceClear"
            aria-label="お手本をクリア"
          >
            ×
          </button>
        </div>
      </div>

      <DebugPanel
        debugAllowed={debugAllowed}
        debugOpen={debugOpen}
        setDebugOpen={setDebugOpen}
        params={params}
        setParams={setParams}
        busy={busy}
        onReAnalyze={reAnalyze}
        onResetDefaults={() => setParams(DEFAULT_PARAMS)}
      />

      {referenceError && <div className="small">{referenceError}</div>}
      {referenceFeatureError && <div className="small">{referenceFeatureError}</div>}

      {referenceIndex && referenceOpen && (
        <div className="referenceOverlay" role="dialog" aria-modal="true">
          <div className="referenceOverlayBody">
            <div className="referenceOverlayHeader">
              <div>お手本を選ぶ</div>
              <button onClick={() => setReferenceOpen(false)}>閉じる</button>
            </div>
            <ReferenceList
              items={referenceIndex.items}
              voiceVariant={voiceVariant}
              onToggleVoice={() => setVoiceVariant((v) => (v === "A" ? "B" : "A"))}
              selectedAudioId={selectedReferenceAudio?.id ?? null}
              onSelect={(item, audio) => {
                setSelectedReference(item);
                setSelectedReferenceAudio(audio);
                renderBase();
                setReferenceOpen(false);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function pickReferenceAudio(item: ReferenceItem, variant: "A" | "B") {
  if (!item.audio.length) return null;
  const target = variant === "A" ? "F" : "M";
  return item.audio.find((a) => a.gender === target) || item.audio[0];
}

function buildUserMfccFeatures(
  pcm: Float32Array | null,
  sr: number,
  ref: ReferenceFeature
) {
  if (!pcm || pcm.length === 0) return null;
  const frameSize = nextPow2(Math.max(64, Math.round((ref.windowMs / 1000) * sr)));
  const hopSize = Math.max(1, Math.round((ref.hopMs / 1000) * sr));
  const nMels = ref.mfcc?.nMels ?? 24;
  const nMfcc = ref.mfcc?.nMfcc ?? 12;
  const { features } = computeMfcc(pcm, {
    sr,
    frameSize,
    hopSize,
    nMels,
    nMfcc,
  });
  return features;
}

function nextPow2(n: number) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function buildAlignedReference(user: F0Result, ref: ReferenceFeature, path: Array<[number, number]>): F0Result {
  const map = new Map<number, number[]>();
  for (const [ri, ui] of path) {
    if (!map.has(ui)) map.set(ui, []);
    map.get(ui)!.push(ri);
  }

  const aligned = user.times.map((_, ui) => {
    const targets = map.get(ui);
    if (!targets || targets.length === 0) return NaN;
    let sum = 0;
    let count = 0;
    for (const ri of targets) {
      const v = ref.f0Log[ri];
      if (!Number.isFinite(v)) continue;
      sum += v;
      count++;
    }
    return count > 0 ? sum / count : NaN;
  });

  return {
    sr: user.sr,
    duration: user.duration,
    times: user.times,
    f0Log: aligned,
  };
}
