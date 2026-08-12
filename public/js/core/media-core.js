export class MediaCore {
  constructor() {
    this.localStream = null;
  }

  setLocalStream(stream) {
    this.localStream = stream;
    return stream;
  }

  async getLocalStream() {
    if (this.localStream && this.localStream.getTracks().some(track => track.readyState === 'live')) {
      return this.localStream;
    }
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

  async attachLocal(videoEl, stream = null) {
    const localStream = stream || await this.getLocalStream();
    this.setLocalStream(localStream);
    if (videoEl.srcObject !== localStream) videoEl.srcObject = localStream;
    videoEl.muted = true;
    videoEl.playsInline = true;
    try { await videoEl.play(); } catch {}
    return localStream;
  }

  async attachRemote(videoEl, stream) {
    if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
    videoEl.playsInline = true;
    try { await videoEl.play(); } catch {}
  }

  stopLocalStream() {
    if (!this.localStream) return;
    this.localStream.getTracks().forEach(track => track.stop());
    this.localStream = null;
  }
}
