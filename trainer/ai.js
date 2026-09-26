'use strict';
/* ======================================================================
   ai.js — the behavior tree, with weights pulled out as a "genome"
   ----------------------------------------------------------------------
   This mirrors index.html's scoreMoveTarget / cpuChooseAttack /
   cpuShouldUseDagger / CPU_MOVE_TREE / CPU_COMBAT_TREE exactly in
   structure -- same priority order, same conditions -- but every magic
   number that was hardcoded there is a named field on a `weights`
   object here. That object is the thing the trainer evolves.

   Two differences from the in-browser version, both because training
   is 3-way free-for-all self-play with no human seat:
     - "hunt the human" becomes "hunt the nearest enemy troop"
     - "pressure the human" becomes "pressure whoever is in the lead"
   Everything else -- tile bonuses, combat math, dagger thresholds,
   the hold-for-attack logic -- is a 1:1 port.
--------------------------------------------------------------------- */

const { neighbors, hexDistance, LOCKING_TYPES, UNMISSABLE_CLAIM_TYPES } = require('./engine');

// Genome zero: the values currently hardcoded into index.html today.
// This is both the starting point for evolution and the fallback if
// nothing has been trained yet.
const DEFAULT_WEIGHTS = {
  centerPull: 6,
  manaPool: 130,
  extraAction: 46,
  extraSpawn: 40,
  dagger: 20,
  atkPlus: 22,
  defPlus: 18,
  atkMinus: -20,
  thorns: -600,
  huntNearestEnemy: 4,
  setupHighValueAttack: 38,
  genericRisk: -22,
  manaAdjacencyRush: 45,

  freeKillBase: 100,
  mutualTradeBase: 35,
  pointlessBump: -10,
  loseForNothingBase: -60,
  highValueMana: 55,
  highValueLocking: 30,
  pressureLeader: 20,
  isolatedBonus: 15,
  loseForNothingHighValueMult: 0.5,
  loseForNothingPressureMult: 0.5,

  daggerSurplusThreshold: 9,
  daggerClosingManaThreshold: 7,
  daggerClosingTroopThreshold: 5,

  mistakeChance: 0.08
};

// Genes allowed to be negative/zero and their sane evolution bounds.
// Kept here so the trainer doesn't have to duplicate this knowledge.
const GENE_BOUNDS = {
  centerPull:        [0, 20],
  manaPool:          [40, 220],
  extraAction:       [10, 90],
  extraSpawn:        [10, 80],
  dagger:            [0, 50],
  atkPlus:           [0, 50],
  defPlus:           [0, 50],
  atkMinus:          [-50, 0],
  thorns:            [-900, -200],
  huntNearestEnemy:  [0, 20],
  setupHighValueAttack:[0, 80],
  genericRisk:       [-60, 0],
  manaAdjacencyRush: [0, 90],

  freeKillBase:      [40, 200],
  mutualTradeBase:   [0, 90],
  pointlessBump:     [-40, 0],
  loseForNothingBase:[-120, -10],
  highValueMana:     [0, 110],
  highValueLocking:  [0, 70],
  pressureLeader:    [0, 60],
  isolatedBonus:     [0, 40],
  loseForNothingHighValueMult: [0, 1],
  loseForNothingPressureMult:  [0, 1],

  daggerSurplusThreshold:      [5, 14],
  daggerClosingManaThreshold:  [4, 9],
  daggerClosingTroopThreshold: [3, 9],

  mistakeChance: [0, 0.6]
};

function isIsolated(game, troop){
  return !neighbors(troop.q,troop.r).some(n=>{
    const t=game.getTroopAt(n.q,n.r);
    return t && t.owner===troop.owner;
  });
}

function scoreMoveTarget(game, troop, target, pi, w){
  const tile = game.getTile(target.q, target.r);
  let score = 0;
  const curDist = hexDistance(troop, {q:0,r:0});
  const newDist = hexDistance(target, {q:0,r:0});
  score += (curDist - newDist) * w.centerPull;
  if(tile.type==='mana_pool') score += w.manaPool;
  if(tile.type==='extra_action') score += w.extraAction;
  if(tile.type==='extra_spawn') score += w.extraSpawn;
  if(tile.type==='dagger') score += w.dagger;
  if(tile.type==='atk_plus') score += w.atkPlus;
  if(tile.type==='def_plus') score += w.defPlus;
  if(tile.type==='atk_minus') score += w.atkMinus;
  if(tile.type==='thorns') score += w.thorns;

  const enemyTroops = game.troops.filter(t=>t.owner!==pi);
  if(enemyTroops.length){
    const curEDist = Math.min(...enemyTroops.map(e=>hexDistance(troop,e)));
    const newEDist = Math.min(...enemyTroops.map(e=>hexDistance(target,e)));
    score += (curEDist - newEDist) * w.huntNearestEnemy;
  }

  const hypDef = 1 + (tile.type==='def_plus' ? 1 : 0);
  neighbors(target.q, target.r).forEach(nb=>{
    const e = game.getTroopAt(nb.q, nb.r);
    if(e && e.owner!==pi){
      const es = game.getStats(e);
      const et = game.getTile(e.q, e.r);
      const enemyHighValue = et.type==='mana_pool' || LOCKING_TYPES.includes(et.type);
      if(enemyHighValue) score += w.setupHighValueAttack;
      else if(es.atk >= hypDef) score += w.genericRisk;
    }
  });

  const manaTile = game.getTile(0,0);
  if(manaTile.occupantId != null){
    const occ = game.troops.find(t=>t.id===manaTile.occupantId);
    const wasAdjacent = hexDistance(troop, {q:0,r:0})===1;
    const willBeAdjacent = hexDistance(target, {q:0,r:0})===1;
    if(occ && occ.owner!==pi && willBeAdjacent && !wasAdjacent) score += w.manaAdjacencyRush;
  }
  return score;
}

function chooseMove(game, pi, w, rng){
  let best=null, bestScore=2;
  const candidates=[];
  game.troops.filter(t=>t.owner===pi && !game.isLocked(t)).forEach(troop=>{
    neighbors(troop.q, troop.r)
      .filter(n=>game.tiles.has(n.q+','+n.r) && game.isEmptyTile(n))
      .forEach(target=>{
        const s = scoreMoveTarget(game, troop, target, pi, w);
        candidates.push({troop, target, score:s});
        if(s>bestScore){ bestScore=s; best={troop,target,score:s}; }
      });
  });
  if(candidates.length===0) return null;
  if(rng() < w.mistakeChance) return candidates[Math.floor(rng()*candidates.length)];
  return best;
}

function chooseAttack(game, pi, w, rng){
  let best=null, bestScore=0;
  const candidates=[];
  const leader = game.players.reduce((a,_,i)=> game.players[i].mana>game.players[a].mana ? i : a, 0);
  game.troops.filter(t=>t.owner===pi && !game.isLocked(t)).forEach(troop=>{
    const aS = game.getStats(troop);
    neighbors(troop.q, troop.r).forEach(nb=>{
      const enemy = game.getTroopAt(nb.q, nb.r);
      if(enemy && enemy.owner!==pi){
        const dS = game.getStats(enemy);
        const iKill = aS.atk >= dS.def;
        const iDie = dS.atk >= aS.def;
        const et = game.getTile(enemy.q, enemy.r);
        const highValue = et.type==='mana_pool' ? w.highValueMana
          : LOCKING_TYPES.includes(et.type) ? w.highValueLocking : 0;
        const isLeader = enemy.owner===leader;
        const isolatedBonus = isIsolated(game, enemy) ? w.isolatedBonus : 0;
        const pressureBonus = (isLeader ? w.pressureLeader : 0) + isolatedBonus;
        let score;
        if(iKill && !iDie) score = w.freeKillBase + highValue + pressureBonus;
        else if(iKill && iDie) score = w.mutualTradeBase + highValue + pressureBonus;
        else if(!iKill && !iDie) score = w.pointlessBump;
        else score = w.loseForNothingBase + highValue*w.loseForNothingHighValueMult + pressureBonus*w.loseForNothingPressureMult;
        candidates.push({attacker:troop, defender:enemy, score});
        if(score>bestScore){ bestScore=score; best={attacker:troop, defender:enemy, score}; }
      }
    });
  });
  if(candidates.length===0) return null;
  if(rng() < w.mistakeChance) return candidates[Math.floor(rng()*candidates.length)];
  return best;
}

function shouldUseDagger(game, pi, w){
  const p = game.players[pi];
  const myTroopCount = game.troops.filter(t=>t.owner===pi).length;
  const hasSurplus = myTroopCount >= w.daggerSurplusThreshold;
  const closingPush = p.mana >= w.daggerClosingManaThreshold && myTroopCount >= w.daggerClosingTroopThreshold;
  return hasSurplus || closingPush;
}

// --- Decision trees (same priority order as CPU_MOVE_TREE / CPU_COMBAT_TREE) ---
function decideMoveAction(game, pi, isPreCombat, w, rng){
  const p = game.players[pi];
  const bestMove = chooseMove(game, pi, w, rng);
  if(isPreCombat && p.actionPoints<=1){
    const pendingAttack = chooseAttack(game, pi, w, rng);
    if(pendingAttack){
      if(!bestMove) return {type:'hold'};
      const targetType = game.getTile(bestMove.target.q, bestMove.target.r).type;
      if(!UNMISSABLE_CLAIM_TYPES.includes(targetType)) return {type:'hold'};
    }
  }
  if(bestMove) return {type:'move', troop:bestMove.troop, target:bestMove.target};
  if(game.daggerAvailable(pi) && shouldUseDagger(game, pi, w)) return {type:'sacrifice'};
  return {type:'pass'};
}

function decideCombatAction(game, pi, w, rng){
  const bestAttack = chooseAttack(game, pi, w, rng);
  if(bestAttack) return {type:'attack', attacker:bestAttack.attacker, defender:bestAttack.defender};
  if(game.daggerAvailable(pi) && shouldUseDagger(game, pi, w)) return {type:'sacrifice'};
  return {type:'pass'};
}

module.exports = {
  DEFAULT_WEIGHTS, GENE_BOUNDS,
  scoreMoveTarget, chooseMove, chooseAttack, shouldUseDagger,
  decideMoveAction, decideCombatAction
};
