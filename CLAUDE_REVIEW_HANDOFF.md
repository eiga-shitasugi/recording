# SureCast 引き継ぎ書（2026-04-16 更新）

## 概要
4人以下のPodcast収録用ブラウザアプリ。
WebRTC mesh + Socket.io シグナリング + ローカル録音（本命）+ サーバー録音（保険）。

## 本番環境
- URL: https://surecast.virtualeigabar.com/
- VPS: 162.43.22.84
- 構成: nginx → Docker container (0a5ddd4ed58a) → Node.js :3000
- ソース: /root/apps/surecast
- コンテナ内パス: /app
- **修正時は必ず `docker cp` でコンテナに反映すること（restart不要・静的ファイルのみの場合）**
- **server.js変更時は `docker restart 0a5ddd4ed58a` も必要**

---

## 完了済み修正一覧（2026-04-16）

### Claudeによる修正
| ファイル | 内容 |
|---------|------|
| `public/js/core/call-core.js` | `createPeer()` のasync race condition修正。`Promise.all`でiceConfig+localStreamを先取得し、tracks追加後にpeers登録。`_creatingPeers` Mapで重複作成防止。`onnegotiationneeded`ハンドラ追加でICE restart機能を修正。 |
| `public/index.html` | `getUsername()` → `getUserName()` typo修正（2箇所）。`volatile.emit('leave-room')` → 通常`emit`に変更。 |

### Codexによる修正（Task 1〜6）
| Task | ファイル | 内容 |
|------|---------|------|
| 1 | `public/index.html` | フォールバック`createPeer()`のtrack追加順序修正。`addTrack`を`setPeer`より前に移動。`setParameters`の無効な即時呼び出しを削除。 |
| 2 | `public/index.html` | `stopServerRecording()`内の`volatile.emit('stop-server-recording')` → 通常`emit`に変更。 |
| 3 | `public/index.html` | `leaveCall()`冒頭に`stopRecording()`追加。通話終了時にローカル録音を自動停止。 |
| 4 | `server.js` + `public/index.html` | 録音状態の参加者間リアルタイム共有。`recording-status`イベント追加。ビデオラベルに⏺表示。 |
| 5 | `public/index.html` | socket再接続時に古いPeerConnectionをcleanup（`destroy()`→`peers={}`→`remote-wrapper削除`）してから`join-room`再送。 |
| 6 | `public/index.html` | マイク切替（`#mic-select` change）を通話中の送信ストリームに反映。`replaceTrack()`で全Peerの音声トラックを差し替え。 |

---

## 現在の状態（2026-04-16時点）

- P1（収録事故直結バグ）: **すべて修正済み**
- P2（品質・安定性）: **すべて修正済み**
- P3（UX改善）: **すべて修正済み**
- P4（技術的負債）: **未対応（収録運用には影響なし）**

---

## 残タスク（P4・技術的負債のみ）

### ① Docker/VPS二重管理の解消
- `/root/apps/surecast` と `/app`（コンテナ内）を手動同期している
- 修正漏れリスクあり
- 改善案: Dockerfileでビルド時にソースを組み込む、またはボリュームマウントに変更

### ② `RecordingCore`クラスの未使用コード整理
- `public/js/core/recording-core.js` がimportされておらず、録音ロジックはすべて`index.html`に直書き
- 削除するか、実際に使う形にリファクタリング

### ③ `ws.localStream`と`MediaCore.localStream`の二重管理
- `joinCall()`と`leaveCall()`では同期されているが、将来の修正時に片方だけ更新する事故が起きやすい
- `ws.localStream`を廃止して`window.__mediaCore`に一本化推奨

---

## 重要ファイル
- `public/js/core/call-core.js` — WebRTC PeerConnection管理（修正済み）
- `public/js/core/media-core.js` — ローカルストリーム管理
- `public/js/core/recording-core.js` — 未使用
- `public/index.html` — メインアプリ（シグナリング・録音・UI）
- `server.js` — Socket.ioシグナリング・サーバー録音・エピソード管理

---

## Codexへの作業指示

### 基本ルール
- **1タスク1ファイル・1機能** で指示すること
- 変更後は必ず以下を実行して確認を返すこと:
```bash
  # 構文チェック（</script>より前の行番号を使うこと）
  sed -n '720,$(grep -n "</script>" public/index.html | tail -1 | cut -d: -f1 | xargs -I{} expr {} - 1)p' public/index.html > /tmp/check.js
  node --check /tmp/check.js && echo "syntax-ok"

  # ハッシュ確認
  sha256sum /root/apps/surecast/public/index.html
  docker exec 0a5ddd4ed58a sha256sum /app/public/index.html
```
- **大規模リファクタは禁止**。既存動作を壊す可能性のある変更は提案のみとする
- `call-core.js`は今回大幅修正済み。触る場合は必ずClaude確認を挟む

### 次にやること（P4）
上記「残タスク①〜③」を小さく切り分けて1つずつ対応する。
優先度: ① > ③ > ②

---

## 動作確認済み事項（2026-04-16）
- 本番URL 200 OK
- Docker container 稼働中
- VPS↔コンテナのSHA256一致確認済み
- 構文チェック通過済み
