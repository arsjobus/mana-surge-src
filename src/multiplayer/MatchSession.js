import { isValidActionPayload } from './MessageCodec.js';

/** Game-layer authority and synchronization state, independent of WebRTC. */
export class MatchSession {
  constructor({ role, localSeat, hostSeat, matchId, roster, sendTo = () => {}, broadcast = () => {}, onStatus = () => {}, onEnd = () => {}, onGuestDisconnect = () => {} }) {
    if (!['host', 'guest'].includes(role) || !Number.isInteger(localSeat) || !Number.isInteger(hostSeat)) throw new TypeError('Invalid match session');
    this.role = role;
    this.localSeat = localSeat;
    this.hostSeat = hostSeat;
    this.matchId = matchId;
    this.roster = roster;
    this.sendTo = sendTo;
    this.broadcast = broadcast;
    this.onStatus = onStatus;
    this.onEnd = onEnd;
    this.onGuestDisconnect = onGuestDisconnect;
    this.stateVersion = 0;
    this.activeSeat = hostSeat;
    this.phase = 'start';
    this.pendingRequest = null;
    this.nextRequestSeq = 1;
    this.lastRequestSeq = new Map();
    this.ended = false;
  }

  setDecision({ seat, phase }) {
    this.activeSeat = seat;
    this.phase = phase;
    if (this.role === 'guest') this.onStatus(seat === this.localSeat ? 'Your turn' : `Waiting for ${this.seatName(seat)}`);
  }

  seatName(seat) { return this.roster?.[seat]?.name || `Seat ${seat + 1}`; }

  /** Convert shared game data to a stable, Phaser-free snapshot projection. */
  createSnapshot(state, phase = this.phase) {
    return {
      phase,
      activeSeat: this.activeSeat,
      winScore: state.winScore,
      players: state.players.map(({ name, colorHex, human, mana, actionPoints, spawner }) => ({ name, colorHex, human, mana, actionPoints, spawner: { q: spawner.q, r: spawner.r } })),
      tiles: [...state.tiles.values()].map(({ q, r, type, occupantId }) => ({ q, r, type, occupantId })).sort((a, b) => a.q - b.q || a.r - b.r),
      troops: state.troops.map(({ id, owner, q, r }) => ({ id, owner, q, r })).sort((a, b) => a.id - b.id),
      nextTroopId: state.nextTroopId,
      stateVersion: this.stateVersion
    };
  }

  authorizeRequest(senderSeat, action, requestSeq) {
    if (this.role !== 'host' || this.ended) return { ok: false, code: 'ILLEGAL_ACTION' };
    if (!this.roster?.[senderSeat] || senderSeat !== this.roster[senderSeat].seat || this.roster[senderSeat].controller !== 'guest') return { ok: false, code: 'NOT_YOUR_SEAT' };
    if (senderSeat !== this.activeSeat) return { ok: false, code: 'NOT_YOUR_TURN' };
    if (!Number.isSafeInteger(requestSeq) || requestSeq !== (this.lastRequestSeq.get(senderSeat) || 0) + 1) return { ok: false, code: 'STALE_STATE' };
    const allowed = this.phase === 'spawn' ? ['spawn'] : ['move', 'move1', 'move2'].includes(this.phase) ? ['move', 'pass', 'sacrifice', 'cancelSacrifice'] : this.phase === 'combat' ? ['attack', 'pass', 'sacrifice', 'cancelSacrifice'] : [];
    if (!allowed.includes(action?.type)) return { ok: false, code: 'WRONG_PHASE' };
    if (!isValidActionPayload(action)) return { ok: false, code: 'ILLEGAL_ACTION' };
    this.lastRequestSeq.set(senderSeat, requestSeq);
    return { ok: true, action, requestSeq };
  }

  publishAccepted(action, event, snapshot) {
    if (this.role !== 'host' || this.ended) return false;
    this.stateVersion++;
    const update = { action, event, stateVersion: this.stateVersion, snapshot: { ...snapshot, stateVersion: this.stateVersion } };
    this.broadcast('actionAccepted', update);
    return update;
  }

  /** Validate and commit a guest intent through caller-supplied game rules. */
  handleActionRequest(senderSeat, action, requestSeq, { validate, apply, createSnapshot }) {
    const authorization = this.authorizeRequest(senderSeat, action, requestSeq);
    if (!authorization.ok) {
      this.sendTo(senderSeat, 'actionRejected', { requestSeq, code: authorization.code });
      return authorization;
    }
    if (typeof validate !== 'function' || typeof apply !== 'function' || typeof createSnapshot !== 'function') {
      return { ok: false, code: 'ILLEGAL_ACTION' };
    }
    const checked = validate(action, senderSeat, this.phase);
    if (!checked) {
      this.sendTo(senderSeat, 'actionRejected', { requestSeq, code: 'ILLEGAL_ACTION' });
      return { ok: false, code: 'ILLEGAL_ACTION' };
    }
    // The caller applies only a fully validated intent and returns a host-owned
    // event describing any resolved outcome (including combat casualties).
    const event = apply(checked, senderSeat);
    if (!event) {
      this.sendTo(senderSeat, 'actionRejected', { requestSeq, code: 'ILLEGAL_ACTION' });
      return { ok: false, code: 'ILLEGAL_ACTION' };
    }
    const update = this.publishAccepted(action, event, createSnapshot());
    return update ? { ok: true, update } : { ok: false, code: 'ILLEGAL_ACTION' };
  }

  /** Host-only phase/turn snapshots are used to recover guests after a gap. */
  publishSnapshot(snapshot, hash = '') {
    if (this.role !== 'host' || this.ended || !snapshot || snapshot.activeSeat !== this.activeSeat || snapshot.phase !== this.phase) return false;
    this.broadcast('snapshot', { stateVersion: this.stateVersion, state: snapshot, hash });
    return true;
  }

  acceptSnapshot(message, applySnapshot) {
    if (this.role !== 'guest' || this.ended || !message ||
      !Number.isSafeInteger(message.stateVersion) || message.stateVersion < this.stateVersion ||
      !message.state || message.state.stateVersion !== message.stateVersion ||
      !Number.isInteger(message.state.activeSeat) || message.state.activeSeat < 0 || message.state.activeSeat > 2 ||
      !['start', 'spawn', 'move1', 'combat', 'move2', 'end', 'gameOver'].includes(message.state.phase)) return false;
    if (!applySnapshot(message.state)) return false;
    this.stateVersion = message.stateVersion;
    this.activeSeat = message.state.activeSeat;
    this.phase = message.state.phase;
    this.pendingRequest = null;
    this.onStatus(this.activeSeat === this.localSeat ? 'Your turn' : `Waiting for ${this.seatName(this.activeSeat)}`);
    return true;
  }

  requestAction(action, requestSeq = 1) {
    if (this.role !== 'guest' || this.ended || this.localSeat !== this.activeSeat || !isValidActionPayload(action)) return false;
    if (this.pendingRequest !== null || requestSeq !== this.nextRequestSeq) return false;
    this.pendingRequest = requestSeq;
    this.onStatus('Sending action to host…');
    const sent = this.sendTo(this.hostSeat, 'actionRequest', action);
    if (!sent) this.pendingRequest = null;
    return sent === true;
  }

  acceptHostUpdate(message, applySnapshot) {
    if (this.role !== 'guest' || this.ended || !message || message.stateVersion !== this.stateVersion + 1 ||
      !message.snapshot || message.snapshot.stateVersion !== message.stateVersion ||
      !Number.isInteger(message.snapshot.activeSeat) || message.snapshot.activeSeat < 0 || message.snapshot.activeSeat > 2 ||
      !['start', 'spawn', 'move1', 'combat', 'move2', 'end', 'gameOver'].includes(message.snapshot.phase)) return false;
    if (!applySnapshot(message.snapshot)) return false;
    this.stateVersion = message.stateVersion;
    this.activeSeat = message.snapshot.activeSeat;
    this.phase = message.snapshot.phase;
    this.pendingRequest = null;
    this.nextRequestSeq++;
    this.onStatus(this.activeSeat === this.localSeat ? 'Your turn' : `Waiting for ${this.seatName(this.activeSeat)}`);
    return true;
  }

  peerDisconnected(seat) {
    if (this.ended) return;
    if (this.role === 'guest' && seat === this.hostSeat) {
      this.ended = true;
      this.onStatus('Host disconnected. This match has ended.');
      this.onEnd({ reason: 'hostDisconnected' });
    } else if (this.role === 'host' && this.roster?.[seat]?.controller === 'guest') {
      this.onStatus(`${this.seatName(seat)} disconnected. Retry, replace with CPU, or end the match.`);
      this.onGuestDisconnect({ seat, name: this.seatName(seat) });
    }
  }

  replaceDisconnectedGuest(seat) {
    if (this.role !== 'host' || this.ended || this.roster?.[seat]?.controller !== 'guest') return false;
    this.roster[seat] = { ...this.roster[seat], controller: 'cpu' };
    this.onStatus(`${this.seatName(seat)} is now controlled by the CPU.`);
    return true;
  }

  endForGuestDisconnect(seat) {
    if (this.role !== 'host' || this.ended || this.roster?.[seat]?.controller !== 'guest') return false;
    this.ended = true;
    this.pendingRequest = null;
    this.onStatus('The match ended after a guest disconnected.');
    this.onEnd({ reason: 'guestDisconnected', seat });
    return true;
  }

  end() { this.ended = true; this.pendingRequest = null; }
}
