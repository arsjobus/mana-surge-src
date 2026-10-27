/** Spawn choices and start-of-turn spawning rules. */
export function chooseCpuSpawnTile({ getTile }, options) {
  const priority = { extra_action: 5, extra_spawn: 4, atk_plus: 3, def_plus: 2, plain: 1, atk_minus: 0, thorns: -5 };
  return options.reduce((best, option) => {
    const score = priority[getTile(option.q, option.r).type] ?? 1;
    return score > best.score ? { option, score } : best;
  }, { option: options[0], score: -Infinity }).option;
}

export async function startPhase(context, pi) {
  const { players, countTiles, troops, neighbors, tiles, isEmptyTile, waitForSpawn,
    createTroop, cpuChooseSpawnTile, sleep, log, coloredName, updateHUD } = context;
  const player = players()[pi];
  player.actionPoints = 1 + countTiles(pi, 'extra_action');
  player.maxActionPointsSeen = Math.max(player.maxActionPointsSeen || 1, player.actionPoints);
  updateHUD();
  const allowed = 1 + countTiles(pi, 'extra_spawn');
  let spawned = 0;
  for (let i = 0; i < allowed; i++) {
    if (troops().filter((troop) => troop.owner === pi).length >= 15) { log(`${player.name} has no troops left in reserve.`); break; }
    const options = neighbors(player.spawner.q, player.spawner.r).filter((coord) => tiles().has(`${coord.q},${coord.r}`) && isEmptyTile(coord));
    if (!options.length) { log(`${player.name}'s spawner has no open ground.`); break; }
    let choice;
    if (options.length === 1) choice = options[0];
    else if (player.human) choice = await waitForSpawn(options, pi);
    else { choice = cpuChooseSpawnTile(pi, options); await sleep(280); }
    createTroop(pi, choice.q, choice.r, true);
    spawned++;
    await sleep(200);
  }
  if (spawned) log(`${coloredName(pi)} spawns ${spawned} troop${spawned > 1 ? 's' : ''}.`);
  updateHUD();
}
