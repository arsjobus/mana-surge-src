import { MatchSession } from '../../src/multiplayer/MatchSession.js';
import { decodeMessage, encodeMessage } from '../../src/multiplayer/MessageCodec.js';

describe('multiplayer protocol and host authorization', () => {
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
});

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
