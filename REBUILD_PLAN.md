# SureCast 通話・録音エンジン再設計メモ

## 目的
現在の SureCast は UI / 台本同期 / WebRTC / 録音 が密結合しており、
不具合時の切り分けが難しい。通話・録音エンジンを再設計し、
3〜4名のPodcast収録用途に特化した安定構成へ寄せる。

## 前提条件
- ブラウザアプリのまま継続
- 参加人数上限: 4名
- 優先順位:
  1. 通話がつながる
  2. 録音が安定する
  3. UI/付加機能
- クラウド録音・映像品質は低くてよい
- ローカル録音は podcast に耐える品質を維持

## 残すもの
- 既存UIデザインの方向性
- 台本共有（episodes）
- ルームID運用
- サーバー録音の思想
- 一斉録音ボタンの考え方

## 作り直すもの
- WebRTC peer 管理
- join / leave / rejoin フロー
- offer / answer / ICE の責務分離
- local preview と remote playback の扱い
- 録音開始/停止シーケンス

## 新構成案
### 1. call-core
責務:
- ルーム参加
- 参加者一覧同期
- PeerConnection生成/破棄
- offer/answer/ICE中継
- 接続状態管理

### 2. media-core
責務:
- getUserMedia
- local preview
- 送信トラック設定
- remote stream 再生

### 3. recording-core
責務:
- ローカル録音開始/停止
- サーバー録音開始/停止
- 一斉録音コマンド処理
- 録音状態表示

### 4. ui-layer
責務:
- ボタン
- ステータス表示
- 台本UI
- 参加人数表示

## 設計方針
### 通話
- 4名上限
- 参加時点で現在の参加者数をチェック
- 5人目は join 拒否
- まず local media 取得成功後にのみ join-room を送る
- remote stream は `ontrack` でのみ描画
- autoplay 失敗時は明示的に `play()` を再試行

### 接続管理
- initiator は socket id の順序で固定
- peer 1組ごとに状態を持つ
- `new -> signaling -> connecting -> connected -> failed`
- failed/disconnected のときだけ限定的に ICE restart
- 再生成ループは避ける

### 録音
- 通話成功と録音成功を分離して扱う
- ローカル録音は別 getUserMedia ではなく、必要なら取得戦略を再検討
- 一斉録音ボタンは call-core ではなく recording-core が責務を持つ

### 品質
- 通話: 低品質固定
  - video: 320x180 / 8fps / 低bitrate
  - audio: 低bitrate
- ローカル録音: 高品質維持

## 実装順序
1. 現行コードから call-core 候補を抽出
2. local preview を最小実装で安定化
3. 1対1通話を安定化
4. 3人通話
5. 4人上限処理
6. recording-core 再接続
7. UI再結合

## 直近の作業
- まず通話部を別モジュール化する
- 「local preview が見える」「remote audio/video が見える」を最小条件にして再構築
- 既存機能をいきなり全部戻さない

## 判断
今はパッチ積み増しより再設計のほうが妥当。
