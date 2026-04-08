export class MediaCore {
  constructor() {
    this.localStream = null;
  }

  async getLocalStream() {
    if (this.localStream) return this.localStream;
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
        channelCount: 1,
      },
      video: {
        width: { ideal: 320, max: 640 },
        height: { ideal: 180, max: 360 },
        frameRate: { ideal: 8, max: 10 },
        facingMode: 'user'
      }
    });
    return this.localStream;
  }

  async attachLocal(videoEl) {
    const stream = await this.getLocalStream();
    videoEl.srcObject = stream;
    try { await videoEl.play(); } catch {}
    return stream;
  }

  async attachRemote(videoEl, stream) {
    videoEl.srcObject = stream;
    try { await videoEl.play(); } catch {}
  }
}
