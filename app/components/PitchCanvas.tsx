import type { RefObject } from "react";

type PitchCanvasProps = {
  canvasRef: RefObject<HTMLCanvasElement>;
  busy: boolean;
};

export default function PitchCanvas(props: PitchCanvasProps) {
  const { canvasRef, busy } = props;

  return (
    <div className="canvasWrap">
      <canvas ref={canvasRef} width={980} height={280} />
      {busy && (
        <div className="overlay" aria-label="analyzing">
          <div style={{ display: "grid", placeItems: "center", gap: 10 }}>
            <div className="spinner" />
            <div className="small">解析中…</div>
          </div>
        </div>
      )}
    </div>
  );
}
