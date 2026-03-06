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
  maxHttpBufferSize: 100 * 1024 * 1024 // 100MB
});

const PORT = process.env.PORT || 3000;

// 録音ファイル保存先
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

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

// multer 設定（WebM一時保存用 → /tmp に保存してFFmpegで変換）
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
      reject(new Error(`FFmpeg起動エラー: ${err.message}。FFmpegがインストールされているか確認してください。`));
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
    console.log(`[FLAC変換完了] ${outputFilename} (${(stat.size / 1024).toFixed(1)} KB)`);
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
// ===== サーバー側録音管理 =====
// socketId -> { writeStream, tempPath, username, dateStr, timeStr }
// =========================================================
const serverRecordings = new Map();

async function finalizeServerRecording(socketId) {
  const rec = serverRecordings.get(socketId);
  serverRecordings.delete(socketId);
  if (!rec) return;

  // writeStreamを確実に閉じる
  await new Promise(resolve => {
    if (rec.writeStream && !rec.writeStream.destroyed) {
      rec.writeStream.end(resolve);
    } else {
      resolve();
    }
  });

  const { tempPath, username, dateStr, timeStr } = rec;

  if (!fs.existsSync(tempPath)) return;
  const inputStat = fs.statSync(tempPath);
  if (inputStat.size === 0) {
    try { fs.unlinkSync(tempPath); } catch {}
    return;
  }

  const outputFilename = `surecast-${username}-${dateStr}-${timeStr}.flac`;
  const outputPath = path.join(uploadsDir, outputFilename);

  try {
    await convertToFlac(tempPath, outputPath);
    const outStat = fs.statSync(outputPath);
    console.log(`[サーバー録音保存] ${outputFilename} (${(outStat.size / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.error(`[サーバー録音変換エラー] ${socketId}:`, err.message);
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

// =========================================================
// ===== WebRTC シグナリング =====
// =========================================================
const rooms = new Map();        // roomId -> Set<socketId>
const roomEpisodes = new Map(); // roomId -> { list, activeId }
const roomUsernames = new Map(); // roomId -> Map<socketId, username>

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function getEpisodes(roomId) {
  if (!roomEpisodes.has(roomId)) {
    const ep = { id: genId(), name: 'EP1', content: '' };
    roomEpisodes.set(roomId, { list: [ep], activeId: ep.id });
  }
  return roomEpisodes.get(roomId);
}

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  // サーバー側録音を終了・保存
  finalizeServerRecording(socket.id).catch(e =>
    console.error('[録音終了エラー]', e.message)
  );

  const room = rooms.get(roomId);
  if (room) {
    room.delete(socket.id);
    if (room.size === 0) {
      rooms.delete(roomId);
      roomEpisodes.delete(roomId);
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

    // 既存参加者のリスト（ユーザー名付き）
    const existingPeers = [...room].map(id => ({
      peerId: id,
      username: usernameMap.get(id) || 'user',
    }));
    socket.emit('room-peers', existingPeers);

    // 自分の情報を登録
    usernameMap.set(socket.id, username);
    socket.to(roomId).emit('peer-joined', { peerId: socket.id, username });

    room.add(socket.id);
    socket.data.roomId = roomId;
    console.log(`[参加] room=${roomId} user=${username} 人数=${room.size}`);

    // エピソードを新規参加者へ送信
    // hasOtherParticipants: 既存参加者がいたかどうか（クライアントがEP選択判断に使用）
    const eps = getEpisodes(roomId);
    const hasOtherParticipants = existingPeers.length > 0;
    socket.emit('episodes-sync', { ...eps, hasOtherParticipants });

    // 既存参加者がいた場合のみ、現在選択中のEPを room-state で通知
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
  });

  socket.on('script-typing', (isTyping) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof isTyping !== 'boolean') return;
    socket.to(roomId).emit('peer-typing', { peerId: socket.id, isTyping });
  });

  // =========================================================
  // ===== サーバー側録音（Craig方式） =====
  // =========================================================

  // 録音開始
  socket.on('start-server-recording', (data) => {
    const username = safeUsername(
      (data && data.username) || socket.data.username || 'user'
    );
    const { dateStr, timeStr } = getTimestampParts();
    const tempPath = path.join(os.tmpdir(), `surecast-srv-${socket.id}.webm`);

    try {
      const writeStream = fs.createWriteStream(tempPath);
      serverRecordings.set(socket.id, {
        writeStream,
        tempPath,
        username,
        dateStr,
        timeStr,
      });
      console.log(`[サーバー録音開始] user=${username} socket=${socket.id}`);
    } catch (err) {
      console.error('[サーバー録音開始エラー]', err.message);
    }
  });

  // 音声チャンク受信（バイナリ）
  socket.on('audio-stream-chunk', (data) => {
    const rec = serverRecordings.get(socket.id);
    if (!rec || !rec.writeStream || rec.writeStream.destroyed) return;
    try {
      rec.writeStream.write(Buffer.from(data));
    } catch (err) {
      console.error('[チャンク書き込みエラー]', err.message);
    }
  });

  // 録音停止・保存
  socket.on('stop-server-recording', () => {
    finalizeServerRecording(socket.id).catch(e =>
      console.error('[録音停止エラー]', e.message)
    );
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
  console.log(`   録音保存先: ${uploadsDir}\n`);
});
