import { endPhase } from '../../src/systems/TurnSystem.js';

describe('Mana Surge completion checks', () => {
  beforeEach(() => {
    cy.visit('/');
  });

  it('lets the player choose any seat, difficulty, and victory threshold', () => {
    cy.get('.color-btn').each(($button, index) => {
      cy.wrap($button).click().should('have.class', 'selected');
      cy.get('.color-btn').eq(index).should('have.class', 'selected');
    });

    cy.get('.diff-btn').each(($button, index) => {
      cy.wrap($button).click().should('have.class', 'selected');
      cy.get('.diff-btn').eq(index).should('have.class', 'selected');
    });

    cy.get('#winscore-slider').invoke('val', '30').trigger('input');
    cy.get('#winscore-value').should('have.text', '30');
    cy.get('#intro-winscore').should('have.text', '30');

    cy.get('#start-btn').click();
    cy.get('#hidden-start-overlay').should('not.be.visible');
    cy.get('#game-container canvas').should('be.visible');
    cy.get('.mana-row').should('have.length', 3);
    cy.get('.mana-row .mr-count').each(($count) => {
      cy.wrap($count).should('have.text', '0 / 30');
    });
  });

  it('opens and closes help and credits from the start screen', () => {
    cy.get('#rules-btn').click();
    cy.get('#help-modal').should('be.visible');
    cy.get('#close-help').click();
    cy.get('#help-modal').should('not.be.visible');

    cy.get('#credits-btn').click();
    cy.get('#credits-modal').should('be.visible');
    cy.get('#credits-list .credit-row').should('have.length.greaterThan', 0);
    cy.get('#close-credits-x').click();
    cy.get('#credits-modal').should('not.be.visible');
  });

  it('keeps the HUD stage aligned after a viewport resize', () => {
    cy.get('#start-btn').click();
    cy.get('#game-container canvas').should('be.visible');
    cy.get('#ui-stage').should(($stage) => {
      expect($stage[0].style.transform).to.match(/^scale\(/);
    });

    cy.viewport(900, 700);
    cy.get('#ui-stage').should(($stage) => {
      expect($stage[0].style.transform).to.match(/^scale\(/);
      expect($stage[0].style.left).to.not.equal('');
      expect($stage[0].style.top).to.not.equal('');
    });
  });

  it('toggles the background music mute control', () => {
    cy.get('#start-btn').click();
    cy.get('#game-container canvas').should('be.visible');
    cy.get('.mana-row').should('have.length', 3);
    cy.get('#mute-btn').should('be.visible').and('have.text', '🔊').click();
    cy.get('#mute-btn').should('have.text', '🔇').click();
    cy.get('#mute-btn').should('have.text', '🔊');
  });

  it('shows the victory result and exposes the replay action', () => {
    const state = {
      winScore: 10,
      players: [
        { human: true, colorHex: 0xff5757, name: 'Red', mana: 9 },
        { human: false, colorHex: 0x5aa9ff, name: 'Blue', mana: 0 }
      ]
    };

    const manaTile = { occupantId: 42 };
    const setGameOver = cy.stub();
    const showVictory = cy.stub();

    cy.then(() => endPhase({
      players: () => state.players,
      getTile: () => manaTile,
      troops: () => [{ id: 42, owner: 0 }],
      winScore: state.winScore,
      log: cy.stub(),
      coloredName: () => 'Red',
      axialToPixel: () => ({ x: 0, y: 0 }),
      hexSize: 1,
      boardX: value => value,
      boardY: value => value,
      burst: cy.stub(),
      updateHUD: cy.stub(),
      setGameOver,
      showVictory
    }, 0)).then(() => {
      expect(state.players[0].mana).to.equal(10);
      expect(setGameOver).to.have.been.calledWith(true);
      expect(showVictory).to.have.been.calledWith(0);
    });

    cy.window().then(win => win.eval("import('/src/ui/ModalUI.js')")).then(({ presentVictory }) => {
      presentVictory({
        state,
        pi: 0,
        scene: { time: { delayedCall: cy.stub() } },
        cssColor: value => `#${value.toString(16).padStart(6, '0')}`,
        coloredName: index => `<span>Red</span>`,
        boardX: value => value,
        boardY: value => value,
        burst: cy.stub(),
        axialToPixel: () => ({ x: 0, y: 0 }),
        hexSize: 1
      });
    });

    cy.get('#victory-modal').should('be.visible');
    cy.get('#victory-title').should('have.text', 'Victory!');
    cy.get('#victory-text').should('contain.text', '10 mana points');
    cy.get('#playagain-btn').should('be.visible').click();
    cy.get('#hidden-start-overlay').should('be.visible');
  });

  it('offers the right end-of-match buttons for single player, host and guest', () => {
    cy.window().then(win => win.eval("import('/src/ui/ModalUI.js')")).then(({ presentVictory }) => {
      const show = session => presentVictory({
        state: { players: [{ human: true, colorHex: 0xff5757 }], winScore: 10, session },
        pi: 0, scene: { time: { delayedCall: cy.stub() } }, cssColor: () => '#fff', coloredName: () => 'Red',
        boardX: v => v, boardY: v => v, burst: cy.stub(), axialToPixel: () => ({ x: 0, y: 0 }), hexSize: 1
      });
      show(null);
      cy.get('#playagain-btn').should('be.visible').and('have.text', 'Return to Main Menu');
      cy.get('#leave-match-btn').should('not.be.visible');
      cy.then(() => show({ role: 'host' }));
      cy.get('#playagain-btn').should('be.visible').and('have.text', 'Play Again');
      cy.get('#leave-match-btn').should('be.visible').and('have.text', 'Leave Match');
      cy.then(() => show({ role: 'guest' }));
      cy.get('#playagain-btn').should('not.be.visible');
      cy.get('#leave-match-btn').should('be.visible');
      cy.get('#match-end-note').should('contain.text', 'Waiting for the host');
    });
  });

  it('restarts into a clean start screen', () => {
    cy.get('#start-btn').click();
    cy.get('#game-container canvas').should('be.visible');
    cy.get('#restart-btn').click();
    cy.get('#hidden-start-overlay').should('be.visible');
    cy.get('#game-container canvas').should('not.exist');
  });
});
