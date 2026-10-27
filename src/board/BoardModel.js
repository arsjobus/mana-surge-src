import { key, neighbors } from '../utils/hex.js';
import { BOARD_DATA } from '../data/boardData.js';
import { LOCKING_TYPES } from '../data/gameData.js';

export function getTile(tiles, q, r) { return tiles.get(key(q, r)); }

export function isLocked(tiles, troop) {
  const tile = getTile(tiles, troop.q, troop.r);
  return !!tile && LOCKING_TYPES.includes(tile.type);
}

export function getStats(tiles, troop) {
  const tile = getTile(tiles, troop.q, troop.r);
  let atk = 1, def = 1;
  if (tile.type === 'atk_minus') atk -= 1;
  if (tile.type === 'atk_plus') atk += 1;
  if (tile.type === 'def_plus') def += 1;
  return { atk: Math.max(atk, 0), def: Math.max(def, 0) };
}

export function getTroopAt(tiles, troops, q, r) {
  const tile = getTile(tiles, q, r);
  if (!tile || tile.occupantId == null) return null;
  return troops.find((troop) => troop.id === tile.occupantId) || null;
}

export function isEmptyTile(tiles, coord) {
  const tile = getTile(tiles, coord.q, coord.r);
  return !!tile && tile.type !== 'spawner' && tile.occupantId == null;
}

export function countTiles(tiles, troops, pi, type) {
  return troops.filter((troop) => troop.owner === pi && getTile(tiles, troop.q, troop.r).type === type).length;
}

export function hasLegalMove(tiles, troops, pi) {
  return troops.some((troop) => troop.owner === pi && !isLocked(tiles, troop) &&
    neighbors(troop.q, troop.r).some((coord) => tiles.has(key(coord.q, coord.r)) && isEmptyTile(tiles, coord)));
}

export function hasLegalAttack(tiles, troops, pi) {
  return troops.some((troop) => troop.owner === pi && !isLocked(tiles, troop) &&
    neighbors(troop.q, troop.r).some((coord) => {
      const enemy = getTroopAt(tiles, troops, coord.q, coord.r);
      return enemy && enemy.owner !== pi;
    }));
}

export function buildBoard(players) {
  const tiles = new Map();
  BOARD_DATA.forEach((data) => tiles.set(key(data.q, data.r), {
    q: data.q, r: data.r, type: data.type,
    biome: data.biome === 'grey' ? 'stone' : 'green', occupantId: null, owner: data.owner
  }));
  const spawners = [{ q: -5, r: 0 }, { q: 5, r: -5 }, { q: 0, r: 5 }];
  players.forEach((player, i) => { player.spawner = spawners[i]; });
  return tiles;
}

export function setupInitialTroops(players, tiles, createTroop) {
  players.forEach((player, pi) => neighbors(player.spawner.q, player.spawner.r)
    .filter((coord) => tiles.has(key(coord.q, coord.r)))
    .forEach((coord) => createTroop(pi, coord.q, coord.r, false)));
}
