const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const baseUrl = process.env.SURECAST_URL || 'https://surecast.virtualeigabar.com/';
const phases = new Set((process.env.ROUND3_PHASES || 'normal,abnormal,clock,mix').split(',').map(value => value.trim()));
const suffix = String(Date.now()).slice(-6);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createMonoWav(filePath, seconds, amplitude) {
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
  for (let sample = 0, offset = 44; offset < wav.length; sample++, offset += 2) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * 997 * sample) / sampleRate));
    wav.writeInt16LE(value, offset);
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
        if (this.events.length > 150) this.events.shift();
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
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
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
  throw new Error(`Chrome DevTools endpoint did not start on ${port}`);
}

async function waitFor(client, expression, timeoutMs = 25000, label = expression) {
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

async function listRecordings() {
  const response = await fetch(`${baseUrl}recordings?round3=${Date.now()}`, { cache: 'no-store' });
  assert(response.ok, `recordings API returned ${response.status}`);
  return response.json();
}

function launchChrome(port, profileDir, wavPath) {
  return spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${wavPath}`,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--no-default-browser-check',
  ], { stdio: 'ignore', windowsHide: true });
}

async function createPage(port, roomId) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const client = await CdpClient.connect(target, port);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Page.navigate', { url: `${baseUrl}?room=${roomId}` });
  await waitFor(client, `document.readyState === 'complete'`, 25000, `${roomId} page load`);
  await waitFor(client, `document.getElementById('label-mic')?.textContent.includes('台検出')`, 25000, `${roomId} fake microphone`);
  return client;
}

async function join(client, username) {
  await client.evaluate(`(() => {
    const input = document.getElementById('username-input');
    input.value = ${JSON.stringify(username)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-join-call').click();
    return true;
  })()`);
  await waitFor(client, `ws.inCall && document.getElementById('call-active')?.style.display === 'block'`, 25000, `${username} join`);
}

async function openUser(port, roomId, username, pages) {
  const page = await createPage(port, roomId);
  pages.push(page);
  await join(page, username);
  return page;
}

async function closeUsers(users) {
  for (const user of users) {
    try { await user.evaluate(`(() => { if (ws.inCall) leaveCall(); return true; })()`); } catch {}
  }
  await sleep(400);
  for (const user of users) await user.close();
}

async function runPreflight(leader, users, label) {
  await leader.evaluate(`ws.socket.emit('preflight-start'); true`);
  await Promise.all(users.map((user, index) => waitFor(
    user,
    `preflightState.latest?.complete && !preflightState.running`,
    30000,
    `${label} result ${index + 1}`,
  )));
  return Promise.all(users.map(user => user.evaluate(`preflightState.latest`)));
}

async function testNormalThree(ports, pages, result) {
  const room = `R3N${suffix}`;
  const names = [`r3na${suffix}`, `r3nb${suffix}`, `r3nc${suffix}`];
  const before = await listRecordings();
  const users = [];
  for (let index = 0; index < names.length; index++) {
    users.push(await openUser(ports[index], room, names[index], pages));
  }
  await Promise.all(users.map(user => waitFor(user, `document.querySelectorAll('.remote-wrapper').length === 2`, 30000, 'three-person grid')));
  const tables = await runPreflight(users[0], users, 'normal three');
  tables.forEach(table => assert(table.allOk, `normal preflight failed: ${JSON.stringify(table)}`));
  assert(tables.every(table => JSON.stringify(table) === JSON.stringify(tables[0])), 'participants did not receive the same preflight table');
  const after = await listRecordings();
  assert.strictEqual(after.length, before.length, 'preflight changed the recordings list');
  result.normal = {
    room,
    names,
    allOk: true,
    sameTable: true,
    recordingsBefore: before.length,
    recordingsAfter: after.length,
    disk: tables[0].disk,
  };
  await closeUsers(users);
  users.forEach(user => pages.splice(pages.indexOf(user), 1));
}

async function testAbnormal(port, pages, mode, expected) {
  const room = `R3${mode.slice(0, 2).toUpperCase()}${suffix}`;
  const name = `r3${mode.slice(0, 3)}${suffix}`;
  const user = await openUser(port, room, name, pages);
  if (mode === 'track-stopped') {
    await user.evaluate(`(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('round3 forced microphone failure'));
      sharedRawStream?.getAudioTracks()[0]?.stop();
      return true;
    })()`);
  } else if (mode === 'chunk-blocked') {
    await user.evaluate(`(() => {
      const original = ws.socket.emit;
      ws.socket.emit = function(event, ...args) {
        if (event === 'audio-stream-chunk' && args[0]?.checkId) return this;
        return original.call(this, event, ...args);
      };
      return true;
    })()`);
  } else if (mode === 'time-sync-blocked') {
    await user.evaluate(`(() => {
      const original = ws.socket.emit;
      ws.socket.emit = function(event, ...args) {
        if (event === 'time-sync') return this;
        return original.call(this, event, ...args);
      };
      return true;
    })()`);
  }
  const [table] = await runPreflight(user, [user], mode);
  const row = table.participants[0];
  for (const [field, value] of Object.entries(expected)) {
    assert.strictEqual(row[field], value, `${mode}: expected ${field}=${value}, got ${JSON.stringify(row)}`);
  }
  await closeUsers([user]);
  pages.splice(pages.indexOf(user), 1);
  return { room, name, row };
}

async function testDigitalSilence(port, pages) {
  const mode = 'digital-silence';
  const room = `R3DS${suffix}`;
  const name = `r3sil${suffix}`;
  const user = await openUser(port, room, name, pages);
  await user.evaluate(`(() => {
    const original = ws.socket.emit;
    let sentZeroWav = false;
    ws.socket.emit = function(event, ...args) {
      if (event === 'audio-stream-chunk' && args[0]?.checkId) {
        if (sentZeroWav) return this;
        sentZeroWav = true;
        const sampleRate = 48000;
        const sampleCount = sampleRate * 3;
        const dataSize = sampleCount * 2;
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);
        const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
        text(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); text(8, 'WAVEfmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, dataSize, true);
        return original.call(this, event, { ...args[0], seq: 1, buf: buffer });
      }
      return original.call(this, event, ...args);
    };
    return true;
  })()`);
  const [table] = await runPreflight(user, [user], mode);
  const row = table.participants[0];
  assert.strictEqual(row.micOk, false, JSON.stringify(row));
  assert.strictEqual(row.audioStatus, 'digital-silence', JSON.stringify(row));
  assert.strictEqual(row.digitalSilence, true, JSON.stringify(row));
  assert(row.audioBytes >= 512, `digital silence did not reach server: ${JSON.stringify(row)}`);
  await closeUsers([user]);
  pages.splice(pages.indexOf(user), 1);
  return { room, name, row };
}

async function testClockFailureRecording(port, pages, result) {
  const room = `R3C${suffix}`;
  const name = `r3clk${suffix}`;
  const user = await openUser(port, room, name, pages);
  await user.evaluate(`(() => {
    const original = ws.socket.emit;
    ws.socket.emit = function(event, ...args) {
      if (event === 'time-sync') return this;
      return original.call(this, event, ...args);
    };
    ws.socket.emit('recording-start-all');
    return true;
  })()`);
  await waitFor(user, `srvRecActive && state.isRecording`, 15000, 'clock failure recording start');
  await waitFor(user, `document.getElementById('recording-health-messages').textContent.includes('位置合わせ')`, 10000, 'clock warning bar');
  await sleep(6500);
  await user.evaluate(`(() => { srvRecMR?.requestData(); ws.socket.emit('recording-stop-all'); return true; })()`);
  await waitFor(user, `!srvRecActive && !state.isRecording`, 15000, 'clock recording stop');

  let matches = [];
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    matches = (await listRecordings()).filter(file => file.name.includes(name) && !file.failure);
    if (matches.length >= 2 && matches.every(file => file.sync?.clockSyncOk === false)) break;
    await sleep(1000);
  }
  assert(matches.length >= 2, `clock test recordings not saved: ${JSON.stringify(matches)}`);
  assert(matches.every(file => file.sync?.clockSyncOk === false), `clock metadata missing: ${JSON.stringify(matches)}`);
  await user.send('Page.navigate', { url: `${baseUrl}recordings.html?round3=${Date.now()}` });
  await waitFor(user, `document.readyState === 'complete'`, 20000, 'recordings page');
  await waitFor(user, `document.body.textContent.includes(${JSON.stringify(name)}) && document.body.textContent.includes('位置合わせ未保証')`, 20000, 'recordings warning badge');
  result.clockFailure = { room, name, files: matches.map(file => file.name), warning: true, badge: true };
  await user.close();
  pages.splice(pages.indexOf(user), 1);
}

async function testDelayedLocalMix(port, pages, result) {
  const room = `R3M${suffix}`;
  const nameA = `r3mixa${suffix}`;
  const nameB = `r3mixb${suffix}`;
  const oldMixNames = (await listRecordings()).filter(file => /^MIX-.*\.mp3$/i.test(file.name)).map(file => file.name);
  const first = await openUser(port, room, nameA, pages);
  const delayed = await openUser(port, room, nameB, pages);
  await waitFor(first, `document.querySelectorAll('.remote-wrapper').length === 1`, 25000, 'mix peer connection');

  await delayed.evaluate(`(() => {
    const originalEmit = ws.socket.emit;
    ws.socket.emit = function(event, ...args) {
      if (event === 'audio-stream-chunk' && !args[0]?.checkId) return this;
      return originalEmit.call(this, event, ...args);
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      if (String(input).includes('/convert-to-flac')) {
        return new Promise((resolve, reject) => {
          window.__releaseRound3Upload = () => originalFetch(input, init).then(resolve, reject);
        });
      }
      return originalFetch(input, init);
    };
    return true;
  })()`);

  await first.evaluate(`ws.socket.emit('recording-start-all'); true`);
  await Promise.all([first, delayed].map(user => waitFor(user, `srvRecActive && state.isRecording`, 15000, 'mix recording start')));
  const syncId = await first.evaluate(`ws.syncId`);
  await sleep(7000);
  await first.evaluate(`(() => { srvRecMR?.requestData(); ws.socket.emit('recording-stop-all'); return true; })()`);
  await Promise.all([first, delayed].map(user => waitFor(user, `!srvRecActive && !state.isRecording`, 15000, 'mix recording stop')));
  const stoppedAt = Date.now();
  const stableName = `MIX-${String(syncId).replace(/[^a-zA-Z0-9_-]/g, '_')}.mp3`;

  let initialMix = null;
  const firstMixDeadline = Date.now() + 55000;
  while (Date.now() < firstMixDeadline) {
    initialMix = (await listRecordings()).find(file => file.name === stableName) || null;
    if (initialMix) break;
    await sleep(1000);
  }
  assert(initialMix, `initial stable mix was not generated: ${stableName}`);
  const delayRemaining = Math.max(0, 61000 - (Date.now() - stoppedAt));
  await sleep(delayRemaining);
  await delayed.evaluate(`(() => { window.__releaseRound3Upload?.(); return true; })()`);

  let delayedLocal = null;
  let finalMix = null;
  const finalDeadline = Date.now() + 90000;
  while (Date.now() < finalDeadline) {
    const files = await listRecordings();
    delayedLocal = files.find(file => file.name.includes(nameB) && /-local\.flac$/i.test(file.name)) || null;
    finalMix = files.find(file => file.name === stableName && new Date(file.mtime) > new Date(initialMix.mtime)) || null;
    if (delayedLocal && finalMix) break;
    await sleep(1000);
  }
  assert(delayedLocal, 'delayed local upload did not complete');
  assert(finalMix, 'stable mix was not replaced after delayed local upload');
  const afterFiles = await listRecordings();
  const sameSyncMixes = afterFiles.filter(file => file.name === stableName || file.name.startsWith(`MIX-${String(syncId).replace(/[^a-zA-Z0-9_-]/g, '_')}-`));
  assert.strictEqual(sameSyncMixes.length, 1, `more than one mix remains for syncId: ${JSON.stringify(sameSyncMixes)}`);
  const afterMixNames = afterFiles.filter(file => /^MIX-.*\.mp3$/i.test(file.name)).map(file => file.name);
  oldMixNames.forEach(name => assert(afterMixNames.includes(name), `unrelated old mix was removed: ${name}`));
  result.delayedMix = {
    room,
    names: [nameA, nameB],
    syncId,
    stableName,
    delayMs: Date.now() - stoppedAt,
    oneMix: true,
    oldMixesPreserved: oldMixNames.length,
    delayedLocal: delayedLocal.name,
  };
  await closeUsers([first, delayed]);
  pages.splice(pages.indexOf(first), 1);
  pages.splice(pages.indexOf(delayed), 1);
}

async function main() {
  assert(fs.existsSync(chromePath), `Chrome not found: ${chromePath}`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'surecast-round3-test-'));
  const quietWav = path.join(tempRoot, 'quiet.wav');
  const silentWav = path.join(tempRoot, 'silent.wav');
  createMonoWav(quietWav, 240, 64);
  createMonoWav(silentWav, 30, 0);
  const quietPort = 9351;
  const silentPort = 9352;
  const quietPortB = 9353;
  const quietPortC = 9354;
  const quietChrome = launchChrome(quietPort, path.join(tempRoot, 'quiet-profile'), quietWav);
  const silentChrome = launchChrome(silentPort, path.join(tempRoot, 'silent-profile'), silentWav);
  const quietChromeB = launchChrome(quietPortB, path.join(tempRoot, 'quiet-profile-b'), quietWav);
  const quietChromeC = launchChrome(quietPortC, path.join(tempRoot, 'quiet-profile-c'), quietWav);
  const pages = [];
  const result = { suffix };
  const recordingCountBefore = (await listRecordings()).length;

  try {
    await Promise.all([waitForChrome(quietPort), waitForChrome(silentPort), waitForChrome(quietPortB), waitForChrome(quietPortC)]);
    if (phases.has('normal')) {
      console.log('[round3] normal three-person preflight');
      await testNormalThree([quietPort, quietPortB, quietPortC], pages, result);
    }
    if (phases.has('abnormal')) {
      console.log('[round3] four abnormal preflight scenarios');
      result.abnormal = {};
      result.abnormal.trackStopped = await testAbnormal(quietPort, pages, 'track-stopped', { micOk: false });
      result.abnormal.chunkBlocked = await testAbnormal(quietPort, pages, 'chunk-blocked', { serverReachOk: false });
      result.abnormal.timeSyncBlocked = await testAbnormal(quietPort, pages, 'time-sync-blocked', { clockSyncOk: false, clockRttMs: null });
      result.abnormal.digitalSilence = await testDigitalSilence(silentPort, pages);
    }
    if (phases.has('normal') || phases.has('abnormal')) {
      const afterPreflightCount = (await listRecordings()).length;
      assert.strictEqual(afterPreflightCount, recordingCountBefore, 'preflight scenarios created recording list entries');
      result.preflightRecordingCount = { before: recordingCountBefore, after: afterPreflightCount };
    }
    if (phases.has('clock')) {
      console.log('[round3] clock failure recording');
      await testClockFailureRecording(quietPort, pages, result);
    }
    if (phases.has('mix')) {
      console.log('[round3] delayed local fallback mix');
      await testDelayedLocalMix(quietPort, pages, result);
    }
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    for (const page of pages) await page.close();
    quietChrome.kill();
    silentChrome.kill();
    quietChromeB.kill();
    quietChromeC.kill();
    await sleep(700);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
