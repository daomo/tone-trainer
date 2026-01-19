import type { F0Result, F0Params } from "./types";

export type DrawState = {
  baseImage: ImageData | null;
  duration: number;
};

export function makeDrawState(): DrawState {
  return { baseImage: null, duration: 0 };
}

export function drawBase(
  ctx: CanvasRenderingContext2D,
  cv: HTMLCanvasElement,
  result: F0Result,
  params: F0Params,
  state: DrawState,
  reference?: { times: number[]; f0Log: number[]; duration: number }
) {
  const { width: W, height: H } = cv;
  const duration = Math.max(result.duration, reference?.duration ?? 0);

  // background
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0b0b0b";
  ctx.fillRect(0, 0, W, H);

  drawAxes(ctx, cv, params, duration);
  if (reference) {
    drawF0Line(ctx, cv, reference.times, reference.f0Log, params, duration, "#7bdc8d", 1.5, [4, 4]);
  }
  drawF0Line(ctx, cv, result.times, result.f0Log, params, duration, "#4dd0ff", 2);

  state.baseImage = ctx.getImageData(0, 0, W, H);
  state.duration = duration;
}

export function drawReferenceOnly(
  ctx: CanvasRenderingContext2D,
  cv: HTMLCanvasElement,
  params: F0Params,
  state: DrawState,
  reference: { times: number[]; f0Log: number[]; duration: number }
) {
  const { width: W, height: H } = cv;
  const duration = Math.max(0.001, reference.duration);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0b0b0b";
  ctx.fillRect(0, 0, W, H);

  drawAxes(ctx, cv, params, duration);
  drawF0Line(ctx, cv, reference.times, reference.f0Log, params, duration, "#7bdc8d", 1.5, [4, 4]);

  state.baseImage = ctx.getImageData(0, 0, W, H);
  state.duration = duration;
}

export function redrawWithCursor(
  ctx: CanvasRenderingContext2D,
  cv: HTMLCanvasElement,
  result: F0Result,
  params: F0Params,
  state: DrawState,
  t: number
) {
  if (!state.baseImage) {
    drawBase(ctx, cv, result, params, state);
  } else {
    ctx.putImageData(state.baseImage, 0, 0);
  }
  const cursorDuration = state.duration > 0 ? state.duration : result.duration;
  drawCursor(ctx, cv, t, cursorDuration);
}

export function redrawCursorOnly(
  ctx: CanvasRenderingContext2D,
  cv: HTMLCanvasElement,
  state: DrawState,
  t: number
) {
  if (!state.baseImage) return;
  ctx.putImageData(state.baseImage, 0, 0);
  const cursorDuration = state.duration > 0 ? state.duration : 0.001;
  drawCursor(ctx, cv, t, cursorDuration);
}

function pad() {
  return { L: 46, R: 10, T: 10, B: 22 };
}

function drawAxes(
  ctx: CanvasRenderingContext2D,
  cv: HTMLCanvasElement,
  params: F0Params,
  duration: number
) {
  const { width: W, height: H } = cv;
  const { L, R, T, B } = pad();

  // plot box
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.strokeRect(L, T, W - L - R, H - T - B);

  ctx.fillStyle = "#ddd";
  ctx.font = "12px system-ui";
  ctx.fillText("time (s)", W - 70, H - 6);
  ctx.fillText("log(Hz)", 6, 16);

  const x0 = L, x1 = W - R, y0 = T, y1 = H - B;
  const dur = Math.max(0.001, duration);

  // x grid
  const nTick = 5;
  for (let i = 0; i <= nTick; i++) {
    const tt = (dur * i) / nTick;
    const x = x0 + (x1 - x0) * (tt / dur);
    ctx.strokeStyle = "#222";
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
    ctx.fillStyle = "#aaa";
    ctx.fillText(tt.toFixed(1), x - 10, y1 + 14);
  }

  // y grid
  const yMin = Math.log(params.fminHz);
  const yMax = Math.log(params.fmaxHz);
  const yTick = 4;
  for (let i = 0; i <= yTick; i++) {
    const vv = yMin + (yMax - yMin) * (i / yTick);
    const y = y1 - (y1 - y0) * ((vv - yMin) / (yMax - yMin));
    ctx.strokeStyle = "#222";
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();

    ctx.fillStyle = "#aaa";
    ctx.fillText(Math.exp(vv).toFixed(0), 8, y + 4);
  }
}

function drawF0Line(
  ctx: CanvasRenderingContext2D,
  cv: HTMLCanvasElement,
  times: number[],
  f0Log: number[],
  params: F0Params,
  duration: number,
  color: string,
  lineWidth: number,
  dash?: number[]
) {
  const { width: W, height: H } = cv;
  const { L, R, T, B } = pad();
  const x0 = L, x1 = W - R, y0 = T, y1 = H - B;

  const dur = Math.max(0.001, duration);
  const yMin = Math.log(params.fminHz);
  const yMax = Math.log(params.fmaxHz);

  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  if (dash && dash.length > 0) ctx.setLineDash(dash);
  else ctx.setLineDash([]);

  let started = false;
  ctx.beginPath();

  for (let i = 0; i < f0Log.length; i++) {
    const t = times[i];
    const v = f0Log[i];
    if (!Number.isFinite(v)) { started = false; continue; }

    const x = x0 + (x1 - x0) * (t / dur);
    const y = y1 - (y1 - y0) * ((v - yMin) / (yMax - yMin));

    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }

  ctx.stroke();
  ctx.setLineDash([]);
}

function drawCursor(
  ctx: CanvasRenderingContext2D,
  cv: HTMLCanvasElement,
  t: number,
  duration: number
) {
  const { width: W, height: H } = cv;
  const { L, R, T, B } = pad();
  const x0 = L, x1 = W - R, y0 = T, y1 = H - B;

  const dur = Math.max(0.001, duration);
  const clamped = Math.max(0, Math.min(dur, t));
  const x = x0 + (x1 - x0) * (clamped / dur);

  ctx.strokeStyle = "#ffcc00";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, y1);
  ctx.stroke();
}
