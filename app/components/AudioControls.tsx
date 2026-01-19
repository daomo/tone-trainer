type AudioControlsProps = {
  busy: boolean;
  recording: boolean;
  playing: boolean;
  blobUrl: string;
  status: string;
  playbackRate: number;
  onRecord: () => void;
  onStop: () => void;
  onPlay: () => void;
  onPause: () => void;
  onToggleRate: () => void;
  onClearRecording: () => void;
};

export default function AudioControls(props: AudioControlsProps) {
  const {
    busy,
    recording,
    playing,
    blobUrl,
    status,
    playbackRate,
    onRecord,
    onStop,
    onPlay,
    onPause,
    onToggleRate,
    onClearRecording,
  } = props;

  return (
    <div className="row">
      <button onClick={onRecord} disabled={busy || recording || playing}>
        録音開始
      </button>
      <button onClick={onStop} disabled={!recording}>
        停止
      </button>
      <button onClick={onClearRecording} disabled={recording}>
        録音クリア
      </button>

      <button onClick={onPlay} disabled={busy || !blobUrl || recording}>
        再生
      </button>
      <button onClick={onPause} disabled={!blobUrl || recording || !playing}>
        一時停止
      </button>
      <button onClick={onToggleRate} disabled={!blobUrl || recording}>
        {playbackRate === 0.5 ? "1.0x" : "0.5x"}
      </button>

      <span className="badge">{recording ? "REC" : "IDLE"}</span>
      <span className="small">{status}</span>
    </div>
  );
}
