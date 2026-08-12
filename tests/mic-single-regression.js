const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const callCoreSource = fs.readFileSync(path.join(root, 'public', 'js', 'core', 'call-core.js'), 'utf8');

function section(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert(start >= 0 && end > start, `section not found: ${startText}`);
  return source.slice(start, end);
}

const joinCall = section(indexSource, 'async function joinCall()', '// ===== 通話終了 =====');
const ensureCallCore = section(indexSource, 'function ensureCallCore()', 'function initSocket()');
const socketLifecycle = section(indexSource, "ws.socket.on('connect'", "ws.socket.on('connect_error'");
const serverHealthMonitor = section(serverSource, 'function startRecordingHealthMonitor', 'function persistRecordingFailure');
const serverChunkHandler = section(serverSource, "socket.on('audio-stream-chunk'", '// 録音停止・即時保存');
const existingServerRecording = section(serverSource, 'if (serverRecordings.has(recKey))', '// 新規録音開始');
const clientRecording = section(indexSource, 'let srvRecMR = null', 'function stopServerRecording()');
const micWatchdog = section(indexSource, 'function attachMicWatchdog', 'function getBestMimeType');
const localStopRecording = section(indexSource, 'function stopRecording(', 'async function finalizeRecording');
const micChange = section(indexSource, "$('mic-select').addEventListener", "$('speaker-mode').checked");
const gumCalls = indexSource.match(/navigator\.mediaDevices\.getUserMedia\(/g) || [];

assert.strictEqual(gumCalls.length, 3, 'index.html should have one video and two mutually exclusive audio acquisition branches');
assert(!/getUserMedia\(\{\s*audio/s.test(joinCall), 'joinCall must not acquire audio directly');
assert(/getUserMedia\(\{\s*video/s.test(joinCall), 'joinCall must acquire video separately');
assert(ensureCallCore.includes('await acquireRawAudioStream(48000)'), 'CallCore fallback must use the shared audio capture');
assert(!ensureCallCore.includes('__mediaCore?.getLocalStream'), 'CallCore fallback must not start MediaCore capture');
assert(joinCall.includes("ws.socket.emit('leave-room')"), 'failed join must leave the server room');
assert(joinCall.includes('ws.callCore.destroy()'), 'failed join must destroy CallCore peers');
assert(joinCall.includes('ws.roomId = null'), 'failed join must clear the room id');
assert(socketLifecycle.includes('ws.callCore.joinRoom({ roomId: ws.roomId, username })'), 'reconnect must restore CallCore room state');
assert(socketLifecycle.includes("new Set(['offer', 'answer', 'ice-candidate'])"), 'disconnect must discard buffered stale WebRTC signaling');
assert(socketLifecycle.includes('if (ws.callCore) ws.callCore.destroy()'), 'disconnect must close old peer connections before Socket.io buffers ICE restarts');
assert(!micChange.includes('getUserMedia('), 'mic change must use the shared acquisition helper');
assert(indexSource.includes('await ensureRecordingAudioReady()'), 'recording preflight is missing');
assert(indexSource.includes('srvRecMR.requestData()'), 'five-second requestData probe is missing');
assert(indexSource.includes('audioBitsPerSecond: 128000'), '128kbps recording bitrate changed');
assert(serverSource.includes('FINALIZATION_GRACE_MS = 300000'), 'recording reconnect grace period changed');
assert(serverSource.includes('RECORDING_STALL_MS = 45000'), 'server recording stall threshold changed');
assert(serverSource.includes('RECORDING_HEALTH_INTERVAL_MS = 10000'), 'server recording health interval changed');
assert(serverHealthMonitor.includes('Date.now() - rec.lastValidChunkAt'), 'server must measure time since the latest valid chunk');
assert(serverHealthMonitor.includes('if (rec.disconnectedAt) return'), 'server must suppress alerts while the recorder is disconnected');
assert(serverChunkHandler.includes('rec.lastValidChunkAt = Date.now()'), 'valid server chunks must refresh recording health');
assert(!serverChunkHandler.includes('if (rec.healthAlerted'), 'chunk arrival must not bypass the monitor recovery check');
assert(existingServerRecording.includes('const wasDisconnected = !!rec.disconnectedAt || rec.currentSocketId !== socket.id'), 'server recording resume must distinguish reconnect from same-socket microphone recovery');
assert(existingServerRecording.includes('if (wasDisconnected)'), 'only a real reconnect may reset the server health clock before data arrives');
assert(clientRecording.includes('srvRecHealthTimer = setInterval'), 'client recording health must continue monitoring');
assert(clientRecording.includes('Date.now() - srvRecLastValidChunkAt'), 'client must measure time since the latest valid chunk');
assert(clientRecording.includes('!ws.socket?.connected'), 'client must suppress alerts while Socket.io is disconnected');
assert(micWatchdog.includes("source: 'watchdog', active: true"), 'ended or muted tracks must raise a persistent warning');
assert(!localStopRecording.includes("mediaRecorder.state === 'inactive') return"), 'an automatically stopped recorder must still clear local recording state');
assert(localStopRecording.includes("if (recorder.state !== 'inactive') recorder.stop()"), 'local stop must tolerate an already inactive recorder');
assert(serverSource.includes("persistRecordingFailure(rec, 'size-too-small'"), 'discarded recording marker is missing');
assert(serverSource.includes('MIX_DEBOUNCE_MS = 20000'), 'mix debounce changed');
assert(callCoreSource.includes('maxBitrate: 650000'));
assert(callCoreSource.includes('maxBitrate: 500000'));
assert(callCoreSource.includes('maxBitrate: 350000'));

const functionStart = serverSource.indexOf('function inferUsernameFromRecordingFilename');
const functionEnd = serverSource.indexOf('async function generateMix', functionStart);
assert(functionStart >= 0 && functionEnd > functionStart, 'mix selection functions not found');

const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surecast-mix-test-'));
try {
  const functionSource = serverSource.slice(functionStart, functionEnd);
  const mixApi = vm.runInNewContext(
    `(() => { ${functionSource}; return { collectSyncGroup }; })()`,
    { fs, path, uploadsDir },
  );

  function addTrack(name, size, sidecar) {
    fs.writeFileSync(path.join(uploadsDir, name), Buffer.alloc(size, 1));
    fs.writeFileSync(path.join(uploadsDir, `${name}.sync.json`), JSON.stringify(sidecar));
  }

  const syncId = 'codex_test_mix';
  addTrack('alice-20260810-120000.flac', 100, { syncId, startEpoch: 1000, username: 'alice' });
  addTrack('alice-20260810-120001-local.flac', 500, { syncId, startEpoch: 1001, username: 'alice' });
  addTrack('bob-20260810-120002.flac', 200, { syncId, startEpoch: 1002 });
  addTrack('bob-20260810-120002-master.flac', 900, { syncId, startEpoch: 1002, username: 'bob' });

  let members = mixApi.collectSyncGroup(syncId);
  assert.strictEqual(members.length, 2, 'normal mix must contain one track per participant');
  assert(members.some(member => member.audioPath.endsWith('alice-20260810-120000.flac')),
    'server track must win when both server and local recordings exist');
  assert(!members.some(member => member.audioPath.includes('-local.flac')),
    'normal mix must not duplicate a participant with the local track');
  assert(members.some(member => member.username === 'bob'), 'legacy sidecar username inference failed');

  fs.unlinkSync(path.join(uploadsDir, 'alice-20260810-120000.flac'));
  members = mixApi.collectSyncGroup(syncId);
  assert.strictEqual(members.length, 2, 'fallback mix must retain all participants');
  assert(members.some(member => member.audioPath.endsWith('alice-20260810-120001-local.flac')),
    'local track must be selected when the server recording is unavailable');
} finally {
  fs.rmSync(uploadsDir, { recursive: true, force: true });
}

console.log('mic-single-regression-ok');
