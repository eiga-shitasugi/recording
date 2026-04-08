export class RecordingCore {
  constructor() {
    this.localRecording = false;
    this.serverRecording = false;
  }

  async startAll({ startLocal, startServer }) {
    await startLocal();
    await startServer();
    this.localRecording = true;
    this.serverRecording = true;
  }

  async stopAll({ stopLocal, stopServer }) {
    await stopLocal();
    await stopServer();
    this.localRecording = false;
    this.serverRecording = false;
  }
}
