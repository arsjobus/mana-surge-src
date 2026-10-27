import { MatchSession } from '../../src/multiplayer/MatchSession.js';
import { decodeMessage, encodeMessage } from '../../src/multiplayer/MessageCodec.js';
import { SessionCoordinator } from '../../src/multiplayer/SessionCoordinator.js';
import { combatPhase, movePhase } from '../../src/systems/TurnSystem.js';

describe('multiplayer protocol and host authorization', () => {
  it('publishes CPU moves and attacks through the host action callback', async () => {
    const player = { human: false, actionPoints: 1 };
    const published = [];
    const context = {
      players: () => [player], hasLegalMove: () => true, daggerAvailable: () => false,
      document: { getElementById: () => ({ style: {}, disabled: false, textContent: '' }) },
      gameOver: () => false, setDecision: () => {}, updateHUD: () => {},
      getTile: (q, r) => ({ q, r }), executeMove: async () => {}, sleep: async () => {},
      moveDecision: () => ({ type: 'move', troop: { id: 12 }, target: { q: 1, r: -1 } }),
      clearHighlights: () => {}, actionApplied: action => published.push(action)
    };

    await movePhase(context, 0, true);
    expect(published).to.deep.equal([{ type: 'move', troopId: 12, to: { q: 1, r: -1 } }]);

    player.actionPoints = 1;
    context.hasLegalAttack = () => true;
    context.executeAttack = async () => {};
    context.combatDecision = () => ({ type: 'attack', attacker: { id: 12 }, defender: { id: 19 } });
    await combatPhase(context, 0);
    expect(published[1]).to.deep.equal({ type: 'attack', attackerId: 12, defenderId: 19 });
  });

  it('round trips valid protocol messages and rejects malformed or mismatched messages', () => {
    const message = {
      v: 1,
      matchId: 'match_identifier_1234',
      senderSeat: 1,
      seq: 1,
      type: 'actionRequest',
      payload: { type: 'move', troopId: 7, to: { q: 2, r: -1 } }
    };
    const encoded = encodeMessage(message);

    expect(decodeMessage(encoded, { matchId: message.matchId, senderSeat: 1 })).to.deep.equal(message);
    expect(decodeMessage(encoded, { matchId: 'different_match_12345', senderSeat: 1 })).to.equal(null);
    expect(decodeMessage(encoded, { matchId: message.matchId, senderSeat: 2 })).to.equal(null);
    expect(decodeMessage('{"not":"a protocol message"}')).to.equal(null);
  });

  it('authorizes only the assigned guest on its active turn and rejects replayed requests', () => {
    const sent = [];
    const accepted = [];
    const session = new MatchSession({
      role: 'host', localSeat: 0, hostSeat: 0, matchId: 'match_identifier_1234',
      roster: [
        { seat: 0, controller: 'host', name: 'Red' },
        { seat: 1, controller: 'guest', name: 'Blue' },
        { seat: 2, controller: 'cpu', name: 'Green' }
      ],
      sendTo: (...args) => sent.push(args),
      broadcast: (...args) => accepted.push(args)
    });
    const action = { type: 'move', troopId: 7, to: { q: 2, r: -1 } };
    const options = {
      validate: (candidate, seat, phase) => seat === 1 && phase === 'move1' ? candidate : null,
      apply: candidate => ({ moved: candidate.troopId }),
      createSnapshot: () => ({ activeSeat: 1, phase: 'move1', stateVersion: 1 })
    };

    session.setDecision({ seat: 2, phase: 'move1' });
    expect(session.handleActionRequest(1, action, 1, options)).to.deep.include({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(sent[sent.length - 1]).to.deep.equal([1, 'actionRejected', { requestSeq: 1, code: 'NOT_YOUR_TURN' }]);

    session.setDecision({ seat: 1, phase: 'move1' });
    expect(session.handleActionRequest(2, action, 1, options)).to.deep.include({ ok: false, code: 'NOT_YOUR_SEAT' });
    expect(session.handleActionRequest(1, action, 1, options).ok).to.equal(true);
    expect(accepted).to.have.length(1);
    expect(session.handleActionRequest(1, action, 1, options)).to.deep.include({ ok: false, code: 'STALE_STATE' });
  });

  it('rejects actions that are illegal for the current phase or fail game-rule validation', () => {
    const sent = [];
    const session = new MatchSession({
      role: 'host', localSeat: 0, hostSeat: 0, matchId: 'match_identifier_1234',
      roster: [{ seat: 0, controller: 'host' }, { seat: 1, controller: 'guest' }, { seat: 2, controller: 'cpu' }],
      sendTo: (...args) => sent.push(args)
    });
    session.setDecision({ seat: 1, phase: 'combat' });

    const badPhase = session.authorizeRequest(1, { type: 'move', troopId: 7, to: { q: 2, r: -1 } }, 1);
    expect(badPhase).to.deep.include({ ok: false, code: 'WRONG_PHASE' });

    const illegal = session.handleActionRequest(1, { type: 'attack', attackerId: 7, defenderId: 9 }, 1, {
      validate: () => null,
      apply: () => ({ resolved: true }),
      createSnapshot: () => ({ activeSeat: 1, phase: 'combat', stateVersion: 0 })
    });
    expect(illegal).to.deep.include({ ok: false, code: 'ILLEGAL_ACTION' });
    expect(sent[sent.length - 1]).to.deep.equal([1, 'actionRejected', { requestSeq: 1, code: 'ILLEGAL_ACTION' }]);
  });

  it('accepts an authorized Move Phase I request and gives the guest the host snapshot', () => {
    const guestUpdates = [];
    const snapshot = { activeSeat: 1, phase: 'move1', stateVersion: 0, board: 'before' };
    const host = new MatchSession({
      role: 'host', localSeat: 0, hostSeat: 0, matchId: 'match_identifier_1234',
      roster: [{ seat: 0, controller: 'host' }, { seat: 1, controller: 'guest' }, { seat: 2, controller: 'cpu' }],
      broadcast: (type, payload) => guestUpdates.push({ type, payload })
    });
    const guest = new MatchSession({
      role: 'guest', localSeat: 1, hostSeat: 0, matchId: 'match_identifier_1234',
      sendTo: (_seat, type, payload) => { guestUpdates.push({ type, payload }); return true; }
    });
    host.setDecision({ seat: 1, phase: 'move1' });
    guest.acceptSnapshot({ stateVersion: 0, state: snapshot }, () => true);
    const move = { type: 'move', troopId: 7, to: { q: 2, r: -1 } };
    expect(guest.requestAction(move, guest.nextRequestSeq)).to.equal(true);
    const result = host.handleActionRequest(1, move, 1, {
      validate: (action, seat, phase) => seat === 1 && phase === 'move1' ? action : null,
      apply: action => { snapshot.board = `moved:${action.troopId}`; return { type: 'move' }; },
      createSnapshot: () => ({ ...snapshot })
    });

    expect(result.ok).to.equal(true);
    expect(guest.acceptHostUpdate(result.update, state => { Object.assign(snapshot, state); return true; })).to.equal(true);
    expect(snapshot.board).to.equal('moved:7');
    expect(guest.stateVersion).to.equal(1);
    expect(guestUpdates[0].type).to.equal('actionRequest');
  });

  it('accepts an authorized Move Phase II request through the same ordered snapshot path', () => {
    const updates = [];
    const state = { activeSeat: 1, phase: 'move2', stateVersion: 0, moved: false };
    const host = new MatchSession({
      role: 'host', localSeat: 0, hostSeat: 0, matchId: 'match_identifier_1234',
      roster: [{ seat: 0, controller: 'host' }, { seat: 1, controller: 'guest' }, { seat: 2, controller: 'cpu' }],
      broadcast: (type, payload) => updates.push({ type, payload })
    });
    const guest = new MatchSession({
      role: 'guest', localSeat: 1, hostSeat: 0, matchId: 'match_identifier_1234',
      sendTo: (_seat, type, payload) => { updates.push({ type, payload }); return true; }
    });
    host.setDecision({ seat: 1, phase: 'move2' });
    guest.acceptSnapshot({ stateVersion: 0, state: { ...state } }, () => true);
    const move = { type: 'move', troopId: 7, to: { q: 1, r: -2 } };

    expect(guest.requestAction(move, guest.nextRequestSeq)).to.equal(true);
    const result = host.handleActionRequest(1, move, 1, {
      validate: (action, seat, phase) => seat === 1 && phase === 'move2' ? action : null,
      apply: () => { state.moved = true; return { type: 'move' }; },
      createSnapshot: () => ({ ...state })
    });

    expect(result.ok).to.equal(true);
    expect(guest.acceptHostUpdate(result.update, snapshot => { Object.assign(state, snapshot); return true; })).to.equal(true);
    expect(state.moved).to.equal(true);
    expect(guest.stateVersion).to.equal(1);
    expect(updates.map(update => update.type)).to.deep.equal(['actionRequest', 'actionAccepted']);
  });

  it('accepts a guest combat intent and synchronizes the host-resolved outcome', () => {
    const updates = [];
    const state = { activeSeat: 1, phase: 'combat', stateVersion: 0, casualties: [] };
    const host = new MatchSession({
      role: 'host', localSeat: 0, hostSeat: 0, matchId: 'match_identifier_1234',
      roster: [{ seat: 0, controller: 'host' }, { seat: 1, controller: 'guest' }, { seat: 2, controller: 'cpu' }],
      broadcast: (type, payload) => updates.push({ type, payload })
    });
    const guest = new MatchSession({
      role: 'guest', localSeat: 1, hostSeat: 0, matchId: 'match_identifier_1234',
      sendTo: (_seat, type, payload) => { updates.push({ type, payload }); return true; }
    });
    host.setDecision({ seat: 1, phase: 'combat' });
    guest.acceptSnapshot({ stateVersion: 0, state: { ...state } }, () => true);
    const attack = { type: 'attack', attackerId: 7, defenderId: 9 };

    expect(guest.requestAction(attack, guest.nextRequestSeq)).to.equal(true);
    const result = host.handleActionRequest(1, attack, 1, {
      validate: (action, seat, phase) => seat === 1 && phase === 'combat' ? action : null,
      apply: () => { state.casualties = [9]; return { type: 'attack', casualties: [9] }; },
      createSnapshot: () => ({ ...state })
    });

    expect(result.ok).to.equal(true);
    expect(result.update.event).to.deep.equal({ type: 'attack', casualties: [9] });
    expect(guest.acceptHostUpdate(result.update, snapshot => { Object.assign(state, snapshot); return true; })).to.equal(true);
    expect(state.casualties).to.deep.equal([9]);
    expect(guest.stateVersion).to.equal(1);
    expect(updates.map(update => update.type)).to.deep.equal(['actionRequest', 'actionAccepted']);
  });
});

describe('multiplayer session handshake', () => {
  it('assigns the invited guest seat over a deterministic fake transport', () => {
    const matchId = 'match_identifier_1234';
    const received = [];
    const hostPeer = createFakePeer();
    const guestPeer = createFakePeer();
    hostPeer.connect(guestPeer);
    guestPeer.connect(hostPeer);

    const host = new SessionCoordinator({
      role: 'host', matchId, localSeat: 2,
      onMessage: ({ seat, message }) => {
        if (message.type === 'hello') {
          host.sendTo(seat, 'seatAssignment', {
            seat,
            snapshot: { activeSeat: 2, phase: 'spawn', stateVersion: 0 }
          });
        }
      }
    });
    const guest = new SessionCoordinator({
      role: 'guest', matchId, localSeat: 0,
      onMessage: ({ seat, message }) => received.push({ seat, message })
    });
    host.addPeer(0, hostPeer);
    guest.addPeer(2, guestPeer);

    guest.startHandshake(2);

    expect(received).to.have.length(1);
    expect(received[0].seat).to.equal(2);
    expect(received[0].message.type).to.equal('seatAssignment');
    expect(received[0].message.payload.seat).to.equal(0);
    expect(received[0].message.payload.snapshot).to.deep.equal({
      activeSeat: 2, phase: 'spawn', stateVersion: 0
    });
    host.close();
    guest.close();
  });
});

function createFakePeer() {
  return {
    onMessage: null,
    remote: null,
    connect(peer) { this.remote = peer; },
    send(type, payload) {
      this.remote?.onMessage?.({ type, payload, senderSeat: type === 'hello' ? null : 2 });
      return true;
    },
    close() {}
  };
}

describe('multiplayer lobby UI', () => {
  beforeEach(() => {
    cy.visit('/');
    cy.get('#multiplayer-btn').click();
  });

  it('lets the host choose a seat and mark the remaining seats as guest or CPU', () => {
    cy.get('#multiplayer-modal').should('be.visible');
    cy.get('.host-seat-btn[data-seat="2"]').click().should('have.class', 'selected');
    cy.get('.seat-mode[data-seat="2"]').should('be.disabled').and('contain.text', 'Host');
    cy.get('.seat-mode[data-seat="0"]').select('guest');
    cy.get('.seat-mode[data-seat="1"]').select('cpu');
    cy.get('#invite-seat').should('be.enabled').find('option').should('have.length', 1).and('have.value', '0');
    cy.get('#lobby-cancel').click();
    cy.get('#lobby-status').should('have.text', 'Lobby cancelled.');
    cy.get('#lobby-close').click();
    cy.get('#multiplayer-modal').should('not.be.visible');
  });

  it('reports malformed host invite codes without starting a guest session', () => {
    cy.get('#guest-offer').type('not-a-mana-surge-invite');
    cy.get('#guest-prepare-btn').click();
    cy.get('#lobby-status').should('have.text', 'Invalid or unsupported host invite code.');
    cy.get('#guest-seat-confirm').should('not.be.visible');
    cy.get('#guest-join-btn').should('not.be.visible');
  });
});
