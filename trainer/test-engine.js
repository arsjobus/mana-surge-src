'use strict';
const assert = require('assert');
const { playMatch } = require('./simulate');
const { Game, neighbors } = require('./engine');
const {
  DEFAULT_WEIGHTS, scoreMoveTarget, decideMoveAction, decideCombatAction
} = require('./ai');

const N = 200;
const w = [DEFAULT_WEIGHTS, DEFAULT_WEIGHTS, DEFAULT_WEIGHTS];
const wins = [0,0,0];
let timeouts = 0;

function testStrategicAI(){
  const game = new Game();
  const troop = game.troops.find((unit) => unit.owner === 0);
  const target = neighbors(troop.q, troop.r).find((coord) => game.isEmptyTile(coord));
  assert(target, 'expected an available move for the action-shrine test');
  const tile = game.getTile(target.q, target.r);
  const originalType = tile.type;
  tile.type = 'extra_action';
  const earlyActionScore = scoreMoveTarget(game, troop, target, 0, DEFAULT_WEIGHTS, []);
  tile.type = 'plain';
  const earlyPlainScore = scoreMoveTarget(game, troop, target, 0, DEFAULT_WEIGHTS, []);
  game.players[1].mana = game.winScore - 1;
  const latePlainScore = scoreMoveTarget(game, troop, target, 0, DEFAULT_WEIGHTS, []);
  tile.type = 'extra_action';
  const lateActionScore = scoreMoveTarget(game, troop, target, 0, DEFAULT_WEIGHTS, []);
  tile.type = originalType;
  assert(earlyActionScore - earlyPlainScore > lateActionScore - latePlainScore,
    'action shrines should be more valuable early, when extra actions can be used for longer');

  function makeWinningSacrificeGame(){
    const sacrificeGame = new Game();
    sacrificeGame.players[0].mana = sacrificeGame.winScore - 1;
    const daggerTile = sacrificeGame.getTile(0, 2);
    const daggerTroop = sacrificeGame.troops.find((unit) => unit.owner === 0);
    sacrificeGame.getTile(daggerTroop.q, daggerTroop.r).occupantId = null;
    daggerTroop.q = daggerTile.q;
    daggerTroop.r = daggerTile.r;
    daggerTile.occupantId = daggerTroop.id;
    assert(sacrificeGame.hasLegalMove(0), 'winning sacrifice should preempt an available move');
    return sacrificeGame;
  }

  const moveGame = makeWinningSacrificeGame();
  assert.strictEqual(decideMoveAction(moveGame, 0, false, DEFAULT_WEIGHTS, Math.random).type, 'sacrifice');
  const combatGame = makeWinningSacrificeGame();
  assert.strictEqual(decideCombatAction(combatGame, 0, DEFAULT_WEIGHTS, Math.random).type, 'sacrifice');
  assert.strictEqual(combatGame.performSacrificeCPU(0), true);
  assert.strictEqual(combatGame.winner, 0, 'a winning sacrifice should end the game immediately');
}

testStrategicAI();

for(let i=0;i<N;i++){
  const r = playMatch(w);
  if(r.winner==null) timeouts++; else wins[r.winner]++;
}

console.log(`${N} matches, default weights on all 3 seats`);
console.log('wins by seat:', wins, ' timeouts:', timeouts);
if(timeouts > N*0.1){
  console.error('FAIL: too many matches hit the turn cap without a winner — check for a stuck AI loop.');
  process.exit(1);
}
console.log('OK: engine completes matches reliably.');
