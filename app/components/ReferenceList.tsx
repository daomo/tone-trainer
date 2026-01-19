import { useMemo, useRef, useState } from "react";
import type { ReferenceItem, ReferenceAudio } from "../lib/types";

type ReferenceListProps = {
  items: ReferenceItem[];
  basePath: string;
  voiceVariant: "A" | "B";
  onToggleVoice: () => void;
  selectedAudioId: string | null;
  onSelect: (item: ReferenceItem, audio: ReferenceAudio) => void;
};

export default function ReferenceList(props: ReferenceListProps) {
  const { items, basePath, voiceVariant, onToggleVoice, selectedAudioId, onSelect } = props;
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const voiceMap = useMemo(() => ({
    A: "F",
    B: "M",
  }), []);

  function pickAudio(list: ReferenceAudio[]) {
    if (list.length === 0) return null;
    const targetGender = voiceMap[voiceVariant];
    return list.find((a) => a.gender === targetGender) || list[0];
  }

  async function handlePlay(item: ReferenceItem) {
    const audio = pickAudio(item.audio);
    if (!audio) return;
    const rawPath = audio.path.startsWith("/") ? audio.path : `/${audio.path}`;
    const url = `${basePath}${rawPath}`;

    if (!audioRef.current) audioRef.current = new Audio();
    const player = audioRef.current;
    player.pause();
    player.src = url;
    try {
      await player.play();
      setPlayingId(audio.id);
      player.onended = () => setPlayingId(null);
    } catch (e) {
      console.error(e);
      setPlayingId(null);
    }
  }

  return (
    <div className="referencePanel">
      <div className="referenceHeader">
        <h3>お手本一覧</h3>
        <button onClick={onToggleVoice}>
          音声切替（{voiceVariant}）
        </button>
      </div>

      <div className="referenceList">
        {items.map((item) => (
          <div className="referenceItem" key={item.key}>
            <div className="referenceText">{item.text}</div>
            <div className="referenceMeta">
              <span className="small">{item.pinyin}</span>
              <span className="small">{item.ja}</span>
            </div>
            <div className="referenceActions">
              <button
                onClick={() => handlePlay(item)}
                className="referencePlay"
              >
                {playingId?.startsWith(item.key) ? "再生中" : "再生"}
              </button>
              <button
                onClick={() => {
                  const audio = pickAudio(item.audio);
                  if (audio) onSelect(item, audio);
                }}
                className="referenceSelect"
              >
                {selectedAudioId?.startsWith(item.key) ? "選択中" : "お手本に設定"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
