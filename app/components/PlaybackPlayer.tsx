import type { RefObject } from "react";

type PlaybackPlayerProps = {
  audioRef: RefObject<HTMLAudioElement>;
  blobUrl: string;
  onPlay: () => void;
  onPause: () => void;
};

export default function PlaybackPlayer(props: PlaybackPlayerProps) {
  const { audioRef, blobUrl, onPlay, onPause } = props;

  if (!blobUrl) return null;

  return (
    <audio
      ref={audioRef}
      controls
      src={blobUrl}
      style={{ width: "100%", marginTop: 10 }}
      onPlay={onPlay}
      onPause={onPause}
    />
  );
}
