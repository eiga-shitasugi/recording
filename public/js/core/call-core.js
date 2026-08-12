const CALL_AUDIO_MAX_BITRATE = 48000;
const CALL_QUALITY_DEBOUNCE_MS = 1500;
const CALL_QUALITY_PROFILES = [
  { id: 'two', maxParticipants: 2, width: 640, height: 360, maxFramerate: 24, maxBitrate: 650000 },
  { id: 'group', maxParticipants: 4, width: 640, height: 360, maxFramerate: 20, maxBitrate: 500000 },
  { id: 'six', maxParticipants: 6, width: 640, height: 360, maxFramerate: 15, maxBitrate: 350000 },
];

export class CallCore {
  constructor({
    io,
    socket = null,
    getIceConfig,
    getLocalStream,
    onRemoteTrack,
    onPeerStateChange,
    onParticipantsChange,
    onQualityChange,
    onPeerLeft,
    onRoomFull,
  }) {
    this.io = io;
    this.socket = socket;
    this.getIceConfig = getIceConfig;
    this.getLocalStream = getLocalStream;
    this.onRemoteTrack = onRemoteTrack;
    this.onPeerStateChange = onPeerStateChange;
    this.onParticipantsChange = onParticipantsChange;
    this.onQualityChange = onQualityChange;
    this.onPeerLeft = onPeerLeft;
    this.onRoomFull = onRoomFull;
    this.peers = new Map();
    this.pendingCandidates = new Map();
    this._creatingPeers = new Map();
    this.roomId = null;
    this.username = null;
    this.maxParticipants = 6;
    this._boundSocket = null;
    this._qualityTimer = null;
    this.currentQuality = CALL_QUALITY_PROFILES[0];
    this._lastAppliedQualityId = null;
  }

  shouldInitiate(myId, peerId) {
    if (!myId || !peerId) return false;
    return myId > peerId;
  }

  connectSocket(socket = null) {
    if (socket) this.socket = socket;
    if (this.socket) {
      this.bindSocketEvents(this.socket);
      return this.socket;
    }
    this.socket = this.io({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    this.bindSocketEvents(this.socket);
    return this.socket;
  }

  async joinRoom({ roomId, username }) {
    this.roomId = roomId;
    this.username = username;
    const socket = this.connectSocket();
    socket.emit('join-room', { roomId, username });
  }

  bindSocketEvents(socket) {
    if (!socket || this._boundSocket === socket) return;
    this._boundSocket = socket;

    socket.on('room-full', ({ max } = {}) => {
      this.onRoomFull?.(max || this.maxParticipants);
    });

    socket.on('room-peers', async (peers = []) => {
      for (const peerInfo of peers) {
        const peerId = typeof peerInfo === 'string' ? peerInfo : peerInfo.peerId;
        if (!peerId || peerId === socket.id) continue;
        await this.createPeer(peerId, this.shouldInitiate(socket.id, peerId));
      }
      this.notifyParticipants();
    });

    socket.on('peer-joined', async (data) => {
      const peerId = typeof data === 'string' ? data : data.peerId;
      if (!peerId || peerId === socket.id) return;
      await this.createPeer(peerId, this.shouldInitiate(socket.id, peerId));
      this.notifyParticipants();
    });

    socket.on('offer', async ({ from, offer }) => {
      if (!from || !offer) return;
      try {
        const pc = await this.createPeer(from, false);
        if (pc.signalingState !== 'stable') {
          await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        }
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        await this.flushPendingCandidates(from, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.applySenderQuality(pc);
        socket.emit('answer', { to: from, answer });
      } catch (e) {
        console.error('[CallCore] offer failed:', e);
      }
    });

    socket.on('answer', async ({ from, answer }) => {
      const pc = this.peers.get(from);
      if (!pc || !answer) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await this.flushPendingCandidates(from, pc);
      } catch (e) {
        console.error('[CallCore] answer failed:', e);
      }
    });

    socket.on('ice-candidate', async ({ from, candidate }) => {
      if (!from || !candidate) return;
      const pc = this.peers.get(from);
      if (!pc || !pc.remoteDescription) {
        this.queueCandidate(from, candidate);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('[CallCore] ICE candidate ignored:', e);
      }
    });

    socket.on('peer-left', (peerId) => {
      this.removePeer(peerId);
      this.onPeerLeft?.(peerId);
      this.notifyParticipants();
    });
  }

  async createPeer(peerId, isInitiator) {
    const current = this.peers.get(peerId);
    if (current && current.signalingState !== 'closed') return current;

    if (this._creatingPeers.has(peerId)) {
      return this._creatingPeers.get(peerId);
    }

    const promise = (async () => {
      const [iceConfig, localStream] = await Promise.all([
        this.getIceConfig(),
        this.getLocalStream(),
      ]);

      const recheck = this.peers.get(peerId);
      if (recheck && recheck.signalingState !== 'closed') return recheck;

      const pc = new RTCPeerConnection(iceConfig);
      localStream.getTracks().forEach((track) => {
        if ('contentHint' in track) {
          track.contentHint = track.kind === 'video' ? 'detail' : 'speech';
        }
        pc.addTrack(track, localStream);
      });
      this.peers.set(peerId, pc);

      pc.ontrack = (event) => {
        const stream = event.streams?.[0] || new MediaStream([event.track]);
        this.onRemoteTrack?.(peerId, stream, event.track);
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && this.socket) {
          this.socket.emit('ice-candidate', { to: peerId, candidate });
        }
      };

      pc.onconnectionstatechange = () => {
        this.onPeerStateChange?.(peerId, pc.connectionState, pc.iceConnectionState);
        if (pc.connectionState === 'failed') {
          console.warn(`[CallCore] ${peerId} connection failed → restartIce`);
          iceRestartNeeded = true;
          try { pc.restartIce(); } catch {}
        }
      };

      let iceDisconnectTimer = null;
      pc.oniceconnectionstatechange = () => {
        this.onPeerStateChange?.(peerId, pc.connectionState, pc.iceConnectionState);
        if (pc.iceConnectionState === 'disconnected') {
          if (!iceDisconnectTimer) {
            iceDisconnectTimer = setTimeout(() => {
              iceDisconnectTimer = null;
              if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                console.warn('[CallCore] ICE disconnected timeout -> restartIce');
                iceRestartNeeded = true;
                try { pc.restartIce(); } catch {}
              }
            }, 12000);
          }
        } else {
          if (iceDisconnectTimer) { clearTimeout(iceDisconnectTimer); iceDisconnectTimer = null; }
        }
      };

      // ④ イニシエーター側の初回 offer を先に送信（onnegotiationneeded より前）
      //    これにより addTrack による onnegotiationneeded と競合しない
      let iceRestartNeeded = false;

      if (isInitiator) {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        await this.applySenderQuality(pc);
        this.socket.emit('offer', { to: peerId, offer });
      }

      // ⑤ onnegotiationneeded は初回 offer 完了後に登録（ICE 再起動などの将来の再ネゴシエーション専用）
      pc.onnegotiationneeded = async () => {
        if (!isInitiator) return;
        if (!iceRestartNeeded) return;
        iceRestartNeeded = false;
        try {
          if (pc.signalingState !== 'stable') return;
          const offer = await pc.createOffer({ iceRestart: true });
          if (pc.signalingState !== 'stable') return;
          await pc.setLocalDescription(offer);
          await this.applySenderQuality(pc);
          this.socket?.emit('offer', { to: peerId, offer });
          console.log(`[CallCore] ICE restart offer sent to ${peerId}`);
        } catch (e) {
          console.warn('[CallCore] onnegotiationneeded failed:', e);
        }
      };

      return pc;
    })();

    this._creatingPeers.set(peerId, promise);
    try {
      return await promise;
    } finally {
      this._creatingPeers.delete(peerId);
    }
  }

  getQualityProfile(participantCount) {
    return CALL_QUALITY_PROFILES.find(profile => participantCount <= profile.maxParticipants)
      || CALL_QUALITY_PROFILES[CALL_QUALITY_PROFILES.length - 1];
  }

  scheduleQualityUpdate(participantCount) {
    if (this._qualityTimer) clearTimeout(this._qualityTimer);
    this._qualityTimer = setTimeout(() => {
      this._qualityTimer = null;
      this.applyCallQuality(participantCount).catch(error => {
        console.warn('[CallCore] adaptive quality update failed:', error);
      });
    }, CALL_QUALITY_DEBOUNCE_MS);
  }

  async applyCallQuality(participantCount) {
    const profile = this.getQualityProfile(participantCount);
    this.currentQuality = profile;
    if (this._lastAppliedQualityId === profile.id) return;

    try {
      const localStream = await this.getLocalStream();
      const videoTrack = localStream?.getVideoTracks?.()[0];
      if (videoTrack?.readyState === 'live') {
        await videoTrack.applyConstraints({
          width: { ideal: profile.width, max: profile.width },
          height: { ideal: profile.height, max: profile.height },
          frameRate: { ideal: profile.maxFramerate, max: profile.maxFramerate },
        });
      }
    } catch (error) {
      console.warn('[CallCore] video capture quality setting failed:', error);
    }

    await Promise.all([...this.peers.values()].map(pc => this.applySenderQuality(pc, profile)));
    this._lastAppliedQualityId = profile.id;
    this.onQualityChange?.({ ...profile, participantCount });
    console.log(
      `[CallCore] quality=${profile.id} participants=${participantCount} `
      + `${profile.width}x${profile.height}@${profile.maxFramerate} `
      + `video=${profile.maxBitrate} audio=${CALL_AUDIO_MAX_BITRATE}`
    );
  }

  async applySenderQuality(pc, profile = this.currentQuality) {
    const updates = pc.getSenders().map(async (sender) => {
      const kind = sender.track?.kind;
      if (kind !== 'audio' && kind !== 'video') return;

      const params = sender.getParameters();
      if (!params.encodings?.length) {
        console.warn(`[CallCore] ${kind} sender parameters unavailable`);
        return;
      }

      if (kind === 'video') {
        params.encodings[0].maxBitrate = profile.maxBitrate;
        params.encodings[0].maxFramerate = profile.maxFramerate;
        if ('degradationPreference' in params) {
          params.degradationPreference = 'maintain-resolution';
        }
      } else {
        params.encodings[0].maxBitrate = CALL_AUDIO_MAX_BITRATE;
      }

      try {
        await sender.setParameters(params);
      } catch (error) {
        console.warn(`[CallCore] ${kind} sender quality setting failed:`, error);
      }
    });

    await Promise.all(updates);
  }

  queueCandidate(peerId, candidate) {
    if (!this.pendingCandidates.has(peerId)) this.pendingCandidates.set(peerId, []);
    this.pendingCandidates.get(peerId).push(candidate);
  }

  async flushPendingCandidates(peerId, pc) {
    const queued = this.pendingCandidates.get(peerId) || [];
    this.pendingCandidates.delete(peerId);
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('[CallCore] queued ICE candidate ignored:', e);
      }
    }
  }

  restartIce(pc) {
          iceRestartNeeded = true;
    try { pc.restartIce(); } catch {}
  }

  notifyParticipants() {
    const participantCount = this.peers.size + 1;
    this.onParticipantsChange?.(participantCount);
    this.scheduleQualityUpdate(participantCount);
  }

  removePeer(peerId) {
    const pc = this.peers.get(peerId);
    if (pc) pc.close();
    this.peers.delete(peerId);
    this.pendingCandidates.delete(peerId);
    this._creatingPeers.delete(peerId);
  }

  destroy() {
    if (this._qualityTimer) {
      clearTimeout(this._qualityTimer);
      this._qualityTimer = null;
    }
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    this._creatingPeers.clear();
    this.roomId = null;
    this.username = null;
    this.currentQuality = CALL_QUALITY_PROFILES[0];
    this._lastAppliedQualityId = null;
  }
}
