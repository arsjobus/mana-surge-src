import { decodeMessage, encodeMessage, MAX_ACTIONS_PER_WINDOW, MAX_MESSAGE_BYTES, MAX_MESSAGES_PER_WINDOW, RATE_WINDOW_MS } from './MessageCodec.js';

/**
 * STUN servers let two browsers on different networks learn their public
 * address. Without any, only LAN candidates exist and a guest outside the
 * host's network can never connect (the host then waits forever). STUN only
 * answers "what is my public address?"; it never carries game traffic.
 *
 * Set `globalThis.MANA_SURGE_ICE_SERVERS` before loading the game to replace
 * this list or to add a TURN relay for networks where direct connections fail.
 */
export const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' }
];
export const ICE_GATHER_TIMEOUT_MS = 5_000;
export const CONNECT_TIMEOUT_MS = 30_000;

function configuredIceServers() {
  const configured = globalThis.MANA_SURGE_ICE_SERVERS;
  return Array.isArray(configured) ? configured : DEFAULT_ICE_SERVERS;
}

/**
 * One reliable, ordered host-to-guest WebRTC data channel.
 *
 * State events (`onState` and listeners added with `addStateListener`):
 * `gathering`, `connecting`, `connected` (data channel open; emitted once),
 * `recovered` (came back after `disconnected`), `disconnected`, `failed`
 * (second argument is a human-readable reason) and `closed`.
 */
export class WebRtcPeer {
  constructor({ role, matchId, localSeat, remoteSeat, iceServers = configuredIceServers(),
    connectTimeoutMs = CONNECT_TIMEOUT_MS, gatherTimeoutMs = ICE_GATHER_TIMEOUT_MS,
    onMessage = () => {}, onState = () => {}, onError = () => {} }) {
    if (!['host', 'guest'].includes(role) || typeof RTCPeerConnection === 'undefined') throw new Error('WebRTC is unavailable');
    this.role = role;
    this.matchId = matchId;
    this.localSeat = localSeat;
    this.remoteSeat = remoteSeat;
    this.onMessage = onMessage;
    this.onState = onState;
    this.onError = onError;
    this.iceServerCount = iceServers.length;
    this.connectTimeoutMs = connectTimeoutMs;
    this.gatherTimeoutMs = gatherTimeoutMs;
    this.stateListeners = new Set();
    this.candidateTypes = { host: 0, srflx: 0, relay: 0 };
    this.lastState = 'new';
    this.failureReason = '';
    this.connectTimer = null;
    this.opened = false;
    this.failed = false;
    this.pc = new RTCPeerConnection({ iceServers });
    this.channel = null;
    this.sendSeq = 0;
    this.receiveSeq = 0;
    this.messageTimes = [];
    this.actionTimes = [];
    this.closed = false;
    this.pc.onicecandidate = event => this.countCandidate(event.candidate);
    this.pc.onconnectionstatechange = () => this.handleConnectionState();
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') this.fail();
    };
    this.pc.ondatachannel = event => this.attachChannel(event.channel);
  }

  /** True while the data channel can carry messages. */
  get isOpen() { return !this.closed && this.channel?.readyState === 'open'; }

  /** Listen for state changes without being displaced when `onState` is reassigned. */
  addStateListener(listener) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  emitState(state, detail) {
    this.lastState = state;
    for (const listener of [...this.stateListeners]) {
      try { listener(state, detail); } catch (error) { console.error(error); }
    }
    this.onState(state, detail);
  }

  /** Resolve once the data channel is open; reject on failure, close or timeout. */
  waitForOpen(timeoutMs = this.connectTimeoutMs) {
    if (this.isOpen) return Promise.resolve(this);
    if (this.closed) return Promise.reject(new Error('The connection was closed.'));
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = error => {
        clearTimeout(timer);
        unsubscribe();
        error ? reject(error) : resolve(this);
      };
      const timer = setTimeout(() => finish(new Error('Timed out waiting for the direct connection.')), timeoutMs);
      unsubscribe = this.addStateListener((state, detail) => {
        if (state === 'connected' || state === 'recovered') finish();
        else if (state === 'failed') finish(new Error(detail || this.failureReason || 'The connection failed.'));
        else if (state === 'closed') finish(new Error('The connection was closed.'));
      });
    });
  }

  countCandidate(candidate) {
    const type = /\styp\s(host|srflx|prflx|relay)/.exec(candidate?.candidate || '')?.[1];
    if (type === 'prflx') return;
    if (type) this.candidateTypes[type]++;
  }

  handleConnectionState() {
    const value = this.pc.connectionState;
    if (value === 'failed') return this.fail();
    // `connected` is reported once, when the data channel opens, so consumers
    // that start a handshake on it never see it twice.
    if (value === 'connected') {
      if (this.opened && this.lastState === 'disconnected') this.emitState('recovered');
      return;
    }
    if (value === 'connecting' || value === 'disconnected') this.emitState(value);
  }

  describeFailure() {
    const { srflx, relay } = this.candidateTypes;
    if (!this.iceServerCount) return 'No STUN or TURN server is configured, so only players on the same network can connect.';
    if (relay) return 'The connection failed even through the relay. Check the TURN server settings.';
    if (!srflx) return 'No public network address could be found. STUN may be blocked by a firewall, VPN, or browser privacy setting.';
    return 'The two players could not reach each other directly (strict NAT or firewall). A TURN relay is needed for this pair of networks.';
  }

  fail(reason = this.describeFailure()) {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.failureReason = reason;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.emitState('failed', reason);
    this.onError(new Error(reason));
  }

  /** Give up (and release the connection) if the channel does not open in time. */
  startConnectTimer() {
    if (this.opened || this.closed || this.connectTimer) return;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.opened || this.closed) return;
      this.fail();
      this.close();
    }, this.connectTimeoutMs);
  }

  markOpen() {
    if (this.closed || this.opened) return;
    this.opened = true;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.emitState('connected');
  }

  attachChannel(channel) {
    if (this.channel || channel.label !== 'mana-surge-v1' || channel.ordered !== true) {
      channel.close();
      this.onError(new Error('Unexpected data channel'));
      return;
    }
    this.channel = channel;
    channel.onopen = () => this.markOpen();
    channel.onclose = () => { if (!this.closed) this.emitState('closed'); };
    channel.onerror = () => this.onError(new Error('Data channel error'));
    channel.onmessage = event => this.receive(event.data);
    // Some browsers hand over a channel that is already open.
    if (channel.readyState === 'open') queueMicrotask(() => this.markOpen());
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
    this.startConnectTimer();
    return { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp };
  }

  async acceptAnswer(answer) {
    if (this.role !== 'host' || answer?.type !== 'answer') throw new Error('Invalid guest answer');
    await this.pc.setRemoteDescription(answer);
    this.startConnectTimer();
  }

  /**
   * Candidates are sent with the offer/answer (no trickle), so wait for them.
   * If gathering stalls (an unreachable STUN server can take a long time) use
   * whatever was found instead of failing: LAN candidates still work locally.
   */
  waitForIceGathering() {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    this.emitState('gathering');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const found = /^a=candidate:/m.test(this.pc.localDescription?.sdp || '');
        finish(found ? null : new Error('No network candidates were found. Check your network connection.'));
      }, this.gatherTimeoutMs);
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
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (this.channel) {
      this.channel.onopen = this.channel.onclose = this.channel.onerror = this.channel.onmessage = null;
      this.channel.close();
    }
    this.pc.onconnectionstatechange = this.pc.oniceconnectionstatechange = this.pc.ondatachannel = this.pc.onicecandidate = null;
    this.pc.close();
    this.emitState('closed');
  }
}
