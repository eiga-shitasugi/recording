# ポッドキャスト収録・ビデオ通話アプリ

ブラウザだけで使えるポッドキャスト収録 + WebRTCビデオ通話アプリです。

## 機能

- **録音** — マイク選択・30秒チャンク自動保存・サーバーアップロード
- **ビデオ通話** — ルームIDを共有するだけで複数人がP2P通話（音声＋映像）
- **招待** — URLコピーまたはルームIDを伝えるだけで参加可能
- **PC・スマホ対応**

## ローカル起動

```bash
npm install
node server.js
# → http://localhost:3000
```

---

## Railway へのデプロイ手順

### 前提

- [Git](https://git-scm.com/) がインストール済み
- [GitHub](https://github.com/) アカウントがある
- [Railway](https://railway.app/) アカウントがある（GitHub でログイン推奨）

---

### Step 1 — GitHub リポジトリを作る

1. [github.com/new](https://github.com/new) を開く
2. リポジトリ名を入力（例：`podcast-app`）
3. **Private** または **Public** を選択して「Create repository」

---

### Step 2 — コードを GitHub へプッシュ

このフォルダをターミナルで開いて以下を実行：

```bash
git init
git add .
git commit -m "初回コミット"
git branch -M main
git remote add origin https://github.com/あなたのユーザー名/podcast-app.git
git push -u origin main
```

---

### Step 3 — Railway でデプロイ

1. [railway.app](https://railway.app/) を開いてログイン
2. ダッシュボードで **「New Project」** をクリック
3. **「Deploy from GitHub repo」** を選択
4. 先ほど作った `podcast-app` リポジトリを選択
5. Railway が自動でビルド・デプロイを開始します（1〜2分）

---

### Step 4 — 公開URLを確認

デプロイ完了後：

1. Railway のプロジェクト画面を開く
2. **「Settings」→「Domains」** をクリック
3. **「Generate Domain」** を押す
4. `https://xxxx.up.railway.app` 形式のURLが発行される

このURLを参加者に共有するだけで通話できます。

---

### 環境変数

Railway が自動で `PORT` を設定するため、手動設定は不要です。

| 変数 | 説明 | 設定 |
|------|------|------|
| `PORT` | サーバーポート | Railway が自動設定 |

---

### 注意事項

| 項目 | 内容 |
|------|------|
| 録音ファイル | Railway のファイルシステムは再デプロイで消えます。録音は「⬇ 保存」でPCにダウンロードしてください。 |
| ビデオ通話（LAN外） | 一般的なNAT環境ではSTUNサーバーで接続できます。ごく一部の企業ネットワーク等ではTURNサーバーが必要になる場合があります。 |
| 無料プラン | Railway の無料枠（Hobby: $5クレジット/月）で十分動作します。 |

---

### Railway CLI を使う方法（上級者向け）

```bash
# Railway CLI インストール
npm install -g @railway/cli

# ログイン
railway login

# プロジェクト初期化
railway init

# デプロイ
railway up
```
