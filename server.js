const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 100 * 1024 * 1024, // 100MB
  pingTimeout: 120000,  // 2分でタイムアウト（低品質回線対応）
  pingInterval: 30000,  // 30秒ごとにping
  connectTimeout: 60000, // 接続タイムアウト1分
});

const PORT = process.env.PORT || 3000;

// 録音ファイル保存先
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// エピソード永続化保存先
const episodesDir = path.join(__dirname, 'episodes');
if (!fs.existsSync(episodesDir)) fs.mkdirSync(episodesDir, { recursive: true });

// ユーティリティ
function pad(n) { return String(n).padStart(2, '0'); }

function safeUsername(name) {
  return String(name || 'user').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 20) || 'user';
}

function getTimestampParts() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return { dateStr, timeStr };
}

// multer 設定（WebM一時保存用）
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) => {
    cb(null, `surecast-upload-${Date.now()}.webm`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

// 静的ファイル配信
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ===== FFmpeg変換ユーティリティ =====
function convertToFlac(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', inputPath,
      '-c:a', 'flac',
      '-compression_level', '5',
      '-y',
      outputPath
    ]);
    let stderr = '';
    ffmpeg.stderr.on('data', d => { stderr += d.toString(); });
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg失敗 (code ${code}): ${stderr.slice(-300)}`));
    });
    ffmpeg.on('error', (err) => {
      reject(new Error(`FFmpeg起動エラー: ${err.message}`));
    });
  });
}

// ===== ローカル録音をFLACに変換・保存 =====
app.post('/convert-to-flac', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'ファイルがありません' });
  }
  const username = safeUsername(req.body && req.body.username);
  const { dateStr, timeStr } = getTimestampParts();
  const outputFilename = `surecast-${username}-${dateStr}-${timeStr}-local.flac`;
  const outputPath = path.join(uploadsDir, outputFilename);
  const inputPath = req.file.path;

  try {
    await convertToFlac(inputPath, outputPath);
    const stat = fs.statSync(outputPath);
    console.log(`[FLAC変換完了] ${outputFilename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    res.json({ success: true, filename: outputFilename, size: stat.size });
  } catch (err) {
    console.error('[FLAC変換エラー]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
  }
});

// ===== 保存済み録音一覧 =====
app.get('/recordings', (req, res) => {
  try {
    const files = fs.readdirSync(uploadsDir)
      .filter(f => /\.(webm|wav|mp4|ogg|flac)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(uploadsDir, f));
        return { name: f, size: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 録音ファイルダウンロード =====
app.get('/recordings/:filename', (req, res) => {
  const filePath = path.join(uploadsDir, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'ファイルが見つかりません' });
  }
  res.download(filePath);
});

// =========================================================
// ===== エピソード永続化 =====
// =========================================================
const episodeSaveTimers = new Map(); // roomId -> timer

function getEpisodesFilePath(roomId) {
  return path.join(episodesDir, `${roomId}.json`);
}

function loadEpisodesFromDisk(roomId) {
  const filePath = getEpisodesFilePath(roomId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function scheduleEpisodeSave(roomId) {
  if (episodeSaveTimers.has(roomId)) clearTimeout(episodeSaveTimers.get(roomId));
  const timer = setTimeout(() => {
    episodeSaveTimers.delete(roomId);
    const eps = roomEpisodes.get(roomId);
    if (eps) {
      try {
        fs.writeFileSync(getEpisodesFilePath(roomId), JSON.stringify(eps), 'utf8');
        console.log(`[エピソード保存] room=${roomId}`);
      } catch (err) {
        console.error('[エピソード保存エラー]', err.message);
      }
    }
  }, 2000);
  episodeSaveTimers.set(roomId, timer);
}

// エピソード取得API（台本共有・インポート用）
app.get('/api/episodes/:roomId', (req, res) => {
  const roomId = req.params.roomId.trim().toUpperCase().slice(0, 12);
  if (!roomId) return res.status(400).json({ error: 'roomIdが必要です' });
  const inMemory = roomEpisodes.get(roomId);
  if (inMemory) return res.json(inMemory);
  const fromDisk = loadEpisodesFromDisk(roomId);
  if (fromDisk) return res.json(fromDisk);
  res.status(404).json({ error: 'エピソードが見つかりません' });
});

// =========================================================
// ===== サーバー側録音管理（username:roomId キーで再接続対応）=====
// =========================================================

// key: `${roomId}:${username}` -> { writeStream, tempPath, username, roomId, dateStr, timeStr, currentSocketId }
const serverRecordings = new Map();

// key: `${roomId}:${username}` -> timer（切断後グレース期間タイマー）
const finalizationTimers = new Map();

const FINALIZATION_GRACE_MS = 180000; // 180秒（3分）グレース期間（低品質回線対応）

async function finalizeServerRecording(rec) {
  if (!rec) return;

  // writeStreamを確実に閉じる
  await new Promise(resolve => {
    if (rec.writeStream && !rec.writeStream.destroyed) {
      rec.writeStream.end(resolve);
    } else {
      resolve();
    }
  });

  const { tempPath, username, dateStr, timeStr, roomId, currentSocketId } = rec;

  if (!fs.existsSync(tempPath)) return;
  const inputStat = fs.statSync(tempPath);
  const MIN_VALID_SIZE = 50 * 1024; // 50KB未満は音声データなし（EBMLヘッダーのみ）
  if (inputStat.size < MIN_VALID_SIZE) {
    console.log(`[サーバー録音スキップ] ${path.basename(tempPath)} サイズ不足 (${inputStat.size} bytes) → 破棄`);
    try { fs.unlinkSync(tempPath); } catch {}
    return;
  }

  const outputFilename = `surecast-${username}-${dateStr}-${timeStr}.flac`;
  const outputPath = path.join(uploadsDir, outputFilename);

  try {
    await convertToFlac(tempPath, outputPath);
    const outStat = fs.statSync(outputPath);
    console.log(`[サーバー録音保存] ${outputFilename} (${(outStat.size / 1024 / 1024).toFixed(1)} MB)`);
    // 録音完了をクライアントに通知
    if (currentSocketId) {
      io.to(currentSocketId).emit('server-recording-saved', {
        filename: outputFilename,
        size: outStat.size,
      });
    }
  } catch (err) {
    console.error(`[サーバー録音変換エラー] ${username}:`, err.message);
    // 変換失敗時はWebMとして保存（フォールバック）
    try {
      const fallbackFilename = `surecast-${username}-${dateStr}-${timeStr}-raw.webm`;
      const fallbackPath = path.join(uploadsDir, fallbackFilename);
      fs.copyFileSync(tempPath, fallbackPath);
      console.log(`[サーバー録音フォールバック保存] ${fallbackFilename}`);
      if (currentSocketId) {
        io.to(currentSocketId).emit('server-recording-saved', {
          filename: fallbackFilename,
          size: fs.statSync(fallbackPath).size,
          fallback: true,
        });
      }
    } catch {}
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function scheduleFinalization(recKey) {
  // 既存タイマーをキャンセル
  if (finalizationTimers.has(recKey)) {
    clearTimeout(finalizationTimers.get(recKey));
  }

  const timer = setTimeout(async () => {
    finalizationTimers.delete(recKey);
    const rec = serverRecordings.get(recKey);
    if (rec) {
      serverRecordings.delete(recKey);
      console.log(`[サーバー録音グレース期間終了] key=${recKey} → FLAC変換開始`);
      await finalizeServerRecording(rec).catch(e =>
        console.error('[録音終了エラー]', e.message)
      );
    }
  }, FINALIZATION_GRACE_MS);

  finalizationTimers.set(recKey, timer);
  console.log(`[サーバー録音] ${recKey} → ${FINALIZATION_GRACE_MS/1000}秒後に保存（再接続待機中）`);
}

// =========================================================
// ===== WebRTC シグナリング =====
// =========================================================
const rooms = new Map();         // roomId -> Set<socketId>
const roomEpisodes = new Map();  // roomId -> { list, activeId }
const roomUsernames = new Map(); // roomId -> Map<socketId, username>

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function getEpisodes(roomId) {
  if (!roomEpisodes.has(roomId)) {
    // ディスクから復元を試みる
    const saved = loadEpisodesFromDisk(roomId);
    if (saved) {
      roomEpisodes.set(roomId, saved);
      console.log(`[エピソード復元] room=${roomId}`);
    } else {
      const ep = { id: genId(), name: 'EP1', content: '' };
      roomEpisodes.set(roomId, { list: [ep], activeId: ep.id });
    }
  }
  return roomEpisodes.get(roomId);
}

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  // サーバー録音：グレース期間付きで最終化をスケジュール
  const recKey = socket.data.recKey;
  if (recKey) {
    const rec = serverRecordings.get(recKey);
    if (rec && rec.currentSocketId === socket.id) {
      scheduleFinalization(recKey);
    }
    socket.data.recKey = null;
  }

  const room = rooms.get(roomId);
  if (room) {
    room.delete(socket.id);
    if (room.size === 0) {
      rooms.delete(roomId);
      roomEpisodes.delete(roomId); // メモリ解放（ディスクには保存済み）
    }
  }

  const usernameMap = roomUsernames.get(roomId);
  if (usernameMap) {
    usernameMap.delete(socket.id);
    if (usernameMap.size === 0) roomUsernames.delete(roomId);
  }

  socket.to(roomId).emit('peer-left', socket.id);
  socket.leave(roomId);
  socket.data.roomId = null;
  console.log(`[退出] room=${roomId} user=${socket.data.username || '?'} socket=${socket.id}`);
}

io.on('connection', (socket) => {
  console.log(`[接続] ${socket.id}`);

  // ===== ルーム参加 =====
  socket.on('join-room', (data) => {
    let roomId, username;

    if (typeof data === 'string') {
      roomId = data;
      username = 'user';
    } else if (data && typeof data === 'object') {
      roomId = String(data.roomId || '');
      username = safeUsername(data.username);
    } else {
      return;
    }

    if (!roomId) return;
    roomId = roomId.trim().toUpperCase().slice(0, 12);
    if (!roomId) return;

    socket.data.username = username;
    if (socket.data.roomId) leaveRoom(socket);

    socket.join(roomId);
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const room = rooms.get(roomId);

    if (!roomUsernames.has(roomId)) roomUsernames.set(roomId, new Map());
    const usernameMap = roomUsernames.get(roomId);

    // 既存参加者のリスト
    const existingPeers = [...room].map(id => ({
      peerId: id,
      username: usernameMap.get(id) || 'user',
    }));
    socket.emit('room-peers', existingPeers);

    usernameMap.set(socket.id, username);
    socket.to(roomId).emit('peer-joined', { peerId: socket.id, username });

    room.add(socket.id);
    socket.data.roomId = roomId;
    console.log(`[参加] room=${roomId} user=${username} 人数=${room.size}`);

    const eps = getEpisodes(roomId);
    const hasOtherParticipants = existingPeers.length > 0;
    socket.emit('episodes-sync', { ...eps, hasOtherParticipants });

    if (hasOtherParticipants) {
      socket.emit('room-state', { currentEpisodeId: eps.activeId });
    }
  });

  // ===== WebRTC シグナリング中継 =====
  socket.on('offer', ({ to, offer }) => {
    if (to && offer) io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    if (to && answer) io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    if (to && candidate) io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // ===== エピソード管理 =====
  socket.on('episode-create', ({ name }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const eps = getEpisodes(roomId);
    const ep = { id: genId(), name: String(name || 'EP').slice(0, 30), content: '' };
    eps.list.push(ep);
    eps.activeId = ep.id;
    io.to(roomId).emit('episodes-sync', eps);
    scheduleEpisodeSave(roomId);
  });

  socket.on('episode-select', ({ id }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const eps = getEpisodes(roomId);
    if (eps.list.some(e => e.id === id)) {
      eps.activeId = id;
      io.to(roomId).emit('episodes-sync', eps);
    }
  });

  socket.on('episode-update', ({ id, content }) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof content !== 'string' || content.length > 100000) return;
    const eps = getEpisodes(roomId);
    const ep = eps.list.find(e => e.id === id);
    if (ep) {
      ep.content = content;
      socket.to(roomId).emit('episode-updated', { id, content });
      scheduleEpisodeSave(roomId);
    }
  });

  socket.on('episode-rename', ({ id, name }) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof name !== 'string') return;
    const eps = getEpisodes(roomId);
    const ep = eps.list.find(e => e.id === id);
    if (ep) {
      ep.name = String(name).slice(0, 30) || 'EP';
      io.to(roomId).emit('episodes-sync', eps);
      scheduleEpisodeSave(roomId);
    }
  });

  socket.on('episode-delete', ({ id }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const eps = getEpisodes(roomId);
    if (eps.list.length <= 1) return;
    eps.list = eps.list.filter(e => e.id !== id);
    if (eps.activeId === id) eps.activeId = eps.list[0].id;
    io.to(roomId).emit('episodes-sync', eps);
    scheduleEpisodeSave(roomId);
  });

  socket.on('script-typing', (isTyping) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof isTyping !== 'boolean') return;
    socket.to(roomId).emit('peer-typing', { peerId: socket.id, isTyping });
  });

  // =========================================================
  // ===== サーバー側録音（username:roomId キーで再接続対応）=====
  // =========================================================

  // 録音開始
  socket.on('start-server-recording', (data) => {
    const username = safeUsername(
      (data && data.username) || socket.data.username || 'user'
    );
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const recKey = `${roomId}:${username}`;
    socket.data.recKey = recKey;

    // グレース期間中のタイマーをキャンセル（再接続）
    if (finalizationTimers.has(recKey)) {
      clearTimeout(finalizationTimers.get(recKey));
      finalizationTimers.delete(recKey);
      console.log(`[サーバー録音再開] key=${recKey} (再接続による継続)`);
    }

    // 既存録音がある場合はソケットを更新して継続
    if (serverRecordings.has(recKey)) {
      const rec = serverRecordings.get(recKey);
      if (rec.writeStream && !rec.writeStream.destroyed) {
        rec.currentSocketId = socket.id;
        console.log(`[サーバー録音継続] key=${recKey} newSocket=${socket.id}`);
        return;
      }
      // writeStreamが壊れている場合は新規作成
      serverRecordings.delete(recKey);
    }

    // 新規録音開始
    const { dateStr, timeStr } = getTimestampParts();
    const safeKey = recKey.replace(/[^a-zA-Z0-9]/g, '_');
    const tempPath = path.join(os.tmpdir(), `surecast-srv-${safeKey}-${Date.now()}.webm`);

    try {
      const writeStream = fs.createWriteStream(tempPath);
      writeStream.on('error', (err) => {
        console.error(`[WriteStream エラー] key=${recKey}:`, err.message);
      });
      serverRecordings.set(recKey, {
        writeStream,
        tempPath,
        username,
        roomId,
        dateStr,
        timeStr,
        currentSocketId: socket.id,
      });
      console.log(`[サーバー録音開始] key=${recKey} file=${path.basename(tempPath)}`);
    } catch (err) {
      console.error('[サーバー録音開始エラー]', err.message);
    }
  });

  // 音声チャンク受信（バイナリ）
  socket.on('audio-stream-chunk', (data) => {
    const recKey = socket.data.recKey;
    if (!recKey) return;
    const rec = serverRecordings.get(recKey);
    if (!rec) return;
    // アクティブなソケットからのデータのみ受け入れ
    if (rec.currentSocketId !== socket.id) return;
    if (!rec.writeStream || rec.writeStream.destroyed) return;
    try {
      rec.writeStream.write(Buffer.from(data));
    } catch (err) {
      console.error('[チャンク書き込みエラー]', err.message);
    }
  });

  // 録音停止・即時保存
  socket.on('stop-server-recording', () => {
    const recKey = socket.data.recKey;
    if (!recKey) return;
    socket.data.recKey = null;

    // グレースタイマーをキャンセル
    if (finalizationTimers.has(recKey)) {
      clearTimeout(finalizationTimers.get(recKey));
      finalizationTimers.delete(recKey);
    }

    const rec = serverRecordings.get(recKey);
    if (rec) {
      serverRecordings.delete(recKey);
      console.log(`[サーバー録音停止] key=${recKey} → 即時FLAC変換`);
      finalizeServerRecording(rec).catch(e =>
        console.error('[録音停止エラー]', e.message)
      );
    }
  });

  // ===== 退出・切断 =====
  socket.on('leave-room', () => leaveRoom(socket));

  socket.on('disconnect', () => {
    leaveRoom(socket);
    console.log(`[切断] ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`\n🎙️  SureCast サーバー起動`);
  console.log(`   URL: http://localhost:${PORT}`);
  console.log(`   録音保存先: ${uploadsDir}`);
  console.log(`   エピソード保存先: ${episodesDir}\n`);
});
