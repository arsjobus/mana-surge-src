/** Typed player intents and rule-side validation, independent of Phaser and DOM. */
export function validateActionIntent(context, intent, { phase, playerIndex, spawnOptions = [] } = {}) {
  if (!intent || typeof intent !== 'object' || !Number.isInteger(playerIndex)) return null;
  const { troops, getTroop, isLocked, isEmptyTile, neighbors, getTroopAt, daggerAvailable } = context;
  const ownedTroop = id => {
    const troop = getTroop(id);
    return troop && troop.owner === playerIndex ? troop : null;
  };

  if (intent.type === 'skip' && (phase === 'move' || phase === 'attack')) return { type: 'skip' };
  if (intent.type === 'dagger' && (phase === 'move' || phase === 'attack') && daggerAvailable(playerIndex)) return { type: 'dagger' };
  if (intent.type === 'spawn' && phase === 'spawn' && Number.isInteger(intent.q) && Number.isInteger(intent.r)) {
    const coord = spawnOptions.find(option => option.q === intent.q && option.r === intent.r);
    return coord ? { type: 'spawn', coord } : null;
  }
  if (intent.type === 'sacrifice' && phase === 'sacrifice' && daggerAvailable(playerIndex) && Array.isArray(intent.troopIds) && intent.troopIds.length === 3) {
    const ids = new Set(intent.troopIds);
    if (ids.size !== 3) return null;
    const picks = [...ids].map(ownedTroop);
    return picks.every(Boolean) ? { type: 'sacrifice', troops: picks } : null;
  }
  if (phase === 'move' && intent.type === 'move' && Number.isInteger(intent.q) && Number.isInteger(intent.r)) {
    const troop = ownedTroop(intent.troopId);
    if (!troop || isLocked(troop) || !isEmptyTile({ q: intent.q, r: intent.r })) return null;
    const adjacent = neighbors(troop.q, troop.r).some(coord => coord.q === intent.q && coord.r === intent.r);
    return adjacent ? { type: 'move', troop, target: { q: intent.q, r: intent.r } } : null;
  }
  if (phase === 'attack' && intent.type === 'attack') {
    const attacker = ownedTroop(intent.attackerId);
    const defender = getTroop(intent.defenderId);
    if (!attacker || !defender || defender.owner === playerIndex || isLocked(attacker)) return null;
    const adjacent = neighbors(attacker.q, attacker.r).some(coord => coord.q === defender.q && coord.r === defender.r);
    return adjacent ? { type: 'attack', attacker, defender } : null;
  }
  return null;
}

/** Keeps local UI state and promise resolvers out of GameState/shared snapshots. */
export function createLocalActionAdapter() {
  let active = null;
  function request(kind, playerIndex, options = []) {
    return new Promise(resolve => { active = { kind, playerIndex, options, selected: null, picks: [], resolve }; });
  }
  function submit(intent) {
    if (!active) return false;
    const resolve = active.resolve;
    active = null;
    resolve(intent);
    return true;
  }
  function cancel() { return submit({ type: 'cancel' }); }
  return { request, submit, cancel, current: () => active };
}
