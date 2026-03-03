const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

// multer 設定
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `recording_${ts}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

// 静的ファイル配信
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 録音ファイルアップロード
app.post('/upload', upload.single('audio'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'ファイルがありません' });
  }
  console.log(`[録音保存] ${req.file.filename} (${(req.file.size / 1024).toFixed(1)} KB)`);
  res.json({ success: true, filename: req.file.filename, size: req.file.size });
});

// 保存済み録音一覧
app.get('/recordings', (req, res) => {
  const files = fs.readdirSync(uploadsDir)
    .filter(f => /\.(webm|wav|mp4|ogg)$/i.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(uploadsDir, f));
      return { name: f, size: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  res.json(files);
});

// 録音ファイルダウンロード
app.get('/recordings/:filename', (req, res) => {
  const filePath = path.join(uploadsDir, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'ファイルが見つかりません' });
  }
  res.download(filePath);
});

// ===== WebRTC シグナリング =====
// roomId -> Set<socketId>
const rooms = new Map();

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (room) {
    room.delete(socket.id);
    if (room.size === 0) rooms.delete(roomId);
  }

  socket.to(roomId).emit('peer-left', socket.id);
  socket.leave(roomId);
  socket.data.roomId = null;
  console.log(`[退出] room=${roomId} socket=${socket.id}`);
}

io.on('connection', (socket) => {
  console.log(`[接続] ${socket.id}`);

  // ルーム参加
  socket.on('join-room', (roomId) => {
    if (!roomId || typeof roomId !== 'string') return;
    roomId = roomId.trim().toUpperCase().slice(0, 12);

    // 既存ルームから退出
    if (socket.data.roomId) leaveRoom(socket);

    socket.join(roomId);
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const room = rooms.get(roomId);

    // 既存参加者リストを新規参加者へ送信
    const existingPeers = [...room];
    socket.emit('room-peers', existingPeers);

    // 既存参加者へ新規参加を通知
    socket.to(roomId).emit('peer-joined', socket.id);

    room.add(socket.id);
    socket.data.roomId = roomId;
    console.log(`[参加] room=${roomId} 人数=${room.size}`);
  });

  // WebRTC シグナリング中継
  socket.on('offer', ({ to, offer }) => {
    if (to && offer) io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    if (to && answer) io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    if (to && candidate) io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('leave-room', () => leaveRoom(socket));

  socket.on('disconnect', () => {
    leaveRoom(socket);
    console.log(`[切断] ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`\n🎙️📹  ポッドキャスト収録・ビデオ通話アプリ`);
  console.log(`   URL: http://localhost:${PORT}`);
  console.log(`   録音保存先: ${uploadsDir}\n`);
});
