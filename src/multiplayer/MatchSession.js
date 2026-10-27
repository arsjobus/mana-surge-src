import { isValidActionPayload } from './MessageCodec.js';

/** Game-layer authority and synchronization state, independent of WebRTC. */
export class MatchSession {
  constructor({ role, localSeat, hostSeat, matchId, roster, sendTo = () => {}, broadcast = () => {}, onStatus = () => {} }) {
    if (!['host', 'guest'].includes(role) || !Number.isInteger(localSeat) || !Number.isInteger(hostSeat)) throw new TypeError('Invalid match session');
    this.role = role;
    this.localSeat = localSeat;
    this.hostSeat = hostSeat;
    this.matchId = matchId;
    this.roster = roster;
    this.sendTo = sendTo;
    this.broadcast = broadcast;
    this.onStatus = onStatus;
    this.stateVersion = 0;
    this.activeSeat = hostSeat;
    this.phase = 'start';
    this.pendingRequest = null;
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
    const allowed = this.phase === 'spawn' ? ['spawn'] : ['move', 'move1', 'move2'].includes(this.phase) ? ['move', 'pass', 'sacrifice', 'cancelSacrifice'] : this.phase === 'combat' ? ['attack', 'pass', 'sacrifice', 'cancelSacrifice'] : [];
    if (!allowed.includes(action?.type)) return { ok: false, code: 'WRONG_PHASE' };
    if (!isValidActionPayload(action)) return { ok: false, code: 'ILLEGAL_ACTION' };
    return { ok: true, action, requestSeq };
  }

  publishAccepted(action, event, snapshot) {
    if (this.role !== 'host' || this.ended) return false;
    this.stateVersion++;
    const update = { action, event, stateVersion: this.stateVersion, snapshot: { ...snapshot, stateVersion: this.stateVersion } };
    this.broadcast('actionAccepted', update);
    return update;
  }

  requestAction(action, requestSeq = 1) {
    if (this.role !== 'guest' || this.ended || this.localSeat !== this.activeSeat || !isValidActionPayload(action)) return false;
    this.pendingRequest = requestSeq;
    this.onStatus('Sending action to host…');
    return this.sendTo(this.hostSeat, 'actionRequest', action);
  }

  acceptHostUpdate(message, applySnapshot) {
    if (this.role !== 'guest' || this.ended || !message || message.stateVersion !== this.stateVersion + 1) return false;
    if (!applySnapshot(message.snapshot)) return false;
    this.stateVersion = message.stateVersion;
    this.pendingRequest = null;
    this.onStatus('Synchronized with host');
    return true;
  }

  peerDisconnected(seat) {
    if (this.role === 'guest' && seat === this.hostSeat) {
      this.ended = true;
      this.onStatus('Host disconnected. This match has ended.');
    } else if (this.role === 'host' && this.roster?.[seat]?.controller === 'guest') {
      this.onStatus(`${this.seatName(seat)} disconnected. Retry, replace with CPU, or end the match.`);
    }
  }

  end() { this.ended = true; this.pendingRequest = null; }
}
