# SureCast Rebuild Progress

## Phase 0
- 再設計方針書を作成済み
- 4名上限 / 通話優先 / 録音分離方針を決定

## Phase 1
- `public/js/core/call-core.js` を作成
- `public/js/core/media-core.js` を作成
- `public/js/core/recording-core.js` を作成

## Status
まだ既存UIへ統合はしていない。
現時点では「新アーキテクチャの土台を分離して作り始めた」段階。
次は既存 `public/index.html` から通話・メディア処理を段階的にこの core 群へ移す。

## 2026-04-13
- `CallCore` を既存 Socket.io 接続へ接続し、二重 socket 接続を避けるよう修正
- `MediaCore` が join 時に取得した local stream を保持し、preview 用に別 stream を取り直さないよう修正
- `CallCore` に late ICE candidate queue / peer-left cleanup / room-full callback を追加
- `leaveCall()` で CallCore と MediaCore の local stream 参照を破棄
- サーバー側で4人上限を追加
- `/root/apps/surecast` と実稼働 Docker container `/app` の両方へ反映
- 構文確認: `call-core.js`, `media-core.js`, `server.js`, `index.html` script body OK
