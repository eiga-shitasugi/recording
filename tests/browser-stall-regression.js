const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const baseUrl = process.env.SURECAST_URL || 'https://surecast.virtualeigabar.com/';
const selectedPhases = new Set((process.env.SURECAST_PHASES || 'stall,normal,reconnect,failed-join').split(',').map(value => value.trim()));
const suffix = String(Date.now()).slice(-5);
const rooms = {
  stall: `CST${suffix}`,
  normal: `CNM${suffix}`,
  reconnect: `CRN${suffix}`,
  failedJoin: `CFJ${suffix}`,
};
const names = {
  observer: `cdxobs${suffix}`,
  stopped: `cdxstp${suffix}`,
  blocked: `cdxblk${suffix}`,
  muted: `cdxmut${suffix}`,
  normalA: `cdxna${suffix}`,
  normalB: `cdxnb${suffix}`,
  normalLate: `cdxnl${suffix}`,
  reconnectA: `cdxra${suffix}`,
  reconnectB: `cdxrb${suffix}`,
  failed: `cdxfail${suffix}`,
  afterFailed: `cdxafter${suffix}`,
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createQuietRoomWav(filePath, seconds = 300) {
  const sampleRate = 48000;
  const sampleCount = sampleRate * seconds;
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let offset = 44, positive = true; offset < wav.length; offset += 2, positive = !positive) {
    wav.writeInt16LE(positive ? 16 : -16, offset);
  }
  fs.writeFileSync(filePath, wav);
}

class CdpClient {
  constructor(socket, port, targetId) {
    this.socket = socket;
    this.port = port;
    this.targetId = targetId;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        if (message.method === 'Runtime.consoleAPICalled') {
          this.events.push({
            type: message.params.type,
            text: message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' '),
          });
        } else if (message.method === 'Runtime.exceptionThrown') {
          this.events.push({ type: 'exception', text: message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text });
        }
        if (this.events.length > 100) this.events.shift();
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static async connect(target, port) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CdpClient(socket, port, target.id);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result.value;
  }

  async close() {
    try { this.socket.close(); } catch {}
    try { await fetch(`http://127.0.0.1:${this.port}/json/close/${this.targetId}`); } catch {}
  }
}

async function waitForChrome(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

async function waitFor(client, expression, timeoutMs = 20000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await client.evaluate(expression);
      if (lastValue) return lastValue;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)}`);
}

const monitorScript = `(() => {
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__gumLog = [];
  navigator.mediaDevices.getUserMedia = constraints => {
    window.__gumLog.push(JSON.parse(JSON.stringify(constraints)));
    return original(constraints);
  };
})();`;

async function createPage(port, roomId) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const client = await CdpClient.connect(target, port);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: monitorScript });
  await client.send('Page.navigate', { url: `${baseUrl}?room=${roomId}` });
  await waitFor(client, `document.readyState === 'complete'`, 25000, `${roomId} page load`);
  await waitFor(client, `document.getElementById('label-mic')?.textContent.includes('台検出')`, 25000, `${roomId} fake microphone`);
  return client;
}

async function joinRoom(client, username) {
  await client.evaluate(`(() => {
    const input = document.getElementById('username-input');
    input.value = ${JSON.stringify(username)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-join-call').click();
    return true;
  })()`);
  await waitFor(client, `document.getElementById('call-active')?.style.display === 'block'`, 25000, `${username} call join`);
}

async function openUser(port, roomId, username, allPages) {
  const client = await createPage(port, roomId);
  allPages.push(client);
  await joinRoom(client, username);
  return client;
}

function audioAcquisitionCount(log) {
  return log.filter(entry => entry && Object.prototype.hasOwnProperty.call(entry, 'audio')).length;
}

async function startAllRecording(leader, users) {
  await leader.evaluate(`ws.socket.emit('recording-start-all'); true`);
  await waitFor(leader, `document.getElementById('recording-countdown')?.classList.contains('visible')`, 4000, 'recording countdown');
  await Promise.all(users.map((user, index) => waitFor(
    user,
    `srvRecActive && srvRecMR?.state === 'recording' && !document.getElementById('btn-stop').disabled`,
    15000,
    `recording start ${index + 1}`,
  )));
}

async function requestFreshChunk(client) {
  const before = await client.evaluate(`srvRecLastValidChunkAt`);
  await client.evaluate(`(() => { if (srvRecMR?.state === 'recording') srvRecMR.requestData(); return true; })()`);
  await waitFor(client, `srvRecLastValidChunkAt > ${Number(before)}`, 10000, 'fresh valid recording chunk');
}

async function stopAllRecording(leader, users) {
  await leader.evaluate(`ws.socket.emit('recording-stop-all'); true`);
  await Promise.all(users.map((user, index) => waitFor(
    user,
    `document.getElementById('btn-stop').disabled && !srvRecActive`,
    20000,
    `recording stop ${index + 1}`,
  )));
}

async function waitForRecording(username, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}recordings?codex=${Date.now()}`, { cache: 'no-store' });
    const recordings = await response.json();
    const match = recordings.find(item => String(item.name || '').includes(username) && !item.failure);
    if (match) return match;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for saved recording: ${username}`);
}

async function leaveAndClose(users) {
  for (const user of users) {
    try { await user.evaluate(`(() => { if (ws.inCall) leaveCall(); return true; })()`); } catch {}
  }
  await sleep(1000);
  for (const user of users) await user.close();
}

async function peerDiagnostics(client) {
  const state = await client.evaluate(`(() => ({
    socketId: ws.socket?.id || null,
    connected: !!ws.socket?.connected,
    inCall: ws.inCall,
    roomId: ws.roomId,
    wrappers: document.querySelectorAll('.remote-wrapper').length,
    callCorePeers: ws.callCore ? [...ws.callCore.peers.keys()] : [],
    fallbackPeers: Object.keys(ws.peers),
    connectionStates: [...document.querySelectorAll('[id^="peer-state-"]')].map(el => el.textContent),
  }))()`);
  return { ...state, events: client.events.slice(-20) };
}

async function testThreeStalls(port, allPages, result) {
  console.log(`[stall] room=${rooms.stall} opening four participants`);
  const observer = await openUser(port, rooms.stall, names.observer, allPages);
  const stopped = await openUser(port, rooms.stall, names.stopped, allPages);
  const blocked = await openUser(port, rooms.stall, names.blocked, allPages);
  const muted = await openUser(port, rooms.stall, names.muted, allPages);
  const users = [observer, stopped, blocked, muted];

  await Promise.all(users.map(user => waitFor(user, `document.querySelectorAll('.remote-wrapper').length === 3`, 30000, 'four-person video grid')));
  await startAllRecording(observer, users);
  console.log('[stall] recording normally for 30 seconds');
  await sleep(30000);
  for (const user of users) {
    assert(await user.evaluate(`document.getElementById('recording-health-bar').hidden`), 'normal lead-in caused a recording warning');
  }
  await Promise.all(users.map(requestFreshChunk));
  await sleep(2000);

  await blocked.evaluate(`(() => {
    const original = ws.socket.emit;
    window.__surecastOriginalEmit = original;
    window.__blockAudioChunks = true;
    ws.socket.emit = function(event, ...args) {
      if (window.__blockAudioChunks && event === 'audio-stream-chunk') return this;
      return original.call(this, event, ...args);
    };
    return true;
  })()`);
  await muted.evaluate(`(() => {
    const original = ws.socket.emit;
    window.__surecastOriginalEmit = original;
    window.__blockAudioChunks = true;
    ws.socket.emit = function(event, ...args) {
      if (window.__blockAudioChunks && event === 'audio-stream-chunk') return this;
      return original.call(this, event, ...args);
    };
    ws.localStream.getAudioTracks()[0].dispatchEvent(new Event('mute'));
    return true;
  })()`);

  const failureStartedAt = Date.now();
  await stopped.evaluate(`(() => { ws.localStream.getAudioTracks()[0].stop(); return true; })()`);
  console.log('[stall] track.stop, chunk block and mute+chunk block activated');

  const timingEntries = await Promise.all([
    [names.stopped, stopped],
    [names.blocked, blocked],
    [names.muted, muted],
  ].map(async ([username, ownPage]) => {
    await waitFor(observer,
      `document.getElementById('recording-health-messages').textContent.includes(${JSON.stringify(username)})`,
      65000,
      `${username} peer warning`,
    );
    const elapsedMs = Date.now() - failureStartedAt;
    assert(await ownPage.evaluate(`!document.getElementById('recording-health-bar').hidden`), `${username} own persistent warning missing`);
    return [username, elapsedMs];
  }));
  const timings = Object.fromEntries(timingEntries);
  for (const [username, elapsedMs] of timingEntries) {
    assert(elapsedMs >= 45000 && elapsedMs <= 56000, `${username} warning timing was ${elapsedMs}ms`);
  }
  console.log(`[stall] warnings observed: ${JSON.stringify(timings)}`);

  await stopped.evaluate(`recoverMicrophoneFromWarning().then(() => true)`);
  await blocked.evaluate(`(() => { window.__blockAudioChunks = false; srvRecMR.requestData(); return true; })()`);
  await muted.evaluate(`(() => {
    window.__blockAudioChunks = false;
    ws.localStream.getAudioTracks()[0].dispatchEvent(new Event('unmute'));
    srvRecMR.requestData();
    return true;
  })()`);
  await Promise.all(Object.values(names).slice(1, 4).map(username => waitFor(
    observer,
    `!document.getElementById('recording-health-messages').textContent.includes(${JSON.stringify(username)})`,
    30000,
    `${username} peer warning recovery`,
  )));
  console.log('[stall] all three warnings recovered automatically');

  await stopAllRecording(observer, users);
  const saved = await Promise.all([
    waitForRecording(names.stopped),
    waitForRecording(names.blocked),
    waitForRecording(names.muted),
  ]);
  result.stalls = { timingsMs: timings, saved: saved.map(item => item.name) };
  await leaveAndClose(users);
}

async function testNormalThreeMinutes(port, allPages, result) {
  console.log(`[normal] room=${rooms.normal} starting three-minute recording`);
  const first = await openUser(port, rooms.normal, names.normalA, allPages);
  const second = await openUser(port, rooms.normal, names.normalB, allPages);
  await waitFor(first, `document.querySelectorAll('.remote-wrapper').length === 1`, 25000, 'normal 1:1 video');
  await waitFor(first, `[...document.querySelectorAll('[id^="peer-state-"]')].some(el => el.textContent.includes('connected'))`, 25000, 'normal 1:1 WebRTC connection');
  await startAllRecording(first, [first, second]);
  const startedAt = Date.now();
  await sleep(15000);

  const late = await openUser(port, rooms.normal, names.normalLate, allPages);
  const users = [first, second, late];
  await waitFor(late, `srvRecActive && srvRecMR?.state === 'recording'`, 15000, 'late participant auto recording');
  await Promise.all(users.map(user => waitFor(user, `document.querySelectorAll('.remote-wrapper').length === 2`, 25000, 'normal three-person video')));
  await waitFor(first, `document.getElementById('call-quality').textContent.includes('標準')`, 10000, 'three-person quality update');
  const quality = await first.evaluate(`document.getElementById('call-quality').textContent`);
  assert(quality.includes('標準') && quality.includes('20fps'), `unexpected three-person quality: ${quality}`);

  const scriptText = `codex stall regression ${Date.now()}`;
  await first.evaluate(`(() => {
    const textarea = document.getElementById('script-textarea');
    textarea.value = ${JSON.stringify(scriptText)};
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor(second, `document.getElementById('script-textarea').value === ${JSON.stringify(scriptText)}`, 10000, 'normal script synchronization');

  let nextProgress = 30000;
  while (Date.now() - startedAt < 185000) {
    for (const user of users) {
      assert(await user.evaluate(`document.getElementById('recording-health-bar').hidden`), 'three-minute normal recording raised a false warning');
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= nextProgress) {
      console.log(`[normal] ${Math.floor(elapsed / 1000)} seconds, no warning`);
      nextProgress += 30000;
    }
    await sleep(5000);
  }

  const gumCounts = [];
  for (const user of users) {
    const count = audioAcquisitionCount(await user.evaluate(`window.__gumLog`));
    assert.strictEqual(count, 1, 'normal call and recording opened audio more than once');
    gumCounts.push(count);
  }
  await stopAllRecording(first, users);
  await Promise.all(users.map((user, index) => waitForRecording([names.normalA, names.normalB, names.normalLate][index])));

  await second.evaluate(`document.getElementById('speaker-mode').click(); true`);
  await waitFor(second, `!document.getElementById('speaker-mode').disabled && document.getElementById('speaker-mode').checked`, 10000, 'speaker mode after recording');
  assert.strictEqual(await second.evaluate(`document.querySelectorAll('.remote-wrapper').length`), 2, 'speaker mode dropped the call');

  result.normal = {
    durationMs: Date.now() - startedAt,
    noFalseWarning: true,
    lateJoinAutoRecording: true,
    threePersonQuality: quality,
    scriptSync: true,
    audioAcquisitions: gumCounts,
    speakerModeWithoutDrop: true,
  };
  console.log(`[normal] completed ${result.normal.durationMs}ms without warnings`);
  await leaveAndClose(users);
}

async function testReconnect(port, allPages, result) {
  console.log(`[reconnect] room=${rooms.reconnect}`);
  const first = await openUser(port, rooms.reconnect, names.reconnectA, allPages);
  const second = await openUser(port, rooms.reconnect, names.reconnectB, allPages);
  const users = [first, second];
  await startAllRecording(first, users);
  await sleep(8000);
  await Promise.all(users.map(requestFreshChunk));
  await sleep(1500);

  await second.evaluate(`(() => { ws.socket.disconnect(); return true; })()`);
  await waitFor(second, `!ws.socket.connected`, 5000, 'forced Socket.io disconnect');
  const disconnectedAt = Date.now();
  let nextProgress = 15000;
  while (Date.now() - disconnectedAt < 55000) {
    assert(await first.evaluate(`document.getElementById('recording-health-bar').hidden`), 'observer saw a no-data warning during disconnect grace');
    assert(await second.evaluate(`document.getElementById('recording-health-bar').hidden`), 'disconnected recorder saw a no-data warning');
    const elapsed = Date.now() - disconnectedAt;
    if (elapsed >= nextProgress) {
      console.log(`[reconnect] disconnected ${Math.floor(elapsed / 1000)} seconds, no warning`);
      nextProgress += 15000;
    }
    await sleep(5000);
  }

  await second.evaluate(`(() => { ws.socket.connect(); return true; })()`);
  await waitFor(second, `ws.socket.connected`, 15000, 'Socket.io reconnect');
  await waitFor(second, `srvRecActive && srvRecMR?.state === 'recording'`, 15000, 'server recorder continuation');
  try {
    await Promise.all([
      waitFor(first, `document.querySelectorAll('.remote-wrapper').length === 1`, 25000, 'reconnected peer on first page'),
      waitFor(second, `document.querySelectorAll('.remote-wrapper').length === 1`, 25000, 'reconnected peer on second page'),
    ]);
  } catch (error) {
    console.error('[reconnect-diagnostics]', JSON.stringify({
      first: await peerDiagnostics(first),
      second: await peerDiagnostics(second),
    }, null, 2));
    throw error;
  }
  await requestFreshChunk(second);
  await sleep(12000);
  assert(await first.evaluate(`document.getElementById('recording-health-bar').hidden`), 'reconnect raised a recording warning');
  assert(await second.evaluate(`document.getElementById('recording-health-bar').hidden`), 'reconnected recorder retained a warning');

  await stopAllRecording(first, users);
  const saved = await waitForRecording(names.reconnectB);
  result.reconnect = {
    disconnectedMs: Date.now() - disconnectedAt,
    noMisleadingWarning: true,
    resumed: true,
    saved: saved.name,
    size: saved.size,
  };
  console.log(`[reconnect] resumed and saved ${saved.name}`);
  await leaveAndClose(users);
}

async function testFailedJoinCleanup(port, allPages, result) {
  console.log(`[failed-join] room=${rooms.failedJoin}`);
  const failed = await createPage(port, rooms.failedJoin);
  allPages.push(failed);
  await failed.evaluate(`(() => {
    history.pushState = () => { throw new Error('codex forced post-join failure'); };
    const input = document.getElementById('username-input');
    input.value = ${JSON.stringify(names.failed)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-join-call').click();
    return true;
  })()`);
  await waitFor(failed, `!ws.inCall && ws.roomId === null && ws.callCore === null`, 25000, 'failed join cleanup');
  const failedGumCount = audioAcquisitionCount(await failed.evaluate(`window.__gumLog`));
  assert.strictEqual(failedGumCount, 1, 'failed join opened a second audio capture');

  const after = await openUser(port, rooms.failedJoin, names.afterFailed, allPages);
  await sleep(5000);
  assert.strictEqual(await after.evaluate(`document.querySelectorAll('.remote-wrapper').length`), 0, 'failed participant remained as a ghost peer');
  assert.strictEqual(audioAcquisitionCount(await failed.evaluate(`window.__gumLog`)), 1, 'later participant triggered audio capture on failed page');
  result.failedJoin = {
    cleanup: true,
    ghostPeers: 0,
    failedPageAudioAcquisitions: 1,
  };
  console.log('[failed-join] cleanup emitted and no ghost peer remained');
  await leaveAndClose([failed, after]);
}

async function main() {
  assert(fs.existsSync(chromePath), `Chrome not found: ${chromePath}`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'surecast-stall-test-'));
  const profileDir = path.join(tempRoot, 'profile');
  const quietWav = path.join(tempRoot, 'quiet-room.wav');
  createQuietRoomWav(quietWav);
  const port = 9341;
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${quietWav}`,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--no-default-browser-check',
  ], { stdio: 'ignore', windowsHide: true });

  const allPages = [];
  const result = { suffix, rooms, names };
  try {
    await waitForChrome(port);
    if (selectedPhases.has('stall')) await testThreeStalls(port, allPages, result);
    if (selectedPhases.has('normal')) await testNormalThreeMinutes(port, allPages, result);
    if (selectedPhases.has('reconnect')) await testReconnect(port, allPages, result);
    if (selectedPhases.has('failed-join')) await testFailedJoinCleanup(port, allPages, result);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    for (const page of allPages) await page.close();
    chrome.kill();
    await sleep(700);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
