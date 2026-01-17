export type F0Params = {
  targetSr: number;      // e.g. 16000
  hopMs: number;         // e.g. 20
  windowMs: number;      // e.g. 40
  fminHz: number;        // e.g. 80
  fmaxHz: number;        // e.g. 350
  yinThreshold: number;  // e.g. 0.12
  rmsSilence: number;    // e.g. 0.008
  medWin: number;        // odd, e.g. 7
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
