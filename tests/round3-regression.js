const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { GIB, classifyDiskSpace } = require('../lib/disk-space');

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const recordingsSource = fs.readFileSync(path.join(root, 'public', 'recordings.html'), 'utf8');

function section(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert(start >= 0 && end > start, `section not found: ${startText}`);
  return source.slice(start, end);
}

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

for (const [name, expected] of Object.entries({
  'call-core.js': 'fac976515f64c085382517a186832fbf729c5226fee0e5343954a360dca73641',
  'media-core.js': 'e8b13fae853354d1ae2602d939cfa878a5260d6680855620ebccab0ffeb4cd3f',
  'recording-core.js': 'cae6828843e0c46719e7a088075cea8f20004a4768f2d8ded905f4f321f7f236',
})) {
  const filePath = path.join(root, 'public', 'js', 'core', name);
  if (fs.existsSync(filePath)) {
    assert.strictEqual(hash(filePath), expected, `${name} changed unexpectedly`);
  }
}

assert.strictEqual(classifyDiskSpace(50 * GIB).level, 'ok');
assert.strictEqual(classifyDiskSpace(49.9 * GIB).level, 'warning');
assert.strictEqual(classifyDiskSpace(20 * GIB).level, 'warning');
assert.strictEqual(classifyDiskSpace(19.9 * GIB).level, 'error');
assert.strictEqual(classifyDiskSpace(NaN).level, 'error');

const inlineScripts = [...indexSource.matchAll(/<script(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/gi)];
inlineScripts.forEach((match, index) => new vm.Script(match[1], { filename: `index-inline-${index}.js` }));
const recordingScripts = [...recordingsSource.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
recordingScripts.forEach((match, index) => new vm.Script(match[1], { filename: `recordings-inline-${index}.js` }));

const preflightClient = section(indexSource, 'async function runPreflightCheck', 'async function joinCall()');
assert(preflightClient.includes('await ensureRecordingAudioReady()'), 'preflight must use the shared recording microphone');
assert(!preflightClient.includes('getUserMedia('), 'preflight must not create a separate microphone acquisition route');
assert(preflightClient.includes('audioBitsPerSecond: 128000'), 'preflight bitrate changed');
assert(preflightClient.includes("ws.socket.emit('audio-stream-chunk'"), 'preflight must use the production chunk event');
assert(preflightClient.includes("ws.socket.emit('start-server-recording'"), 'preflight must use the production server start event');
assert(preflightClient.includes("syncClockWithServer({ showWarning: false })"), 'preflight must re-sync immediately before reporting');

assert(serverSource.includes("socket.on('preflight-start'"));
assert(serverSource.includes("socket.on('preflight-report'"));
assert(serverSource.includes("data?.preflight === true && data.checkId"));
assert(serverSource.includes('volumedetect,astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Peak_level'));
assert(serverSource.includes("max_volume:\\s*"));
assert(serverSource.includes("status: digitalSilence ? 'digital-silence' : 'ok'"));
assert(serverSource.includes('PREFLIGHT_MIN_BYTES = 512'));

const pairStart = section(indexSource, 'async function startRecordingPair()', 'function stopServerRecording()');
assert(pairStart.includes('await syncClockWithServer({ showWarning: true })'));
assert(pairStart.includes('startRecording(freshClock)'));
assert(pairStart.includes('startServerRecording(getUserName(), freshClock)'));
assert(indexSource.includes("formData.append('clockSyncOk'"));
assert(serverSource.includes('clockSyncOk: rec.clockSyncOk'));
assert(serverSource.includes('...normalizeClockSyncMeta(data)'));
assert(serverSource.includes("try { sync = JSON.parse(fs.readFileSync(fullPath + '.sync.json'"));
assert(recordingsSource.includes('⚠ 位置合わせ未保証'));

const mixGeneration = section(serverSource, 'async function generateMix(syncId)', '// 同じsyncIdの録音');
assert(mixGeneration.includes('const outputFilename = `MIX-${safeSyncId}.mp3`'));
assert(mixGeneration.includes('fs.renameSync(tempOutputPath, outputPath)'));
assert(mixGeneration.includes("member.source === 'local' ? '[ローカル代替]'"));
assert(mixGeneration.includes('name.startsWith(legacyPrefix)'));
assert(serverSource.includes('queueMixGeneration(syncId)'));

assert(serverSource.includes('fs.statfsSync(uploadsDir)'));
assert(serverSource.includes("reason: 'disk-low'"));
assert(serverSource.includes("reason: 'write-error'"));
assert(indexSource.includes("alert.reason === 'clock-sync'"));
assert(indexSource.includes("alert.reason === 'disk-low'"));
assert(indexSource.includes("alert.reason === 'write-error'"));
assert(indexSource.includes('srvRecMR.start(20000)'));

console.log('round3-regression-ok');
