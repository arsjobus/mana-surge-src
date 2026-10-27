import { hexDistance, key, neighbors } from '../utils/hex.js';
import { LOCKING_TYPES } from '../data/gameData.js';

function progress(state) {
  const leaderMana = Math.max(...state.players.map((player) => player.mana));
  return Math.max(0, Math.min(1, leaderMana / state.winScore));
}

export function scoreMoveTarget(context, troop, target, pi, lockedAllies) {
  const { state, weights, getTile, getTroopAt, getStats, isLocked } = context;
  const w = weights;
  const tile = getTile(target.q, target.r);
  let score = 0;
  score += (hexDistance(troop, { q: 0, r: 0 }) - hexDistance(target, { q: 0, r: 0 })) * w.centerPull;
  const economyFactor = 1 - progress(state) * w.economyDecay;
  if (tile.type === 'mana_pool') score += w.manaPool;
  if (tile.type === 'extra_action') score += w.extraAction * economyFactor;
  if (tile.type === 'extra_spawn') score += w.extraSpawn * economyFactor;
  if (tile.type === 'dagger') score += w.dagger;
  if (tile.type === 'atk_plus') score += w.atkPlus;
  if (tile.type === 'def_plus') score += w.defPlus;
  if (tile.type === 'atk_minus') score += w.atkMinus;
  if (tile.type === 'thorns') score += w.thorns;
  const humans = state.troops.filter((unit) => state.players[unit.owner].human);
  if (humans.length) {
    const before = Math.min(...humans.map((human) => hexDistance(troop, human)));
    const after = Math.min(...humans.map((human) => hexDistance(target, human)));
    score += (before - after) * w.huntNearestEnemy;
  }
  const hypotheticalDefense = 1 + (tile.type === 'def_plus' ? 1 : 0);
  neighbors(target.q, target.r).forEach((coord) => {
    const enemy = getTroopAt(coord.q, coord.r);
    if (!enemy || enemy.owner === pi) return;
    const enemyTile = getTile(enemy.q, enemy.r);
    if (enemyTile.type === 'mana_pool' || LOCKING_TYPES.includes(enemyTile.type)) score += w.setupHighValueAttack;
    else if (getStats(enemy).atk >= hypotheticalDefense) score += w.genericRisk;
  });
  const manaTile = getTile(0, 0);
  if (manaTile.occupantId != null) {
    const occupant = state.troops.find((unit) => unit.id === manaTile.occupantId);
    if (occupant && occupant.owner !== pi && hexDistance(target, { q: 0, r: 0 }) === 1 && hexDistance(troop, { q: 0, r: 0 }) !== 1) score += w.manaAdjacencyRush;
  }
  lockedAllies.forEach((ally) => {
    if (ally.id === troop.id || hexDistance(target, ally) !== 1 || hexDistance(troop, ally) === 1) return;
    const guarded = neighbors(ally.q, ally.r).some((coord) => {
      const unit = getTroopAt(coord.q, coord.r);
      return unit && unit.owner === pi && unit.id !== troop.id;
    });
    if (!guarded) score += w.reinforceBonus;
  });
  return score;
}

export function cpuChooseMove(context, pi) {
  const { state, weights, getTile, isLocked, isEmptyTile } = context;
  let best = null, bestScore = 2;
  const candidates = [];
  const lockedAllies = state.troops.filter((troop) => troop.owner === pi && LOCKING_TYPES.includes(getTile(troop.q, troop.r).type));
  state.troops.filter((troop) => troop.owner === pi && !isLocked(troop)).forEach((troop) => {
    neighbors(troop.q, troop.r).filter((coord) => state.tiles.has(key(coord.q, coord.r)) && isEmptyTile(coord)).forEach((target) => {
      const score = scoreMoveTarget(context, troop, target, pi, lockedAllies);
      candidates.push({ troop, target, score });
      if (score > bestScore) { bestScore = score; best = { troop, target, score }; }
    });
  });
  if (!candidates.length) return null;
  return Math.random() < weights.mistakeChance ? candidates[Math.floor(Math.random() * candidates.length)] : best;
}
