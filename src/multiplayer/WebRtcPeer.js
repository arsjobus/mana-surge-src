import { decodeMessage, encodeMessage, MAX_ACTIONS_PER_WINDOW, MAX_MESSAGE_BYTES, MAX_MESSAGES_PER_WINDOW, RATE_WINDOW_MS } from './MessageCodec.js';

const DEFAULT_ICE_SERVERS = [];

/** One reliable, ordered host-to-guest WebRTC data channel. */
export class WebRtcPeer {
  constructor({ role, matchId, localSeat, remoteSeat, iceServers = DEFAULT_ICE_SERVERS, onMessage = () => {}, onState = () => {}, onError = () => {} }) {
    if (!['host', 'guest'].includes(role) || typeof RTCPeerConnection === 'undefined') throw new Error('WebRTC is unavailable');
    this.role = role;
    this.matchId = matchId;
    this.localSeat = localSeat;
    this.remoteSeat = remoteSeat;
    this.onMessage = onMessage;
    this.onState = onState;
    this.onError = onError;
    this.pc = new RTCPeerConnection({ iceServers });
    this.channel = null;
    this.sendSeq = 0;
    this.receiveSeq = 0;
    this.messageTimes = [];
    this.actionTimes = [];
    this.closed = false;
    this.pc.onconnectionstatechange = () => this.onState(this.pc.connectionState);
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') this.onState('failed');
    };
    this.pc.ondatachannel = event => this.attachChannel(event.channel);
  }

  attachChannel(channel) {
    if (this.channel || channel.label !== 'mana-surge-v1' || channel.ordered !== true) {
      channel.close();
      this.onError(new Error('Unexpected data channel'));
      return;
    }
    this.channel = channel;
    channel.onopen = () => this.onState('connected');
    channel.onclose = () => this.onState('closed');
    channel.onerror = () => this.onError(new Error('Data channel error'));
    channel.onmessage = event => this.receive(event.data);
  }

  async createOffer() {
    if (this.role !== 'host') throw new Error('Only a host creates offers');
    this.attachChannel(this.pc.createDataChannel('mana-surge-v1', { ordered: true }));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitForIceGathering();
    return { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp };
  }

  async acceptOffer(offer) {
    if (this.role !== 'guest' || offer?.type !== 'offer') throw new Error('Invalid host offer');
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.waitForIceGathering();
    return { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp };
  }

  async acceptAnswer(answer) {
    if (this.role !== 'host' || answer?.type !== 'answer') throw new Error('Invalid guest answer');
    await this.pc.setRemoteDescription(answer);
  }

  waitForIceGathering() {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    this.onState('connecting');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('ICE gathering timed out')), 20_000);
      const listener = () => { if (this.pc.iceGatheringState === 'complete') finish(); };
      const finish = error => {
        clearTimeout(timeout);
        this.pc.removeEventListener('icegatheringstatechange', listener);
        error ? reject(error) : resolve();
      };
      this.pc.addEventListener('icegatheringstatechange', listener);
    });
  }

  send(type, payload) {
    if (this.closed || this.channel?.readyState !== 'open') return false;
    const message = { v: 1, matchId: this.matchId, senderSeat: type === 'hello' ? null : this.localSeat, seq: ++this.sendSeq, type, payload };
    const data = encodeMessage(message);
    if (new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES) throw new RangeError('Multiplayer message is too large');
    this.channel.send(data);
    return true;
  }

  receive(data) {
    const now = Date.now();
    this.messageTimes = this.messageTimes.filter(time => now - time < RATE_WINDOW_MS);
    this.actionTimes = this.actionTimes.filter(time => now - time < RATE_WINDOW_MS);
    if (typeof data !== 'string' || new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES) return this.protocolError('MESSAGE_TOO_LARGE');
    if (this.messageTimes.length >= MAX_MESSAGES_PER_WINDOW) return this.protocolError('INVALID_MESSAGE');
    const message = decodeMessage(data, { matchId: this.matchId, senderSeat: this.remoteSeat });
    if (!message || message.seq !== this.receiveSeq + 1) return this.protocolError('INVALID_MESSAGE');
    this.messageTimes.push(now);
    this.receiveSeq = message.seq;
    if (message.type === 'actionRequest') {
      if (this.actionTimes.length >= MAX_ACTIONS_PER_WINDOW) return this.onMessage({ ...message, rateLimited: true });
      this.actionTimes.push(now);
    }
    this.onMessage(message);
  }

  protocolError(code) {
    try { this.send('protocolError', { code }); } catch { /* Close below if the peer cannot be notified. */ }
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.channel) {
      this.channel.onopen = this.channel.onclose = this.channel.onerror = this.channel.onmessage = null;
      this.channel.close();
    }
    this.pc.onconnectionstatechange = this.pc.oniceconnectionstatechange = this.pc.ondatachannel = null;
    this.pc.close();
    this.onState('closed');
  }
}
