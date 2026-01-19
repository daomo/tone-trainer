export type F0Params = {
  targetSr: number;      // e.g. 16000
  hopMs: number;         // e.g. 10-20
  windowMs: number;      // e.g. 30-50
  fminHz: number;        // e.g. 60-120
  fmaxHz: number;        // e.g. 300-500
  yinThreshold: number;  // smaller -> stricter voiced decision (0.08-0.18)
  rmsSilence: number;    // silence gate for per-frame analysis (0.005-0.02)

  // Pre-trim leading/trailing silence on the whole recording
  trimRmsRatio: number;  // ratio of max RMS to detect silence (0.01-0.05)
  trimPadMs: number;     // keep a small padding around trimmed edges (20-120)

  // DP / Viterbi stabilization (pYIN-like core)
  dpEnabled: boolean;      // enable candidate + DP path selection
  dpTopK: number;          // number of voiced candidates per frame (2-6)
  dpLambda: number;        // smoothness strength for voiced->voiced (ΔlogF0^2)
  dpUSwitch: number;       // penalty for switching voiced <-> unvoiced
  dpUPenalty: number;      // per-frame penalty for choosing unvoiced (larger => prefer voiced)

  // pYIN-style priors / biasing
  voicedPrior: number;          // prior probability of voiced (0-1)
  nearSilenceRatio: number;     // rmsSilence multiplier for near-silence
  nearSilenceVoicedBias: number;   // add cost to voiced when near silence
  nearSilenceUnvoicedBias: number; // subtract cost from unvoiced when near silence

  // Post-processing for stability (tone contour)
  maxJumpSemitone: number; // max allowed jump per frame (1-6)
  gapFillMs: number;       // fill short NaN gaps (50-250)
  medWin: number;          // odd, median window (3-11)
  smoothWin: number;       // odd, moving average window (3-21)
};

export type F0Result = {
  sr: number;
  duration: number;
  times: number[];   // seconds
  f0Log: number[];   // log(Hz), NaN for unvoiced
};

export type WorkerRequest =
  | { type: "analyze"; pcm: Float32Array; sr: number; params: F0Params }
  | { type: "ping" };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "progress"; phase: string }
  | { type: "result"; result: F0Result }
  | { type: "error"; message: string };

export type ReferenceAudio = {
  id: string;
  gender: "F" | "M";
  voice: string;
  path: string;
  featurePath?: string;
};

export type ReferenceItem = {
  id: number;
  key: string;
  text: string;
  pinyin: string;
  ja: string;
  grammarTag: string;
  topicTag: string;
  audio: ReferenceAudio[];
};

export type ReferenceIndex = {
  version: number;
  generatedAt: string;
  count: number;
  items: ReferenceItem[];
};

export type ReferenceFeature = {
  id: number;
  key: string;
  audioId: string;
  sr: number;
  duration: number;
  hopMs: number;
  windowMs: number;
  featureType: string;
  featureDim: number;
  features: number[][];
  mfcc?: {
    nMels: number;
    nMfcc: number;
    fMinHz: number;
    fMaxHz: number;
    preEmphasis: number;
  };
  times: number[];
  f0Log: number[];
};

export type ComparisonResult = {
  corr: number;
  rmse: number;
  slopeMatch: number;
  peakShiftMs: number;
};
