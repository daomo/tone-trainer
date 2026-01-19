import type { F0Params } from "../../lib/types";

export const DEFAULT_PARAMS: F0Params = {
  targetSr: 16000,

  // Speech (tones) tends to look better with denser hop.
  hopMs: 4,
  windowMs: 100,

  fminHz: 70,
  fmaxHz: 500,

  yinThreshold: 0.12,
  rmsSilence: 0.02,

  trimRmsRatio: 0.02,
  trimPadMs: 60,

  // DP / Viterbi stabilization
  dpEnabled: true,
  dpTopK: 5,
  dpLambda: 80,
  dpUSwitch: 0.5,
  dpUPenalty: 0.6,

  voicedPrior: 0.55,
  nearSilenceRatio: 1.1,
  nearSilenceVoicedBias: 0.2,
  nearSilenceUnvoicedBias: 0.15,

  maxJumpSemitone: 12,
  gapFillMs: 30,
  medWin: 3,
  smoothWin: 7,
};
