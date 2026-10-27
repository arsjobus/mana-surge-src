import { neighbors } from '../utils/hex.js';
import { LOCKING_TYPES } from '../data/gameData.js';

function isIsolated(context, troop) {
  return !neighbors(troop.q, troop.r).some((coord) => {
    const ally = context.getTroopAt(coord.q, coord.r);
    return ally && ally.owner === troop.owner;
  });
}

export function cpuChooseAttack(context, pi) {
  const { state, weights: w, getTile, getStats, getTroopAt, isLocked } = context;
  let best = null, bestScore = 0;
  const candidates = [];
  const leader = state.players.reduce((a, _, i) => state.players[i].mana > state.players[a].mana ? i : a, 0);
  const leaderMargin = state.players[leader].mana / state.winScore;
  const myLockedTroops = state.troops.filter((troop) => troop.owner === pi && LOCKING_TYPES.includes(getTile(troop.q, troop.r).type));
  state.troops.filter((troop) => troop.owner === pi && !isLocked(troop)).forEach((troop) => {
    const attackerStats = getStats(troop);
    neighbors(troop.q, troop.r).forEach((coord) => {
      const enemy = getTroopAt(coord.q, coord.r);
      if (!enemy || enemy.owner === pi) return;
      const defenderStats = getStats(enemy);
      const attackerKills = attackerStats.atk >= defenderStats.def;
      const attackerDies = defenderStats.atk >= attackerStats.def;
      const enemyTile = getTile(enemy.q, enemy.r);
      const highValue = enemyTile.type === 'mana_pool' ? w.highValueMana : LOCKING_TYPES.includes(enemyTile.type) ? w.highValueLocking : 0;
      const isolatedBonus = isIsolated(context, enemy) ? w.isolatedBonus : 0;
      const leaderBonus = enemy.owner === leader ? w.pressureLeader * (1 + w.pressureMarginScale * leaderMargin) : 0;
      const threatensMyLocked = myLockedTroops.some((ally) => neighbors(ally.q, ally.r).some((n) => n.q === enemy.q && n.r === enemy.r));
      const defendBonus = threatensMyLocked ? w.defendLockedBonus : 0;
      const pressureBonus = leaderBonus + isolatedBonus + defendBonus;
      let score;
      if (attackerKills && !attackerDies) score = w.freeKillBase + highValue + pressureBonus;
      else if (attackerKills && attackerDies) score = w.mutualTradeBase + highValue + pressureBonus;
      else if (!attackerKills && !attackerDies) score = w.pointlessBump + defendBonus * 0.5;
      else score = w.loseForNothingBase + highValue * w.loseForNothingHighValueMult + pressureBonus * w.loseForNothingPressureMult;
      candidates.push({ attacker: troop, defender: enemy, score });
      if (score > bestScore) { bestScore = score; best = { attacker: troop, defender: enemy, score }; }
    });
  });
  if (!candidates.length) return null;
  return Math.random() < w.mistakeChance ? candidates[Math.floor(Math.random() * candidates.length)] : best;
}

export function cpuShouldUseDagger({ players, troops, weights }, pi) {
  const w = weights;
  const player = players[pi];
  const troopCount = troops.filter((troop) => troop.owner === pi).length;
  return troopCount >= w.daggerSurplusThreshold ||
    (player.mana >= w.daggerClosingManaThreshold && troopCount >= w.daggerClosingTroopThreshold);
}
