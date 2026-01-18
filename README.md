# tone-trainer

ローカル完結の「録音 → F0抽出(YIN) → Canvas描画 → 再生同期(縦線)」デモです。  
重い処理（YIN＋平滑化）は WebWorker に隔離しています。

## 使い方
- 「録音開始」→「停止」すると、**自動で解析→描画**します。
- 解析中はオーバーレイにスピナーが出ます。
- 再生すると縦線が音声と同期して動きます。
- 右上の Debug パネルでパラメータ変更 → 「再解析」で比較できます。

## よくある詰まり
- Worker が動かない / import.meta.url 周りでエラー：  
  `next dev --turbo` を使っている場合は、いったん通常の `npm run dev` で試してください。

## iOS / スマホで録音できないとき
- iOS Safari は `MediaRecorder` が不安定な場合があります。
- このプロジェクトは `MediaRecorder` が使えない場合、**PCM録音（ScriptProcessor）に自動フォールバック**します。
- それでもダメな場合は「アプリ内ブラウザ（LINE等）」を避けて Safari で開いてください。

## パラメータの意味（Debug Params）
- targetSr: 解析用サンプリング周波数（16kHz推奨）
- hopMs: 何msごとにF0を出すか。小さいほど滑らか（負荷↑）
- windowMs: 窓長。短いほど追従（ノイズ↑）、長いほど安定（遅れ/ぼやけ↑）
- fminHz/fmaxHz: 探索するF0範囲（狭いほど安定＆速い）
- yinThreshold: 有声音判定の厳しさ。小さいほど「確信がある時だけF0」
- rmsSilence: フレーム単位の無声ゲート（小さいほど拾う）

- trimRmsRatio: 録音全体の先頭/末尾の無音を切るしきい値（最大RMSに対する割合）
- trimPadMs: 切り詰め後に残す余白（ms）

- maxJumpSemitone: 1フレームで許す最大ジャンプ（半音）。小さいほど滑らか（外れはNaN化）
- gapFillMs: 短いNaN穴を線形補間する最大長（ms）
- medWin: 中央値フィルタ窓（外れ値に強い）
- smoothWin: 移動平均窓（階段状の見た目改善に効く）
