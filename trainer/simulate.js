'use strict';
const { Game } = require('./engine');
const { decideMoveAction, decideCombatAction } = require('./ai');

const MAX_ACTIONS_PER_PHASE = 40; // safety valve against any infinite-loop genome

function runMovePhase(game, pi, isPreCombat, w, rng){
  const p = game.players[pi];
  let guard = 0;
  while(p.actionPoints>0 && guard++ < MAX_ACTIONS_PER_PHASE){
    if(!game.hasLegalMove(pi) && !game.daggerAvailable(pi)) break;
    const decision = decideMoveAction(game, pi, isPreCombat, w, rng);
    if(decision.type==='move'){
      game.executeMove(decision.troop, game.getTile(decision.target.q, decision.target.r));
      p.actionPoints--;
    } else if(decision.type==='sacrifice'){
      const did = game.performSacrificeCPU(pi);
      if(did) p.actionPoints--;
      if(game.gameOver) return;
    } else break; // 'hold' or 'pass'
  }
}

function runCombatPhase(game, pi, w, rng){
  const p = game.players[pi];
  let guard = 0;
  while(p.actionPoints>0 && guard++ < MAX_ACTIONS_PER_PHASE){
    if(!game.hasLegalAttack(pi) && !game.daggerAvailable(pi)) break;
    const decision = decideCombatAction(game, pi, w, rng);
    if(decision.type==='attack'){
      game.executeAttack(decision.attacker, decision.defender);
      p.actionPoints--;
    } else if(decision.type==='sacrifice'){
      const did = game.performSacrificeCPU(pi);
      if(did) p.actionPoints--;
      if(game.gameOver) return;
    } else break;
  }
}

function playTurn(game, pi, weightsByPlayer, rng){
  game.startPhase(pi);
  if(game.gameOver) return;
  runMovePhase(game, pi, true, weightsByPlayer[pi], rng);
  if(game.gameOver) return;
  runCombatPhase(game, pi, weightsByPlayer[pi], rng);
  if(game.gameOver) return;
  runMovePhase(game, pi, false, weightsByPlayer[pi], rng);
  if(game.gameOver) return;
  game.endPhase(pi);
}

/**
 * Plays one full 3-player match to completion (or a turn cap) and returns
 * the outcome. weightsByPlayer is an array of 3 weight genomes, one per
 * seat (Red, Blue, Green — matching the fixed spawner order).
 */
function playMatch(weightsByPlayer, { winScore = 10, maxTurns = 400, rng = Math.random } = {}){
  const game = new Game(winScore);
  let turn = 0, pi = 0;
  while(!game.gameOver && turn < maxTurns){
    playTurn(game, pi, weightsByPlayer, rng);
    pi = (pi+1) % 3;
    turn++;
  }
  return {
    winner: game.winner,               // 0/1/2, or null if it timed out
    mana: game.players.map(p=>p.mana),
    turns: turn
  };
}

module.exports = { playMatch };
