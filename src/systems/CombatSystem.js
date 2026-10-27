/** Combat rules and sacrifice resolution. Presentation and player choices are injected. */
export function daggerAvailable({ countTiles, troops }, pi) {
  return countTiles(pi, 'dagger') > 0 && troops().filter((troop) => troop.owner === pi).length >= 3;
}

export function cpuShouldUseDagger({ players, troops, weights }, pi) {
  const w = weights();
  const player = players()[pi];
  const troopCount = troops().filter((troop) => troop.owner === pi).length;
  return troopCount >= w.daggerSurplusThreshold ||
    (player.mana >= w.daggerClosingManaThreshold && troopCount >= w.daggerClosingTroopThreshold);
}

/** Deterministic combat outcome that a host can include with its accepted action. */
export function resolveCombatOutcome({ getStats }, attacker, defender) {
  const attackerStats = getStats(attacker), defenderStats = getStats(defender);
  const attackerKills = attackerStats.atk >= defenderStats.def;
  const defenderKills = defenderStats.atk >= attackerStats.def;
  return {
    attackerId: attacker.id,
    defenderId: defender.id,
    attackerStats,
    defenderStats,
    attackerKills,
    defenderKills,
    casualties: [attackerKills ? defender.id : null, defenderKills ? attacker.id : null].filter(id => id !== null)
  };
}

export async function performSacrifice(context, pi) {
  const { players, troops, getTile, isLocked, destroyTroop, waitFor, validateIntent, log, coloredName,
    document, axialToPixel, boardX, boardY, burst, updateHUD, winScore, setGameOver, showVictory } = context;
  const player = players()[pi];
  if (player.human) {
    document.getElementById('dagger-btn').disabled = true;
    const button = document.getElementById('skip-btn');
    button.disabled = false;
    button.textContent = 'Cancel Sacrifice';
    log(`${coloredName(pi)} channels the Sacrificial Dagger — choose 3 troops to sacrifice.`);
    const intent = await waitFor('sacrifice', pi);
    button.disabled = true;
    if (intent?.type === 'cancel') {
      if (context.multiplayerRole === 'guest') await context.requestGuestSacrificeCancel?.();
      return false;
    }
    const action = validateIntent(intent, 'sacrifice', pi);
    if (!action) return false;
    if (context.multiplayerRole === 'guest') {
      return await context.requestGuestSacrifice?.(action.troops.map(troop => troop.id)) === true;
    }
    for (const troop of action.troops) await destroyTroop(troop, false);
  } else {
    const picks = [...troops()].filter((troop) => troop.owner === pi).sort((a, b) => {
      const score = (troop) => (getTile(troop.q, troop.r).type === 'plain' ? 0 : 1) + (isLocked(troop) ? 2 : 0);
      return score(a) - score(b);
    }).slice(0, 3);
    for (const troop of picks) await destroyTroop(troop, false);
  }
  player.mana++;
  log(`🗡️ ${coloredName(pi)} sacrifices 3 troops for 1 mana. (${player.mana}/${winScore})`);
  const pixel = axialToPixel(0, 0);
  burst(boardX(pixel.x), boardY(pixel.y), 0xc9b8ff, 24);
  updateHUD();
  if (player.mana >= winScore) { setGameOver(true); showVictory(pi); }
  return true;
}

export async function executeAttack(context, attacker, defender) {
  const { log, burst, sleep, destroyTroop } = context;
  const result = resolveCombatOutcome(context, attacker, defender);
  const { attackerStats, defenderStats, attackerKills, defenderKills } = result;
  log(`⚔️ ${context.coloredName(attacker.owner)} (${attackerStats.atk}/${attackerStats.def}) attacks ${context.coloredName(defender.owner)} (${defenderStats.atk}/${defenderStats.def}).`);
  burst((attacker.sprite.x + defender.sprite.x) / 2, (attacker.sprite.y + defender.sprite.y) / 2, 0xffffff, 20);
  await sleep(200);
  if (attackerKills) await destroyTroop(defender, false);
  if (defenderKills) await destroyTroop(attacker, false);
  if (!attackerKills && !defenderKills) log('Both troops bounce off harmlessly.');
  return result;
}
