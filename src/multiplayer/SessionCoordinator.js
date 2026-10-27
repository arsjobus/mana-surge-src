import { PROTOCOL_VERSION } from './MessageCodec.js';

/** Tracks transport peers and routes protocol messages without owning game rules. */
export class SessionCoordinator {
  constructor({ role, matchId, localSeat, onMessage = () => {}, onPeerState = () => {}, onClose = () => {} }) {
    if (!['host', 'guest'].includes(role)) throw new TypeError('Invalid session role');
    this.role = role;
    this.matchId = matchId;
    this.localSeat = localSeat;
    this.onMessage = onMessage;
    this.onPeerState = onPeerState;
    this.onClose = onClose;
    this.peers = new Map();
    this.closed = false;
    this.helloReceived = new Set();
  }

  addPeer(seat, peer) {
    if (this.closed || !Number.isInteger(seat) || seat < 0 || seat > 2 || seat === this.localSeat || this.peers.has(seat)) throw new Error('Seat is unavailable');
    if (this.role === 'guest' && this.peers.size > 0) throw new Error('A guest connects only to the host');
    this.peers.set(seat, peer);
    peer.onMessage = message => this.handleMessage(seat, message);
    peer.onState = state => this.onPeerState(seat, state);
  }

  handleMessage(seat, message) {
    if (message.type === 'hello') {
      if (this.role !== 'host' || message.senderSeat !== null || this.helloReceived.has(seat)) {
        this.removePeer(seat);
        return;
      }
      if (!message.payload.supportedVersions.includes(PROTOCOL_VERSION)) {
        this.peers.get(seat)?.send('protocolError', { code: 'VERSION_MISMATCH' });
        this.removePeer(seat);
        return;
      }
      this.helloReceived.add(seat);
    } else if (message.type === 'protocolError' && message.payload.code === 'VERSION_MISMATCH') {
      this.removePeer(seat);
      return;
    }
    this.onMessage({ seat, message });
  }

  startHandshake(seat) {
    if (this.role !== 'guest') throw new Error('Only a guest starts the handshake');
    return this.sendTo(seat, 'hello', { supportedVersions: [PROTOCOL_VERSION] });
  }

  sendTo(seat, type, payload) { return this.peers.get(seat)?.send(type, payload) ?? false; }
  broadcast(type, payload) {
    for (const [seat, peer] of this.peers) peer.send(type, payload);
  }

  removePeer(seat) {
    const peer = this.peers.get(seat);
    if (!peer) return;
    this.peers.delete(seat);
    this.helloReceived.delete(seat);
    peer.close();
    this.onPeerState(seat, 'closed');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const seat of [...this.peers.keys()]) this.removePeer(seat);
    this.onClose();
  }
}
