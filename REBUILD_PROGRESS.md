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
