/** Mutable data for one match. Phaser objects and UI state stay outside this class. */
export class GameState {
  constructor({ difficulty = 'medium', winScore = 10, humanColorIndex = 0 } = {}) {
    this.tiles = new Map();
    this.troops = [];
    this.nextTroopId = 1;
    this.players = [];
    this.currentPlayerIndex = 0;
    this.gameOver = false;
    this.difficulty = difficulty;
    this.winScore = winScore;
    this.humanColorIndex = humanColorIndex;
    this.pending = null;
  }
}
