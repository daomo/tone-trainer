# f0-yin-nextjs

ローカル完結の「録音 → F0抽出(YIN) → Canvas描画 → 再生同期(縦線)」デモです。  
重い処理（YIN＋平滑化）は WebWorker に隔離しています。

## 起動方法（初心者向け）

### 1) Node.js をインストール
- Node.js 18 以上（できれば 20）を入れてください。

### 2) 依存関係をインストール
このフォルダでターミナルを開いて：

```bash
npm install
```

### 3) 開発サーバー起動
```bash
npm run dev
```

起動後、ブラウザで `http://localhost:3000` を開きます。

> マイクは `localhost` なら許可が出ます（HTTPS扱い）。

## 使い方
- 「録音開始」→「停止」すると、**自動で解析→描画**します。
- 解析中はオーバーレイにスピナーが出ます。
- 再生すると縦線が音声と同期して動きます。
- 右上の Debug パネルでパラメータ変更 → 「再解析」で比較できます。

## よくある詰まり
- Worker が動かない / import.meta.url 周りでエラー：  
  `next dev --turbo` を使っている場合は、いったん通常の `npm run dev` で試してください。

## GitHub Pages への公開（export + CI/CD）

このプロジェクトは **Next.js 静的書き出し（output: "export"）** で、GitHub Pages にそのまま載せられます。

### 1) リポジトリ作成＆push
- GitHub にリポジトリ（例: `f0-yin-nextjs`）を作り、`main` ブランチに push。

### 2) Pages の設定
GitHub のリポジトリ画面 → **Settings → Pages**
- **Source** を **GitHub Actions** にする

### 3) 自動デプロイ
`main` に push すると、GitHub Actions が走って `out/` を Pages にデプロイします。
- ワークフロー: `.github/workflows/pages.yml`

### URL
Project Pages の場合:
- `https://<ユーザー名>.github.io/<リポジトリ名>/`

### 補足（basePathについて）
- GitHub Pages（Project Pages）はサブパス配下（`/<repo>/`）になるため、
  `next.config.js` で **本番時だけ** `basePath`/`assetPrefix` を自動設定しています。
- Actions 内で `NEXT_PUBLIC_REPO_NAME` をリポジトリ名に自動設定しています。
