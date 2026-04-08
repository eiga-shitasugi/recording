export class CallCore {
  constructor({ io, getIceConfig, getLocalStream, onRemoteTrack, onPeerStateChange, onParticipantsChange }) {
    this.io = io;
    this.getIceConfig = getIceConfig;
    this.getLocalStream = getLocalStream;
    this.onRemoteTrack = onRemoteTrack;
    this.onPeerStateChange = onPeerStateChange;
    this.onParticipantsChange = onParticipantsChange;

    this.socket = null;
    this.peers = new Map();
    this.roomId = null;
    this.username = null;
    this.maxParticipants = 4;
  }

  shouldInitiate(myId, peerId) {
    if (!myId || !peerId) return false;
    return myId > peerId;
  }

  connectSocket() {
    if (this.socket) return this.socket;
    this.socket = this.io({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    return this.socket;
  }

  async joinRoom({ roomId, username }) {
    this.roomId = roomId;
    this.username = username;
    const socket = this.connectSocket();
    this.bindSocketEvents(socket);
    socket.emit('join-room', { roomId, username });
  }

  bindSocketEvents(socket) {
    if (this._bound) return;
    this._bound = true;

    socket.on('room-peers', async (peers) => {
      for (const peerInfo of peers) {
        const peerId = typeof peerInfo === 'string' ? peerInfo : peerInfo.peerId;
        if (peerId && !this.peers.has(peerId)) {
          await this.createPeer(peerId, this.shouldInitiate(socket.id, peerId));
        }
      }
      this.onParticipantsChange?.(this.peers.size + 1);
    });

    socket.on('peer-joined', async (data) => {
      const peerId = typeof data === 'string' ? data : data.peerId;
      if (peerId && !this.peers.has(peerId)) {
        await this.createPeer(peerId, this.shouldInitiate(socket.id, peerId));
      }
      this.onParticipantsChange?.(this.peers.size + 1);
    });

    socket.on('offer', async ({ from, offer }) => {
      let pc = this.peers.get(from);
      if (!pc) pc = await this.createPeer(from, false);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { to: from, answer });
    });

    socket.on('answer', async ({ from, answer }) => {
      const pc = this.peers.get(from);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('ice-candidate', async ({ from, candidate }) => {
      const pc = this.peers.get(from);
      if (!pc || !candidate) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {}
    });

    socket.on('peer-left', (peerId) => {
      this.removePeer(peerId);
      this.onParticipantsChange?.(this.peers.size + 1);
    });
  }

  async createPeer(peerId, isInitiator) {
    const iceConfig = await this.getIceConfig();
    const pc = new RTCPeerConnection(iceConfig);
    this.peers.set(peerId, pc);

    const localStream = await this.getLocalStream();
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.ontrack = (event) => {
      this.onRemoteTrack?.(peerId, event.streams[0], event.track);
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && this.socket) this.socket.emit('ice-candidate', { to: peerId, candidate });
    };

    pc.onconnectionstatechange = () => {
      this.onPeerStateChange?.(peerId, pc.connectionState, pc.iceConnectionState);
    };

    pc.oniceconnectionstatechange = () => {
      this.onPeerStateChange?.(peerId, pc.connectionState, pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        try { pc.restartIce(); } catch {}
      }
    };

    if (isInitiator) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      this.socket.emit('offer', { to: peerId, offer });
    }

    return pc;
  }

  removePeer(peerId) {
    const pc = this.peers.get(peerId);
    if (pc) pc.close();
    this.peers.delete(peerId);
  }
}
