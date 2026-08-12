// 未処理例外・Promise拒否でプロセスが落ちないようにする（1つのエラーで全員のセッションを巻き込まない）
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] プロセス継続:', (err && err.stack) || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] プロセス継続:', reason);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const { classifyDiskSpace } = require('./lib/disk-space');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 100 * 1024 * 1024, // 100MB
  pingTimeout: 300000,  // 5分でタイムアウト（ping 1500ms超の低回線対応）
  pingInterval: 60000,  // 60秒ごとにping（低回線でのタイムアウト誤検知防止）
  connectTimeout: 120000, // 接続タイムアウト2分
  // シグナリングメッセージ（テキストフレーム）をzlibで圧縮
  // 音声バイナリデータは既圧縮のためtransports側で除外される
  perMessageDeflate: {
    zlibDeflateOptions: { level: 1 }, // 最軽量圧縮（CPU負荷最小）
    threshold: 2048, // 2KB以上のフレームのみ圧縮
  },
});

const PORT = process.env.PORT || 3000;

// 録音ファイル保存先
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

function getDiskSpaceStatus() {
  try {
    const stat = fs.statfsSync(uploadsDir);
    return classifyDiskSpace(Number(stat.bavail) * Number(stat.bsize));
  } catch (err) {
    console.error('[ディスク容量取得エラー]', err.message);
    return classifyDiskSpace(NaN);
  }
}

// ===== 録音ファイルの保管期限（14日）: 期限切れを定期削除 =====
const RECORDING_RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // 14日
function cleanupOldRecordings() {
  try {
    const now = Date.now();
    let removed = 0;
    for (const f of fs.readdirSync(uploadsDir)) {
      const fp = path.join(uploadsDir, f);
      try {
        const st = fs.statSync(fp);
        if (st.isFile() && (now - st.mtimeMs) > RECORDING_RETENTION_MS) {
          fs.unlinkSync(fp);
          removed++;
          console.log(`[保管期限切れ削除] ${f}`);
        }
      } catch {}
    }
    if (removed > 0) console.log(`[録音クリーンアップ] ${removed}件を削除（14日超）`);
  } catch (e) {
    console.error('[録音クリーンアップエラー]', e.message);
  }
}
cleanupOldRecordings();                                   // 起動時に1回
setInterval(cleanupOldRecordings, 24 * 60 * 60 * 1000);   // 以降1日ごと

// エピソード永続化保存先
const episodesDir = path.join(__dirname, 'episodes');
if (!fs.existsSync(episodesDir)) fs.mkdirSync(episodesDir, { recursive: true });

// ユーティリティ
function pad(n) { return String(n).padStart(2, '0'); }

const KANA_ROMAJI = {
  'ア':'a','イ':'i','ウ':'u','エ':'e','オ':'o',
  'カ':'ka','キ':'ki','ク':'ku','ケ':'ke','コ':'ko',
  'サ':'sa','シ':'shi','ス':'su','セ':'se','ソ':'so',
  'タ':'ta','チ':'chi','ツ':'tsu','テ':'te','ト':'to',
  'ナ':'na','ニ':'ni','ヌ':'nu','ネ':'ne','ノ':'no',
  'ハ':'ha','ヒ':'hi','フ':'fu','ヘ':'he','ホ':'ho',
  'マ':'ma','ミ':'mi','ム':'mu','メ':'me','モ':'mo',
  'ヤ':'ya','ユ':'yu','ヨ':'yo',
  'ラ':'ra','リ':'ri','ル':'ru','レ':'re','ロ':'ro',
  'ワ':'wa','ヲ':'o','ン':'n',
  'ガ':'ga','ギ':'gi','グ':'gu','ゲ':'ge','ゴ':'go',
  'ザ':'za','ジ':'ji','ズ':'zu','ゼ':'ze','ゾ':'zo',
  'ダ':'da','ヂ':'ji','ヅ':'zu','デ':'de','ド':'do',
  'バ':'ba','ビ':'bi','ブ':'bu','ベ':'be','ボ':'bo',
  'パ':'pa','ピ':'pi','プ':'pu','ペ':'pe','ポ':'po',
  'ヴ':'vu',
  'キャ':'kya','キュ':'kyu','キョ':'kyo',
  'シャ':'sha','シュ':'shu','ショ':'sho',
  'チャ':'cha','チュ':'chu','チョ':'cho',
  'ニャ':'nya','ニュ':'nyu','ニョ':'nyo',
  'ヒャ':'hya','ヒュ':'hyu','ヒョ':'hyo',
  'ミャ':'mya','ミュ':'myu','ミョ':'myo',
  'リャ':'rya','リュ':'ryu','リョ':'ryo',
  'ギャ':'gya','ギュ':'gyu','ギョ':'gyo',
  'ジャ':'ja','ジュ':'ju','ジョ':'jo',
  'ビャ':'bya','ビュ':'byu','ビョ':'byo',
  'ピャ':'pya','ピュ':'pyu','ピョ':'pyo',
  'ファ':'fa','フィ':'fi','フェ':'fe','フォ':'fo',
  'ティ':'ti','ディ':'di','チェ':'che','シェ':'she','ジェ':'je',
  'ウィ':'wi','ウェ':'we','ウォ':'wo','ヴァ':'va','ヴィ':'vi','ヴェ':'ve','ヴォ':'vo',
};

function toKatakana(value) {
  return [...value].map(char => {
    const code = char.charCodeAt(0);
    return code >= 0x3041 && code <= 0x3096 ? String.fromCharCode(code + 0x60) : char;
  }).join('');
}

function romanizeKana(value) {
  const kana = toKatakana(String(value || '').normalize('NFKC'));
  let result = '';
  let geminate = false;
  for (let i = 0; i < kana.length; i++) {
    const char = kana[i];
    if (char === 'ッ') {
      geminate = true;
      continue;
    }
    if (char === 'ー') {
      const vowel = result.match(/[aeiou]$/);
      if (vowel) result += vowel[0];
      continue;
    }
    const pair = kana.slice(i, i + 2);
    let romaji = KANA_ROMAJI[pair];
    if (romaji) i++;
    else romaji = KANA_ROMAJI[char];
    if (!romaji) {
      result += char;
      geminate = false;
      continue;
    }
    if (geminate && /^[bcdfghjklmnpqrstvwxyz]/.test(romaji)) result += romaji[0];
    result += romaji;
    geminate = false;
  }
  return result;
}

function normalizeUsername(name) {
  const original = String(name || '').normalize('NFKC').trim();
  if (!original) throw new Error('表示名を入力してください');
  if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(original)) {
    throw new Error('漢字は自動変換できません。ひらがな、カタカナ、または半角英数字で入力してください');
  }
  const romanized = romanizeKana(original).toLowerCase();
  const username = romanized.replace(/[^a-z0-9_-]/g, '').slice(0, 20);
  if (!username) throw new Error('表示名はひらがな、カタカナ、または半角英数字で入力してください');
  return { username, original, transliterated: username !== original.toLowerCase() };
}

function assignUniqueUsername(base, usernameMap) {
  const used = new Set([...usernameMap.values()].map(value => String(value).toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1000; index++) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 20 - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error('同じ表示名の参加者が多すぎます');
}

function safeUsername(name) {
  try {
    return normalizeUsername(name).username;
  } catch {
    return 'user';
  }
}

function getTimestampParts() {
  // 日本時間（UTC+9）で命名（コンテナのTZに依存しない）
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const dateStr = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}`;
  const timeStr = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
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
  // 4時間の48kHz/16bit/モノラルWAV（約1.4GB）を受け入れる。
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

// 静的ファイル配信
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ===== TURN credentials エンドポイント =====
const crypto = require('crypto');
app.get('/api/turn-credentials', (req, res) => {
  const secret = process.env.TURN_SECRET;
  if (!secret) return res.json({ iceServers: [] });
  const ttl = 86400; // 24時間
  const username = `${Math.floor(Date.now() / 1000) + ttl}:surecast`;
  const hmac = crypto.createHmac('sha1', secret).update(username).digest('base64');
  res.json({
    iceServers: [
      { urls: 'stun:162.43.22.84:3478' },
      {
        urls: [
          'turn:162.43.22.84:3478?transport=udp',
          'turn:162.43.22.84:3478?transport=tcp',
          'turns:surecast.virtualeigabar.com:5349?transport=tcp',
        ],
        username,
        credential: hmac,
      }
    ]
  });
});

// ===== FFmpeg変換ユーティリティ =====
function convertToFlac(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', inputPath,
      '-c:a', 'flac',
      '-ac', '1',
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

// ===== 一斉録音のミックス音源を自動生成 =====
// 目的: 編集と並行して文字起こし・ファクトチェックを行うための「通し音源」を作る。
// 各トラックの開始時刻差を adelay で埋めて時間軸を揃えてから1本にまとめる。
const mixTimers = new Map();      // syncId -> デバウンス用タイマー
const mixGenerationChains = new Map(); // syncId -> 遅延アップロードとの二重生成防止
const MIX_DEBOUNCE_MS = 20000;    // 最後の1本が確定してから待つ時間

function inferUsernameFromRecordingFilename(filename) {
  const match = path.basename(filename).match(/^(.*)-\d{8}-\d{6}(?:-local)?\.[a-z0-9]+$/i);
  return match ? match[1] : '';
}

function collectSyncGroup(syncId) {
  const participants = new Map();
  for (const name of fs.readdirSync(uploadsDir)) {
    if (!name.endsWith('.sync.json')) continue;
    try {
      const side = JSON.parse(fs.readFileSync(path.join(uploadsDir, name), 'utf8'));
      if (side.syncId !== syncId || !Number(side.startEpoch)) continue;
      const audioPath = path.join(uploadsDir, name.replace(/\.sync\.json$/i, ''));
      if (!fs.existsSync(audioPath)) continue;
      // 整音済み(-master)は元音源と重複するのでミックス対象から除く
      if (/-master\.[a-z0-9]+$/i.test(audioPath)) continue;
      const username = String(side.username || inferUsernameFromRecordingFilename(audioPath)).trim();
      if (!username) continue;
      const candidate = {
        audioPath,
        startEpoch: Number(side.startEpoch),
        username,
        size: fs.statSync(audioPath).size,
        source: /-local\.[a-z0-9]+$/i.test(audioPath) ? 'local' : 'server',
      };
      const key = username.toLocaleLowerCase('en-US');
      const slot = participants.get(key) || { server: null, local: null };
      const kind = candidate.source;
      if (!slot[kind] || candidate.size > slot[kind].size) slot[kind] = candidate;
      participants.set(key, slot);
    } catch {}
  }
  return [...participants.values()]
    .map(slot => slot.server || slot.local)
    .filter(Boolean)
    .sort((a, b) => a.startEpoch - b.startEpoch);
}

async function generateMix(syncId) {
  const members = collectSyncGroup(syncId);
  if (members.length === 0) return null;

  const minStart = Math.min(...members.map((m) => m.startEpoch));
  const safeSyncId = String(syncId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const outputFilename = `MIX-${safeSyncId}.mp3`;
  const outputPath = path.join(uploadsDir, outputFilename);
  const tempOutputPath = path.join(uploadsDir, `MIX-${safeSyncId}.tmp-${process.pid}-${Date.now()}.mp3`);

  const args = [];
  members.forEach((m) => args.push('-i', m.audioPath));

  const filters = members.map((m, index) => {
    const delayMs = Math.max(0, Math.round(m.startEpoch - minStart));
    return `[${index}]adelay=${delayMs}:all=1[a${index}]`;
  });
  const mixInputs = members.map((_, index) => `[a${index}]`).join('');
  // normalize=0 で音量を保ったまま合成し、最後にラウドネスを整えてクリップを防ぐ
  const filterComplex = `${filters.join(';')};${mixInputs}amix=inputs=${members.length}:normalize=0[mixed];[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[out]`;

  args.push(
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-ac', '1',
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    '-y', tempOutputPath,
  );

  try {
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);
      let stderr = '';
      ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });
      ffmpeg.on('close', (code) => (code === 0
        ? resolve()
        : reject(new Error(`ミックス生成に失敗しました (code ${code}): ${stderr.slice(-300)}`))));
      ffmpeg.on('error', (err) => reject(new Error(`ffmpeg起動エラー: ${err.message}`)));
    });
    fs.renameSync(tempOutputPath, outputPath);
  } catch (err) {
    try { fs.unlinkSync(tempOutputPath); } catch {}
    throw err;
  }

  const legacyPrefix = `MIX-${safeSyncId}-`;
  for (const name of fs.readdirSync(uploadsDir)) {
    if (name !== outputFilename && name.startsWith(legacyPrefix) && name.endsWith('.mp3')) {
      try { fs.unlinkSync(path.join(uploadsDir, name)); } catch {}
    }
  }

  const stat = fs.statSync(outputPath);
  const memberLog = members
    .map(member => `${member.username}${member.source === 'local' ? '[ローカル代替]' : '[サーバー録音]'}`)
    .join(', ');
  console.log(`[ミックス生成] ${outputFilename} (${(stat.size / 1024 / 1024).toFixed(1)} MB / ${members.length}トラック) 構成=${memberLog}`);
  return { filename: outputFilename, size: stat.size, tracks: members.length, members: members.map(({ username, source }) => ({ username, source })) };
}

function queueMixGeneration(syncId) {
  const previous = mixGenerationChains.get(syncId) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => generateMix(syncId));
  mixGenerationChains.set(syncId, next);
  next.finally(() => {
    if (mixGenerationChains.get(syncId) === next) mixGenerationChains.delete(syncId);
  }).catch(() => {});
  return next;
}

// 同じsyncIdの録音が確定するたびに呼ぶ。最後の1本から一定時間おいてまとめて生成する。
function scheduleMix(syncId, roomId) {
  if (!syncId) return;
  if (mixTimers.has(syncId)) clearTimeout(mixTimers.get(syncId));
  mixTimers.set(syncId, setTimeout(() => {
    mixTimers.delete(syncId);
    queueMixGeneration(syncId)
      .then((result) => {
        if (result && roomId) io.to(roomId).emit('mix-ready', result);
      })
      .catch((err) => console.error('[ミックス生成エラー]', err.message));
  }, MIX_DEBOUNCE_MS));
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeClockSyncMeta(data) {
  const source = data || {};
  const rawOk = source.clockSyncOk;
  const clockSyncOk = rawOk === true || rawOk === 'true'
    ? true
    : (rawOk === false || rawOk === 'false' ? false : null);
  const clockRttMs = optionalFiniteNumber(source.clockRttMs);
  const clockOffsetMs = optionalFiniteNumber(source.clockOffsetMs);
  return {
    clockSyncOk,
    clockRttMs: clockRttMs === null ? null : Math.round(clockRttMs),
    clockOffsetMs: clockOffsetMs === null ? null : Math.round(clockOffsetMs),
  };
}

// ===== ローカル録音をFLACに変換・保存 =====
app.post('/convert-to-flac', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'ファイルがありません' });
  }
  const username = safeUsername(req.body && req.body.username);
  const { dateStr, timeStr } = getTimestampParts();
  const outputFilename = `${username}-${dateStr}-${timeStr}-local.flac`;
  const outputPath = path.join(uploadsDir, outputFilename);
  const inputPath = req.file.path;

  try {
    await convertToFlac(inputPath, outputPath);
    const syncId = req.body && req.body.syncId;
    const startEpoch = req.body && Number(req.body.startEpoch);
    if (syncId && startEpoch) {
      const endEpoch = Number(req.body && req.body.endEpoch) || null;
      const clockSync = normalizeClockSyncMeta(req.body);
      try { fs.writeFileSync(outputPath + '.sync.json', JSON.stringify({ syncId, startEpoch, endEpoch, username, ...clockSync })); } catch {}
      scheduleMix(syncId, null);
    }
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

// ===== 整音処理（ハイパス→ノイズ除去→ラウドネス正規化 -16 LUFS） =====
const processJobs = new Map(); // filename -> { status, output, error }
const NOISE_REDUCTION_DB = 12;
const NOISE_PROFILE_STEP_SEC = 0.5;
const NOISE_PROFILE_DURATION_SEC = 2;
const NOISE_PROFILE_FRAMES = NOISE_PROFILE_DURATION_SEC / NOISE_PROFILE_STEP_SEC;
const NOISE_PROFILE_DIGITAL_SILENCE_DB = -70;
const NOISE_PROFILE_MIN_QUIETER_DB = 12;
const ARNNDN_MODEL_PATH = process.env.ARNNDN_MODEL_PATH || path.join(__dirname, 'models', 'surecast.rnnn');

function runFfmpegCapture(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('close', code => code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg失敗 (code ${code}): ${stderr.slice(-300)}`)));
    p.on('error', err => reject(new Error(`ffmpeg起動エラー: ${err.message}`)));
  });
}

function parseMeanVolume(stderr) {
  const match = stderr.match(/mean_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/i);
  if (!match) throw new Error('平均音量を取得できませんでした');
  return match[1].toLowerCase() === '-inf' ? -Infinity : Number(match[1]);
}

async function measureMeanVolume(inputPath, startSec = null, durationSec = null) {
  const args = ['-hide_banner', '-nostats', '-i', inputPath];
  if (startSec !== null) args.push('-ss', String(startSec));
  if (durationSec !== null) args.push('-t', String(durationSec));
  args.push('-vn', '-af', 'volumedetect', '-f', 'null', '-');
  return parseMeanVolume(await runFfmpegCapture(args));
}

function roundDb(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function meanPowerDb(values) {
  if (!values.length) return -Infinity;
  const meanPower = values.reduce((sum, value) => (
    sum + (Number.isFinite(value) ? 10 ** (value / 10) : 0)
  ), 0) / values.length;
  return meanPower > 0 ? 10 * Math.log10(meanPower) : -Infinity;
}

function parseNoiseFrames(stderr) {
  const frames = [];
  let ptsTime = null;
  for (const line of stderr.split(/\r?\n/)) {
    const timeMatch = line.match(/pts_time:([+-]?\d+(?:\.\d+)?)/);
    if (timeMatch) ptsTime = Number(timeMatch[1]);
    const rmsMatch = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?inf|[+-]?\d+(?:\.\d+)?)/i);
    if (!rmsMatch || !Number.isFinite(ptsTime)) continue;
    frames.push({
      startSec: ptsTime,
      rmsDb: rmsMatch[1].toLowerCase() === '-inf' ? -Infinity : Number(rmsMatch[1]),
    });
    ptsTime = null;
  }
  return frames;
}

async function measureNoiseFrames(inputPath) {
  const sampleCount = Math.round(48000 * NOISE_PROFILE_STEP_SEC);
  const filter = [
    'aresample=48000',
    `asetnsamples=n=${sampleCount}:p=0`,
    'astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level',
    'ametadata=print:key=lavfi.astats.Overall.RMS_level',
  ].join(',');
  const stderr = await runFfmpegCapture([
    '-hide_banner', '-nostats', '-i', inputPath,
    '-vn', '-af', filter, '-f', 'null', '-',
  ]);
  const frames = parseNoiseFrames(stderr);
  if (!frames.length) throw new Error('0.5秒ごとの音量を取得できませんでした');
  return frames;
}

function createNoiseResult(overrides = {}) {
  return {
    applied: false,
    status: 'skipped',
    method: 'skipped',
    profileSelection: 'automatic',
    reason: '安全なノイズプロファイルを取得できませんでした',
    reductionDb: NOISE_REDUCTION_DB,
    thresholdDb: NOISE_PROFILE_MIN_QUIETER_DB,
    digitalSilenceThresholdDb: NOISE_PROFILE_DIGITAL_SILENCE_DB,
    profileStartSec: null,
    profileEndSec: null,
    profileMeanDb: null,
    overallMeanDb: null,
    quieterByDb: null,
    windowsAnalyzed: 0,
    profileWasSilent: false,
    arnndnModelAvailable: fs.existsSync(ARNNDN_MODEL_PATH),
    ...overrides,
  };
}

async function assessNoiseProfile(inputPath) {
  try {
    const frames = await measureNoiseFrames(inputPath);
    const overallMeanDb = meanPowerDb(frames.map(frame => frame.rmsDb));
    let best = null;
    let windowsAnalyzed = 0;
    for (let index = 0; index <= frames.length - NOISE_PROFILE_FRAMES; index++) {
      const windowFrames = frames.slice(index, index + NOISE_PROFILE_FRAMES);
      const continuous = windowFrames.every((frame, frameIndex) => (
        frameIndex === 0
        || Math.abs(frame.startSec - windowFrames[frameIndex - 1].startSec - NOISE_PROFILE_STEP_SEC) <= 0.05
      ));
      if (!continuous) continue;
      windowsAnalyzed++;
      if (windowFrames.some(frame => !Number.isFinite(frame.rmsDb) || frame.rmsDb < NOISE_PROFILE_DIGITAL_SILENCE_DB)) continue;
      const profileMeanDb = meanPowerDb(windowFrames.map(frame => frame.rmsDb));
      if (!best || profileMeanDb < best.profileMeanDb) {
        best = {
          profileStartSec: windowFrames[0].startSec,
          profileEndSec: windowFrames[0].startSec + NOISE_PROFILE_DURATION_SEC,
          profileMeanDb,
        };
      }
    }

    if (best && Number.isFinite(overallMeanDb)) {
      const quieterByDb = overallMeanDb - best.profileMeanDb;
      if (quieterByDb >= NOISE_PROFILE_MIN_QUIETER_DB) {
        return createNoiseResult({
          applied: true,
          status: 'applied',
          method: 'profile',
          reason: `自動検出した2秒間が全体平均より ${quieterByDb.toFixed(1)} dB静かです`,
          profileStartSec: roundDb(best.profileStartSec),
          profileEndSec: roundDb(best.profileEndSec),
          profileMeanDb: roundDb(best.profileMeanDb),
          overallMeanDb: roundDb(overallMeanDb),
          quieterByDb: roundDb(quieterByDb),
          windowsAnalyzed,
        });
      }
    }

    const profileReason = best
      ? `最も静かな2秒間でも全体平均との差が ${roundDb(overallMeanDb - best.profileMeanDb)} dBでした`
      : `${NOISE_PROFILE_DIGITAL_SILENCE_DB} dB未満の無音を除く連続2秒間がありませんでした`;
    if (fs.existsSync(ARNNDN_MODEL_PATH)) {
      return createNoiseResult({
        applied: true,
        status: 'applied',
        method: 'arnndn',
        reason: `${profileReason}。AIノイズ除去へ切り替えます`,
        overallMeanDb: roundDb(overallMeanDb),
        windowsAnalyzed,
        arnndnModelPath: ARNNDN_MODEL_PATH,
      });
    }
    return createNoiseResult({
      reason: `${profileReason}。arnndnモデルがないためノイズ除去を省略しました`,
      overallMeanDb: roundDb(overallMeanDb),
      windowsAnalyzed,
    });
  } catch (err) {
    if (fs.existsSync(ARNNDN_MODEL_PATH)) {
      return createNoiseResult({
        applied: true,
        status: 'applied',
        method: 'arnndn',
        reason: `自動プロファイル測定に失敗したためAIノイズ除去へ切り替えます: ${err.message}`,
        arnndnModelPath: ARNNDN_MODEL_PATH,
      });
    }
    return createNoiseResult({
      reason: `自動プロファイル測定に失敗し、arnndnモデルもないためノイズ除去を省略しました: ${err.message}`,
    });
  }
}

function escapeFfmpegFilterValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

async function runMasteringPasses(inputPath, outputPath, clean, padMs, totalDurationSec) {
  const stderr1 = await runFfmpegCapture([
    '-i', inputPath,
    '-af', `${clean},loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`,
    '-f', 'null', '-',
  ]);
  const jsonMatch = stderr1.match(/\{[^{}]*"input_i"[\s\S]*?\}/);
  if (!jsonMatch) throw new Error('ラウドネス測定に失敗しました');
  const m = JSON.parse(jsonMatch[0]);
  const pad = padMs > 1 ? `,adelay=${Math.round(padMs)}:all=1` : '';
  const tail = totalDurationSec > 0 ? `,apad,atrim=end=${totalDurationSec.toFixed(3)}` : '';
  await runFfmpegCapture([
    '-i', inputPath,
    '-af', `${clean},loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true${pad}${tail}`,
    '-ar', '48000', '-ac', '1',
    '-c:a', 'flac', '-compression_level', '5',
    '-y', outputPath,
  ]);
}

async function masterAudio(inputPath, outputPath, padMs = 0, totalDurationSec = 0) {
  // 整音チェーン: ハイパス → ノイズ除去 → ラウドネス正規化(-16 LUFS)
  // 同期整列は loudnorm の「後」に adelay で先頭無音を付与（測定値を無音で歪ませない）
  const noise = await assessNoiseProfile(inputPath);
  let noiseFilter = '';
  if (noise.method === 'profile') {
    noiseFilter = `asendcmd=c='${noise.profileStartSec} afftdn sn start;${noise.profileEndSec} afftdn sn stop',afftdn=nr=${NOISE_REDUCTION_DB}:tn=0`;
  } else if (noise.method === 'arnndn') {
    noiseFilter = `arnndn=m='${escapeFfmpegFilterValue(ARNNDN_MODEL_PATH)}'`;
  }
  const clean = noiseFilter ? `highpass=f=80,${noiseFilter}` : 'highpass=f=80';
  if (noise.applied) {
    console.log(`[整音] ノイズ除去を適用: method=${noise.method} nr=${NOISE_REDUCTION_DB} dB (${noise.reason})`);
  } else {
    console.warn(`[整音] ノイズ除去をスキップ: ${noise.reason}`);
  }
  try {
    await runMasteringPasses(inputPath, outputPath, clean, padMs, totalDurationSec);
  } catch (err) {
    if (!noise.applied) throw err;
    noise.applied = false;
    noise.status = 'skipped';
    noise.method = 'skipped';
    noise.reason = `ノイズ除去フィルターが失敗したため省略しました: ${err.message}`;
    console.warn(`[整音] ${noise.reason}`);
    await runMasteringPasses(inputPath, outputPath, 'highpass=f=80', padMs, totalDurationSec);
  }
  return noise;
}

app.post('/process/:filename', (req, res) => {
  const fname = path.basename(req.params.filename);
  const inputPath = path.join(uploadsDir, fname);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'ファイルが見つかりません' });
  if (/-master\.flac$/i.test(fname)) return res.status(400).json({ error: 'すでに整音済みのファイルです' });
  const existing = processJobs.get(fname);
  if (existing && existing.status === 'processing') return res.status(409).json({ error: '処理中です' });
  const outputFilename = fname.replace(/\.[^.]+$/, '') + '-master.flac';
  const outputPath = path.join(uploadsDir, outputFilename);
  const processMetadataPath = outputPath + '.process.json';
  try { fs.unlinkSync(processMetadataPath); } catch {}
  processJobs.set(fname, { status: 'processing', output: outputFilename });
  console.log(`[整音開始] ${fname}`);
  let padMs = 0;
  let totalDurationSec = 0; // >0 なら全トラック共通の長さに統一
  try {
    const side = JSON.parse(fs.readFileSync(inputPath + '.sync.json', 'utf8'));
    if (side && side.syncId && Number(side.startEpoch)) {
      // 同一syncIdグループの最も早い開始時刻(T0)を基準に、各トラックの遅れぶんを無音で埋める
      let minStart = Number(side.startEpoch);
      for (const f of fs.readdirSync(uploadsDir)) {
        if (!f.endsWith('.sync.json')) continue;
        try {
          const sc = JSON.parse(fs.readFileSync(path.join(uploadsDir, f), 'utf8'));
          if (sc.syncId === side.syncId && Number(sc.startEpoch) < minStart) minStart = Number(sc.startEpoch);
        } catch {}
      }
      padMs = Number(side.startEpoch) - minStart;
      if (!(padMs >= 0)) padMs = 0;                 // NaN/負値ガード
      if (padMs > 6 * 3600 * 1000) padMs = 0;       // 6時間超は時計異常とみなし整列しない（巨大無音ファイル防止）
      if (padMs > 1) console.log(`[整音] 同期整列: 冒頭に ${(padMs/1000).toFixed(3)} 秒の無音を追加して頭を揃えます (syncId=${side.syncId})`);

      // 全トラック長を共通タイムライン（最早開始〜最遅終了）に合わせる（Craig方式・末尾を無音で伸長）
      let maxEnd = 0;
      for (const f of fs.readdirSync(uploadsDir)) {
        if (!f.endsWith('.sync.json')) continue;
        try {
          const sc = JSON.parse(fs.readFileSync(path.join(uploadsDir, f), 'utf8'));
          if (sc.syncId === side.syncId && Number(sc.endEpoch) > maxEnd) maxEnd = Number(sc.endEpoch);
        } catch {}
      }
      if (maxEnd > minStart) {
        const totalSec = (maxEnd - minStart) / 1000;
        if (totalSec > 0 && totalSec <= 6 * 3600) {
          totalDurationSec = totalSec;
          console.log(`[整音] 同期整列: 全トラック長を ${totalSec.toFixed(3)} 秒に統一します (syncId=${side.syncId})`);
        }
      }
    }
  } catch {}
  masterAudio(inputPath, outputPath, padMs, totalDurationSec)
    .then((noise) => {
      const metadata = {
        source: fname,
        output: outputFilename,
        processedAt: new Date().toISOString(),
        noise,
      };
      fs.writeFileSync(processMetadataPath, JSON.stringify(metadata, null, 2));
      processJobs.set(fname, { status: 'done', output: outputFilename, noise });
      console.log(`[整音完了] ${outputFilename}`);
    })
    .catch(err => {
      processJobs.set(fname, { status: 'error', error: err.message });
      console.error('[整音エラー]', err.message);
      try { fs.unlinkSync(outputPath); } catch {}
    });
  res.json({ started: true, output: outputFilename });
});

app.get('/process-status/:filename', (req, res) => {
  const fname = path.basename(req.params.filename);
  res.json(processJobs.get(fname) || { status: 'none' });
});

// ===== 保存済み録音一覧 =====
app.get('/recordings', (req, res) => {
  try {
    const files = fs.readdirSync(uploadsDir)
      .filter(f => /\.(webm|wav|mp4|ogg|flac|mp3)$/i.test(f) || f.endsWith('.failed.json'))
      .map(f => {
        const fullPath = path.join(uploadsDir, f);
        const stat = fs.statSync(fullPath);
        if (f.endsWith('.failed.json')) {
          let failure = null;
          try { failure = JSON.parse(fs.readFileSync(fullPath, 'utf8')); } catch {}
          return { name: f, size: 0, mtime: stat.mtime, failure };
        }
        let processing = null;
        let sync = null;
        if (/-master\.flac$/i.test(f)) {
          try { processing = JSON.parse(fs.readFileSync(fullPath + '.process.json', 'utf8')); } catch {}
        }
        try { sync = JSON.parse(fs.readFileSync(fullPath + '.sync.json', 'utf8')); } catch {}
        return { name: f, size: stat.size, mtime: stat.mtime, processing, sync };
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
const roomActiveSync = new Map(); // roomId -> 進行中の一斉録音syncId（途中参加者の自動録音・整列用）
const roomCountdownEnds = new Map(); // roomId -> 一斉録音カウントダウン終了時刻
const episodeLocks = new Map(); // roomId -> Map<episodeId, {holderId, holderName, timer}>（台本同時編集の衝突防止）

// key: `${roomId}:${username}` -> timer（切断後グレース期間タイマー）
const finalizationTimers = new Map();

const FINALIZATION_GRACE_MS = 300000; // 300秒（5分）グレース期間（2時間収録・ping1500ms超の低回線対応）
const RECORDING_STALL_MS = 45000;
const RECORDING_HEALTH_INTERVAL_MS = 10000;

function stopRecordingHealthMonitor(rec) {
  if (rec && rec.healthTimer) clearInterval(rec.healthTimer);
  if (rec) rec.healthTimer = null;
}

function emitRecordingHealth(rec, active) {
  io.to(rec.roomId).emit('recording-health-alert', {
    username: rec.username,
    reason: active ? 'no-audio' : 'recovered',
    active,
  });
}

function startRecordingHealthMonitor(rec) {
  stopRecordingHealthMonitor(rec);
  rec.healthTimer = setInterval(() => {
    if (rec.disconnectedAt) return;

    const stalledMs = Date.now() - rec.lastValidChunkAt;
    if (stalledMs > RECORDING_STALL_MS) {
      if (!rec.healthAlerted) {
        rec.healthAlerted = true;
        console.error(`[録音異常] room=${rec.roomId} user=${rec.username} ${Math.floor(stalledMs / 1000)}秒間データ未着 (累計受信=${rec.receivedBytes} bytes)`);
        emitRecordingHealth(rec, true);
      }
    } else if (rec.healthAlerted) {
      rec.healthAlerted = false;
      emitRecordingHealth(rec, false);
      console.log(`[録音復旧] room=${rec.roomId} user=${rec.username} データ受信を再開`);
    }
  }, RECORDING_HEALTH_INTERVAL_MS);
}

function persistRecordingFailure(rec, reason, size) {
  const markerName = `${rec.username}-${rec.dateStr}-${rec.timeStr}.failed.json`;
  const markerPath = path.join(uploadsDir, markerName);
  const failure = {
    type: 'recording-failure',
    username: rec.username,
    roomId: rec.roomId,
    reason,
    size,
    timestamp: Date.now(),
  };
  try { fs.writeFileSync(markerPath, JSON.stringify(failure, null, 2)); } catch (err) {
    console.error('[録音失敗記録エラー]', err.message);
  }
  emitRecordingHealth(rec, false);
  io.to(rec.roomId).emit('recording-discarded', failure);
}

async function finalizeServerRecording(rec) {
  if (!rec) return;
  stopRecordingHealthMonitor(rec);

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
  const MIN_VALID_SIZE = 8 * 1024;  // 8KB未満は音声データなし（EBMLヘッダーのみ相当）。短い録音も保存できるよう閾値を下げる
  if (inputStat.size < MIN_VALID_SIZE) {
    console.log(`[サーバー録音スキップ] ${path.basename(tempPath)} サイズ不足 (${inputStat.size} bytes) → 破棄`);
    persistRecordingFailure(rec, 'size-too-small', inputStat.size);
    try { fs.unlinkSync(tempPath); } catch {}
    return;
  }

  const outputFilename = `${username}-${dateStr}-${timeStr}.flac`;
  const outputPath = path.join(uploadsDir, outputFilename);

  try {
    await convertToFlac(tempPath, outputPath);
    if (rec.syncId && rec.startEpoch) {
      // endEpoch も記録（全トラック長を共通タイムラインへ揃えるため）
      try {
        fs.writeFileSync(outputPath + '.sync.json', JSON.stringify({
          syncId: rec.syncId,
          startEpoch: rec.startEpoch,
          endEpoch: Date.now(),
          username,
          clockSyncOk: rec.clockSyncOk,
          clockRttMs: rec.clockRttMs,
          clockOffsetMs: rec.clockOffsetMs,
        }));
      } catch {}
    }
    const outStat = fs.statSync(outputPath);
    console.log(`[サーバー録音保存] ${outputFilename} (${(outStat.size / 1024 / 1024).toFixed(1)} MB)`);
    if (rec.syncId) scheduleMix(rec.syncId, roomId);
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
      const fallbackFilename = `${username}-${dateStr}-${timeStr}-raw.webm`;
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
const preflightChecks = new Map(); // checkId -> 参加者と判定結果
const roomCurrentPreflight = new Map(); // roomId -> checkId
const preflightRecordings = new Map(); // `${checkId}:${socketId}` -> /tmp録音
const PREFLIGHT_MIN_BYTES = 512;
const PREFLIGHT_RESULT_TIMEOUT_MS = 20000;

function getPreflightRecordingKey(checkId, socketId) {
  return `${checkId}:${socketId}`;
}

async function closePreflightWriteStream(rec) {
  if (!rec?.writeStream || rec.writeStream.destroyed) return;
  await Promise.race([
    new Promise(resolve => rec.writeStream.end(resolve)),
    new Promise(resolve => setTimeout(resolve, 1500)),
  ]);
}

function removePreflightTemp(rec) {
  if (!rec) return;
  try { if (rec.writeStream && !rec.writeStream.destroyed) rec.writeStream.destroy(); } catch {}
  try { fs.unlinkSync(rec.tempPath); } catch {}
}

async function inspectPreflightAudio(rec) {
  if (!rec) return { status: 'no-data', bytes: 0, maxVolumeDb: null };
  await closePreflightWriteStream(rec);
  const bytes = fs.existsSync(rec.tempPath) ? fs.statSync(rec.tempPath).size : 0;
  if (rec.writeError) {
    removePreflightTemp(rec);
    return { status: 'corrupt', bytes, maxVolumeDb: null, error: rec.writeError };
  }
  if (bytes < PREFLIGHT_MIN_BYTES) {
    removePreflightTemp(rec);
    return { status: 'no-data', bytes, maxVolumeDb: null };
  }

  try {
    const stderr = await runFfmpegCapture([
      '-hide_banner', '-nostats', '-i', rec.tempPath,
      '-vn', '-af', 'volumedetect,astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Peak_level', '-f', 'null', '-',
    ]);
    const match = stderr.match(/max_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/i);
    if (!match) throw new Error('max_volumeを取得できませんでした');
    const maxVolumeDb = match[1].toLowerCase() === '-inf' ? -Infinity : Number(match[1]);
    const exactPeakMatch = stderr.match(/Peak level dB:\s*(-?inf|-?\d+(?:\.\d+)?)/i);
    if (!exactPeakMatch) throw new Error('Peak_levelを取得できませんでした');
    const exactPeakDb = exactPeakMatch[1].toLowerCase() === '-inf' ? -Infinity : Number(exactPeakMatch[1]);
    const digitalSilence = exactPeakDb === -Infinity;
    return {
      status: digitalSilence ? 'digital-silence' : 'ok',
      bytes,
      maxVolumeDb: Number.isFinite(maxVolumeDb) ? maxVolumeDb : null,
      exactPeakDb: Number.isFinite(exactPeakDb) ? exactPeakDb : null,
      digitalSilence,
    };
  } catch (err) {
    return { status: 'corrupt', bytes, maxVolumeDb: null, error: err.message };
  } finally {
    removePreflightTemp(rec);
  }
}

function getPreflightProblems(row) {
  const problems = [];
  if (!row.micOk) problems.push(row.audioStatus === 'digital-silence' ? 'デジタル無音' : 'マイク');
  if (!row.serverReachOk) problems.push('サーバー到達');
  if (!row.clockSyncOk) problems.push('時刻同期');
  if (!row.wakeLockOk) problems.push('画面スリープ防止');
  if (row.inAppBrowser) problems.push('アプリ内ブラウザ');
  return problems;
}

function serializePreflightCheck(check) {
  const participants = check.participants.map(participant => {
    const result = check.results.get(participant.peerId);
    return result || { ...participant, pending: true, ok: false, problems: ['未応答'] };
  });
  const complete = participants.every(row => !row.pending);
  const allOk = complete
    && participants.every(row => row.ok)
    && check.disk.level === 'ok';
  return {
    checkId: check.checkId,
    roomId: check.roomId,
    createdAt: check.createdAt,
    completedAt: complete ? (check.completedAt || Date.now()) : null,
    complete,
    allOk,
    disk: check.disk,
    participants,
  };
}

function emitPreflightCheck(check) {
  const payload = serializePreflightCheck(check);
  if (payload.complete && !check.completedAt) {
    check.completedAt = payload.completedAt;
    clearTimeout(check.timeout);
  }
  io.to(check.roomId).emit('preflight-result', { ...payload, completedAt: check.completedAt || payload.completedAt });
}

async function acceptPreflightReport(socket, report) {
  const checkId = String(report?.checkId || '');
  const check = preflightChecks.get(checkId);
  if (!check || check.roomId !== socket.data.roomId) return;
  const participant = check.participants.find(item => item.peerId === socket.id);
  if (!participant || check.results.has(socket.id) || check.processing.has(socket.id)) return;
  check.processing.add(socket.id);

  try {
    const recKey = getPreflightRecordingKey(checkId, socket.id);
    const rec = preflightRecordings.get(recKey);
    preflightRecordings.delete(recKey);
    const audio = await inspectPreflightAudio(rec);
    const serverReachOk = audio.bytes >= PREFLIGHT_MIN_BYTES && audio.status !== 'no-data';
    const clockRttMs = optionalFiniteNumber(report.clockRttMs);
    const clockOffsetMs = optionalFiniteNumber(report.clockOffsetMs);
    const clockSyncOk = report.clockSyncOk === true && clockRttMs !== null && clockRttMs <= 500;
    const row = {
      ...participant,
      pending: false,
      micLabel: String(report.micLabel || '不明'),
      micOk: report.micTrackOk !== false && audio.status === 'ok',
      audioStatus: audio.status,
      audioBytes: audio.bytes,
      maxVolumeDb: audio.maxVolumeDb,
      exactPeakDb: audio.exactPeakDb,
      digitalSilence: audio.digitalSilence === true,
      serverReachOk,
      clockSyncOk,
      clockRttMs: clockRttMs === null ? null : Math.round(clockRttMs),
      clockOffsetMs: clockOffsetMs === null ? null : Math.round(clockOffsetMs),
      wakeLockOk: report.wakeLockOk === true,
      browser: String(report.browser || '不明'),
      inAppBrowser: report.inAppBrowser === true,
      speakerMode: report.speakerMode === true,
      clientError: report.error ? String(report.error) : null,
    };
    row.problems = getPreflightProblems(row);
    row.ok = row.problems.length === 0;
    check.results.set(socket.id, row);
    const exactPeakLog = row.digitalSilence ? '-inf' : (row.exactPeakDb === null ? 'n/a' : row.exactPeakDb);
    console.log(`[収録前チェック] room=${check.roomId} user=${row.username} audio=${row.audioStatus} bytes=${row.audioBytes} max_volume=${row.maxVolumeDb === null ? 'n/a' : row.maxVolumeDb} exact_peak=${exactPeakLog} clock=${row.clockSyncOk ? 'ok' : 'ng'}`);
    emitPreflightCheck(check);
  } finally {
    check.processing.delete(socket.id);
  }
}

function beginPreflightRecording(socket, data) {
  const checkId = String(data?.checkId || '');
  const check = preflightChecks.get(checkId);
  if (!check || check.roomId !== socket.data.roomId) return;
  const recKey = getPreflightRecordingKey(checkId, socket.id);
  const previous = preflightRecordings.get(recKey);
  if (previous) removePreflightTemp(previous);
  const safeCheckId = checkId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const tempPath = path.join(os.tmpdir(), `surecast-check-${safeCheckId}-${socket.id}-${Date.now()}.webm`);
  const writeStream = fs.createWriteStream(tempPath);
  const rec = { checkId, socketId: socket.id, tempPath, writeStream, receivedBytes: 0, writeError: null };
  writeStream.on('error', err => {
    rec.writeError = err.message;
    console.error(`[収録前チェック書込エラー] check=${checkId} socket=${socket.id}: ${err.message}`);
  });
  preflightRecordings.set(recKey, rec);
}

function receivePreflightChunk(socket, data) {
  const checkId = String(data?.checkId || '');
  const rec = preflightRecordings.get(getPreflightRecordingKey(checkId, socket.id));
  if (!rec || !rec.writeStream || rec.writeStream.destroyed) return;
  try {
    const chunk = Buffer.from(data.buf);
    rec.writeStream.write(chunk);
    rec.receivedBytes += chunk.length;
  } catch (err) {
    rec.writeError = err.message;
  }
}

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
      rec.disconnectedAt = Date.now();
      if (rec.healthAlerted) {
        rec.healthAlerted = false;
        emitRecordingHealth(rec, false);
      }
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

  // 台本編集ロックを解放
  const roomLocks = episodeLocks.get(roomId);
  if (roomLocks) {
    for (const [episodeId, lock] of [...roomLocks]) {
      if (lock.holderId === socket.id) {
        clearTimeout(lock.timer);
        roomLocks.delete(episodeId);
        io.to(roomId).emit('episode-unlock', { episodeId });
      }
    }
    if (roomLocks.size === 0) episodeLocks.delete(roomId);
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
    if (!data || typeof data !== 'object') {
      socket.emit('username-invalid', { message: '表示名を入力してください' });
      return;
    }
    let roomId = String(data.roomId || '');

    if (!roomId) return;
    roomId = roomId.trim().toUpperCase().slice(0, 12);
    if (!roomId) return;

    if (socket.data.roomId) leaveRoom(socket);

    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const room = rooms.get(roomId);
    if (!room.has(socket.id) && room.size >= 6) {
      socket.emit('room-full', { max: 6 });
      console.log(`[join拒否] room=${roomId} reason=room-full`);
      return;
    }

    if (!roomUsernames.has(roomId)) roomUsernames.set(roomId, new Map());
    const usernameMap = roomUsernames.get(roomId);
    let normalized;
    try {
      normalized = normalizeUsername(data.username);
    } catch (err) {
      socket.emit('username-invalid', { message: err.message });
      console.log(`[join拒否] room=${roomId} reason=invalid-username`);
      return;
    }
    const username = assignUniqueUsername(normalized.username, usernameMap);
    const deduplicated = username !== normalized.username;
    socket.data.username = username;
    socket.emit('username-assigned', {
      username,
      originalUsername: normalized.original,
      transliterated: normalized.transliterated,
      deduplicated,
    });
    socket.join(roomId);

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

    // 録音中のルームに途中参加 → 本人だけに録音開始コマンドを送り自動録音（同一syncIdで整列可能に）
    const activeSync = roomActiveSync.get(roomId);
    if (activeSync) {
      socket.emit('recording-start-command', {
        initiator: 'セッション',
        syncId: activeSync,
        countdownEndEpoch: Date.now() + 3000,
        lateJoin: true,
      });
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
    // 編集ロック確認：他人がロック中なら上書きを拒否（衝突防止の最終防御）
    const rlocks = episodeLocks.get(roomId);
    const held = rlocks && rlocks.get(id);
    if (held && held.holderId !== socket.id) return;
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

  // 台本編集ロック取得（同時に更新も兼ねる＝タイマー延長）
  socket.on('episode-lock-request', ({ episodeId }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !episodeId) return;
    if (!episodeLocks.has(roomId)) episodeLocks.set(roomId, new Map());
    const roomLocks = episodeLocks.get(roomId);
    const existing = roomLocks.get(episodeId);
    if (existing && existing.holderId !== socket.id) {
      socket.emit('episode-lock-denied', { episodeId, holderName: existing.holderName });
      return;
    }
    const isRefresh = existing && existing.holderId === socket.id; // 同一保持者の延長
    if (existing) clearTimeout(existing.timer);
    const holderName = socket.data.username || '誰か';
    const timer = setTimeout(() => {
      roomLocks.delete(episodeId);
      io.to(roomId).emit('episode-unlock', { episodeId });
    }, 4000);
    roomLocks.set(episodeId, { holderId: socket.id, holderName, timer });
    // 新規取得時のみ全員へ通知（延長は静かにタイマーだけ更新＝キーストロークごとの無駄なブロードキャストを回避）
    if (!isRefresh) io.to(roomId).emit('episode-lock', { episodeId, holderId: socket.id, holderName });
  });

  // 台本編集ロック解放
  socket.on('episode-lock-release', ({ episodeId }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !episodeId) return;
    const roomLocks = episodeLocks.get(roomId);
    if (!roomLocks) return;
    const lock = roomLocks.get(episodeId);
    if (lock && lock.holderId === socket.id) {
      clearTimeout(lock.timer);
      roomLocks.delete(episodeId);
      io.to(roomId).emit('episode-unlock', { episodeId });
    }
  });

  socket.on('script-typing', (isTyping) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof isTyping !== 'boolean') return;
    socket.to(roomId).emit('peer-typing', { peerId: socket.id, isTyping });
  });

  // =========================================================
  // ===== サーバー側録音（username:roomId キーで再接続対応）=====
  // =========================================================

  socket.on('preflight-start', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const previousCheckId = roomCurrentPreflight.get(roomId);
    const previous = previousCheckId ? preflightChecks.get(previousCheckId) : null;
    if (previous) {
      clearTimeout(previous.timeout);
      for (const [key, rec] of preflightRecordings) {
        if (rec.checkId === previousCheckId) {
          preflightRecordings.delete(key);
          removePreflightTemp(rec);
        }
      }
    }

    const checkId = `${roomId}-check-${Date.now()}`;
    const participants = [...(rooms.get(roomId) || [])].map(peerId => ({
      peerId,
      username: roomUsernames.get(roomId)?.get(peerId) || 'user',
    }));
    const check = {
      checkId,
      roomId,
      createdAt: Date.now(),
      participants,
      results: new Map(),
      processing: new Set(),
      disk: getDiskSpaceStatus(),
      completedAt: null,
      timeout: null,
    };
    check.timeout = setTimeout(() => {
      for (const [key, rec] of preflightRecordings) {
        if (rec.checkId === checkId) {
          preflightRecordings.delete(key);
          removePreflightTemp(rec);
        }
      }
      for (const participant of check.participants) {
        if (check.results.has(participant.peerId)) continue;
        check.results.set(participant.peerId, {
          ...participant,
          pending: false,
          ok: false,
          micLabel: '未取得',
          micOk: false,
          audioStatus: 'no-data',
          audioBytes: 0,
          maxVolumeDb: null,
          serverReachOk: false,
          clockSyncOk: false,
          clockRttMs: null,
          clockOffsetMs: null,
          wakeLockOk: false,
          browser: '未応答',
          inAppBrowser: false,
          speakerMode: false,
          problems: ['未応答', 'サーバー到達', '時刻同期'],
        });
      }
      emitPreflightCheck(check);
    }, PREFLIGHT_RESULT_TIMEOUT_MS);
    preflightChecks.set(checkId, check);
    roomCurrentPreflight.set(roomId, checkId);
    setTimeout(() => {
      if (roomCurrentPreflight.get(roomId) !== checkId) preflightChecks.delete(checkId);
    }, 15 * 60 * 1000);

    const countdownEndEpoch = Date.now() + 1000;
    console.log(`[収録前チェック開始] room=${roomId} check=${checkId} participants=${participants.length}`);
    io.to(roomId).emit('preflight-command', { checkId, countdownEndEpoch });
    emitPreflightCheck(check);
  });

  socket.on('preflight-report', data => {
    acceptPreflightReport(socket, data).catch(err => {
      console.error('[収録前チェック判定エラー]', err.message);
    });
  });

  // 録音開始
  socket.on('start-server-recording', (data) => {
    if (data?.preflight === true && data.checkId) {
      beginPreflightRecording(socket, data);
      return;
    }
    const username = safeUsername(socket.data.username);
    const roomId = socket.data.roomId;
    if (!roomId || !socket.data.username) return;

    const recKey = `${roomId}:${username}`;

    const existingRecording = serverRecordings.get(recKey);
    if (existingRecording && existingRecording.currentSocketId !== socket.id) {
      const ownerSocket = io.sockets.sockets.get(existingRecording.currentSocketId);
      const ownerIsActive = ownerSocket && ownerSocket.connected && rooms.get(roomId)?.has(existingRecording.currentSocketId);
      if (ownerIsActive) {
        socket.emit('server-recording-error', { message: '同じ表示名の録音が進行中です。表示名を変更して再参加してください' });
        console.error(`[サーバー録音拒否] key=${recKey} reason=active-name-collision`);
        return;
      }
    }
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
        const wasDisconnected = !!rec.disconnectedAt || rec.currentSocketId !== socket.id;
        rec.currentSocketId = socket.id;
        if (wasDisconnected) {
          rec.disconnectedAt = null;
          rec.lastValidChunkAt = Date.now();
          if (rec.healthAlerted) {
            rec.healthAlerted = false;
            emitRecordingHealth(rec, false);
          }
        }
        if (!rec.healthTimer) startRecordingHealthMonitor(rec);
        console.log(`[サーバー録音継続] key=${recKey} newSocket=${socket.id}`);
        return;
      }
      // writeStreamが壊れている場合は新規作成
      stopRecordingHealthMonitor(rec);
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
        io.to(roomId).emit('recording-health-alert', {
          username,
          reason: 'write-error',
          message: `サーバー録音の書き込みに失敗しました: ${err.message}`,
          active: true,
        });
      });
      const rec = {
        writeStream,
        tempPath,
        username,
        roomId,
        dateStr,
        timeStr,
        currentSocketId: socket.id,
        syncId: (data && data.syncId) || null,
        startEpoch: (data && Number(data.startEpoch)) || null,
        ...normalizeClockSyncMeta(data),
        receivedBytes: 0,
        validAudioBytes: 0,
        lastValidChunkAt: Date.now(),
        disconnectedAt: null,
        healthAlerted: false,
        healthTimer: null,
      };
      serverRecordings.set(recKey, rec);
      startRecordingHealthMonitor(rec);
      console.log(`[サーバー録音開始] key=${recKey} file=${path.basename(tempPath)}`);
    } catch (err) {
      console.error('[サーバー録音開始エラー]', err.message);
    }
  });

  // 音声チャンク受信（バイナリ または { seq, buf } オブジェクト）
  socket.on('audio-stream-chunk', (data) => {
    if (data?.checkId) {
      receivePreflightChunk(socket, data);
      return;
    }
    const recKey = socket.data.recKey;
    if (!recKey) return;
    const rec = serverRecordings.get(recKey);
    if (!rec) return;
    // アクティブなソケットからのデータのみ受け入れ
    if (rec.currentSocketId !== socket.id) return;
    if (!rec.writeStream || rec.writeStream.destroyed) return;
    try {
      // 新形式: { seq, buf } / 旧形式: バイナリ直接
      let rawData, seq;
      if (data && typeof data === 'object' && 'buf' in data) {
        seq = data.seq;
        rawData = data.buf;
        // シーケンス番号で欠損チェック
        if (rec.lastSeq !== undefined && seq !== rec.lastSeq + 1) {
          console.warn(`[サーバー録音] チャンク欠損検知 key=${recKey} 期待=${rec.lastSeq + 1} 受信=${seq}`);
        }
        rec.lastSeq = seq;
      } else {
        rawData = data;
      }
      const chunk = Buffer.from(rawData);
      rec.writeStream.write(chunk);
      rec.receivedBytes += chunk.length;
      if (chunk.length > 1024) {
        rec.validAudioBytes += chunk.length;
        rec.lastValidChunkAt = Date.now();
      }
      if (seq !== undefined) {
        console.log(`[サーバー録音] チャンク#${seq} 受信 key=${recKey} (${(chunk.length / 1024).toFixed(0)} KB)`);
      }
    } catch (err) {
      console.error('[チャンク書き込みエラー]', err.message);
    }
  });

  // 録音停止・即時保存
  socket.on('stop-server-recording', () => {
    const recKey = socket.data.recKey;
    if (!recKey) return;

    // グレースタイマーをキャンセル
    if (finalizationTimers.has(recKey)) {
      clearTimeout(finalizationTimers.get(recKey));
      finalizationTimers.delete(recKey);
    }

    const rec = serverRecordings.get(recKey);
    if (rec) {
      // stop直後に非同期で届く最終チャンクを取りこぼさないよう、recKeyを1.2秒保持してから確定
      console.log(`[サーバー録音停止] key=${recKey} → 最終チャンク待機後にFLAC変換`);
      setTimeout(() => {
        socket.data.recKey = null;
        serverRecordings.delete(recKey);
        finalizeServerRecording(rec).catch(e =>
          console.error('[録音停止エラー]', e.message)
        );
      }, 1200);
    } else {
      socket.data.recKey = null;
    }
  });

  // =========================================================
  // ===== 一斉録音開始 =====
  // =========================================================

  // 誰かが「一斉録音開始」ボタンを押したらルーム全員に通知
  socket.on('recording-start-all', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    if (roomActiveSync.has(roomId)) return; // 既に一斉録音中は無視（syncId二重発行防止）
    const disk = getDiskSpaceStatus();
    io.to(roomId).emit('recording-health-alert', {
      username: 'サーバー',
      reason: 'disk-low',
      message: disk.message,
      disk,
      active: disk.level === 'error',
    });
    io.to(roomId).emit('preflight-clear');
    const initiator = socket.data.username || '不明';
    console.log(`[一斉録音] room=${roomId} by ${initiator}`);
    // 送信者自身を含む全員に通知
    const syncId = `${roomId}-${Date.now()}`;
    const countdownEndEpoch = Date.now() + 3000;
    roomActiveSync.set(roomId, syncId);
    roomCountdownEnds.set(roomId, countdownEndEpoch);
    io.to(roomId).emit('recording-start-command', { initiator, syncId, countdownEndEpoch });
  });

  // 一斉停止：ルーム全員（途中参加者含む）の録音を停止
  socket.on('recording-stop-all', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    console.log(`[一斉停止] room=${roomId}`);
    roomActiveSync.delete(roomId);
    roomCountdownEnds.delete(roomId);
    io.to(roomId).emit('recording-stop-command');
  });

  // クライアントの時刻同期用（録音自動位置合わせ）
  socket.on('time-sync', (data, cb) => {
    if (typeof cb === 'function') cb({ server: Date.now() });
  });

  socket.on('recording-status', ({ isRecording }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('peer-recording-status', {
      peerId: socket.id,
      username: socket.data.username || 'user',
      isRecording: !!isRecording,
    });
  });

  // ===== 接続品質計測（カスタムping-pong）=====
  socket.on('client-ping', () => {
    socket.volatile.emit('client-pong'); // volatile: 輻輳時は破棄OK（計測用）
  });

  // ===== 退出・切断 =====
  socket.on('leave-room', () => leaveRoom(socket));

  socket.on('disconnect', () => {
    for (const [key, rec] of preflightRecordings) {
      if (rec.socketId === socket.id) {
        preflightRecordings.delete(key);
        removePreflightTemp(rec);
      }
    }
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
