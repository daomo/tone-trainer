import type { Dispatch, SetStateAction } from "react";
import type { F0Params } from "../lib/types";

type DebugPanelProps = {
  debugAllowed: boolean;
  debugOpen: boolean;
  setDebugOpen: Dispatch<SetStateAction<boolean>>;
  params: F0Params;
  setParams: Dispatch<SetStateAction<F0Params>>;
  busy: boolean;
  onReAnalyze: () => void;
  onResetDefaults: () => void;
};

export default function DebugPanel(props: DebugPanelProps) {
  const {
    debugAllowed,
    debugOpen,
    setDebugOpen,
    params,
    setParams,
    busy,
    onReAnalyze,
    onResetDefaults,
  } = props;

  if (!debugAllowed) return null;

  if (!debugOpen) {
    return (
      <div className="debugPanel" style={{ width: 180 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Debug</h3>
          <button onClick={() => setDebugOpen(true)} style={{ padding: "6px 10px" }}>
            開く
          </button>
        </div>
        <div className="small">パラメータ調整を表示します</div>
      </div>
    );
  }

  return (
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

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          checked={params.dpEnabled}
          onChange={(e) => setParams(p => ({ ...p, dpEnabled: e.target.checked }))}
        />
        <span>dpEnabled (候補+DPで安定化)</span>
      </div>

      <Field label="dpTopK" value={params.dpTopK} step={1} min={2} max={6}
        onChange={(v) => setParams(p => ({ ...p, dpTopK: Math.round(v) }))} />

      <Field label="dpLambda" value={params.dpLambda} step={10} min={0} max={500}
        onChange={(v) => setParams(p => ({ ...p, dpLambda: v }))} />

      <Field label="dpUSwitch" value={params.dpUSwitch} step={0.05} min={0} max={2}
        onChange={(v) => setParams(p => ({ ...p, dpUSwitch: v }))} />

      <Field label="dpUPenalty" value={params.dpUPenalty} step={0.05} min={0} max={2}
        onChange={(v) => setParams(p => ({ ...p, dpUPenalty: v }))} />

      <Field label="voicedPrior" value={params.voicedPrior} step={0.05} min={0.05} max={0.95}
        onChange={(v) => setParams(p => ({ ...p, voicedPrior: v }))} />

      <Field label="nearSilenceRatio" value={params.nearSilenceRatio} step={0.05} min={1.0} max={2.0}
        onChange={(v) => setParams(p => ({ ...p, nearSilenceRatio: v }))} />

      <Field label="nearSilenceVoicedBias" value={params.nearSilenceVoicedBias} step={0.05} min={0} max={1.5}
        onChange={(v) => setParams(p => ({ ...p, nearSilenceVoicedBias: v }))} />

      <Field label="nearSilenceUnvoicedBias" value={params.nearSilenceUnvoicedBias} step={0.05} min={0} max={1.5}
        onChange={(v) => setParams(p => ({ ...p, nearSilenceUnvoicedBias: v }))} />

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
        <button onClick={onReAnalyze} disabled={busy}>
          再解析
        </button>
        <button onClick={onResetDefaults} disabled={busy}>
          デフォルトへ
        </button>
      </div>

      <div className="small" style={{ marginTop: 10 }}>
        Tips
      </div>
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
