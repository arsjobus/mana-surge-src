/** Turn and phase sequencing. The scene supplies presentation and interaction callbacks. */
export async function executeMove(context, troop, targetTile) {
  const { getTile, axialToPixel, hexSize, boardX, boardY, moveSpritesTo, coloredName,
    destroyTroop, refreshLockVisual, lockingTypes, tileInfo, log } = context;
  const oldTile = getTile(troop.q, troop.r);
  oldTile.occupantId = null;
  troop.q = targetTile.q;
  troop.r = targetTile.r;
  const pixel = axialToPixel(targetTile.q, targetTile.r, hexSize);
  await moveSpritesTo(troop, boardX(pixel.x), boardY(pixel.y));
  if (targetTile.type === 'thorns') {
    log(`💀 ${coloredName(troop.owner)}'s troop is impaled by thorns!`);
    await destroyTroop(troop, true);
    return;
  }
  targetTile.occupantId = troop.id;
  refreshLockVisual(troop);
  if (lockingTypes.includes(targetTile.type)) log(`${coloredName(troop.owner)} claims ${tileInfo[targetTile.type].name}.`);
}

export async function endPhase(context, pi) {
  const { players, getTile, troops, winScore, log, coloredName, axialToPixel, hexSize,
    boardX, boardY, burst, updateHUD, setGameOver, showVictory } = context;
  const player = players()[pi];
  const manaTile = getTile(0, 0);
  if (manaTile.occupantId == null) return;
  const troop = troops().find((item) => item.id === manaTile.occupantId);
  if (!troop || troop.owner !== pi) return;
  player.mana++;
  log(`✨ ${coloredName(pi)} channels a Mana Point! (${player.mana}/${winScore})`);
  const pixel = axialToPixel(0, 0, hexSize);
  burst(boardX(pixel.x), boardY(pixel.y), 0xffd76a, 30);
  updateHUD();
  if (player.mana >= winScore) {
    setGameOver(true);
    showVictory(pi);
  }
}

/** Run a move phase using rule, AI, and interaction callbacks supplied by the scene. */
export async function movePhase(context, pi, isPreCombat) {
  const { players, hasLegalMove, daggerAvailable, document, gameOver, waitFor, performSacrifice,
    updateHUD, getTile, executeMove, sleep, moveDecision, clearHighlights } = context;
  const player = players()[pi];
  const skipButton = document.getElementById('skip-btn');
  const daggerButton = document.getElementById('dagger-btn');
  while (true) {
    if (gameOver()) return;
    if (player.actionPoints <= 0) break;
    const canMove = hasLegalMove(pi);
    const canDagger = daggerAvailable(pi);
    if (!canMove && !canDagger) break;
    if (player.human) {
      daggerButton.style.display = canDagger ? 'block' : 'none';
      daggerButton.disabled = !canDagger;
      skipButton.disabled = false;
      skipButton.textContent = 'Skip Move Phase';
      const action = await waitFor('move', pi);
      skipButton.disabled = true;
      if (action.type === 'dagger') {
        const didSacrifice = await performSacrifice(pi);
        if (didSacrifice) player.actionPoints--;
        updateHUD();
        continue;
      }
      if (action.type === 'skip') break;
      await executeMove(action.troop, getTile(action.target.q, action.target.r));
      player.actionPoints--;
      updateHUD();
    } else {
      await sleep(500);
      const decision = moveDecision(pi, isPreCombat);
      if (decision.type === 'move') {
        await executeMove(decision.troop, getTile(decision.target.q, decision.target.r));
        player.actionPoints--;
        updateHUD();
        await sleep(250);
      } else if (decision.type === 'sacrifice') {
        const didSacrifice = await performSacrifice(pi);
        if (didSacrifice) player.actionPoints--;
        updateHUD();
        await sleep(250);
      } else break;
    }
  }
  daggerButton.style.display = 'none';
  clearHighlights();
}

/** Run combat actions until the player passes or runs out of action points. */
export async function combatPhase(context, pi) {
  const { players, hasLegalAttack, daggerAvailable, document, gameOver, waitFor, performSacrifice,
    updateHUD, executeAttack, sleep, combatDecision, clearHighlights } = context;
  const player = players()[pi];
  const skipButton = document.getElementById('skip-btn');
  const daggerButton = document.getElementById('dagger-btn');
  while (true) {
    if (gameOver()) return;
    if (player.actionPoints <= 0) break;
    const canAttack = hasLegalAttack(pi);
    const canDagger = daggerAvailable(pi);
    if (!canAttack && !canDagger) break;
    if (player.human) {
      daggerButton.style.display = canDagger ? 'block' : 'none';
      daggerButton.disabled = !canDagger;
      skipButton.disabled = false;
      skipButton.textContent = 'Skip Combat Phase';
      const action = await waitFor('attack', pi);
      skipButton.disabled = true;
      if (action.type === 'dagger') {
        const didSacrifice = await performSacrifice(pi);
        if (didSacrifice) player.actionPoints--;
        updateHUD();
        continue;
      }
      if (action.type === 'skip') break;
      await executeAttack(action.attacker, action.defender);
      player.actionPoints--;
      updateHUD();
    } else {
      await sleep(550);
      const decision = combatDecision(pi);
      if (decision.type === 'attack') {
        await executeAttack(decision.attacker, decision.defender);
        player.actionPoints--;
        updateHUD();
        await sleep(300);
      } else if (decision.type === 'sacrifice') {
        const didSacrifice = await performSacrifice(pi);
        if (didSacrifice) player.actionPoints--;
        updateHUD();
        await sleep(300);
      } else break;
    }
  }
  daggerButton.style.display = 'none';
  clearHighlights();
}

export async function playTurn(context, pi) {
  const { players, log, coloredName, cssColor, setPhaseUI, startPhase, movePhase, combatPhase, endPhase, isGameOver } = context;
  const player = players()[pi];
  log(`<b style="color:${cssColor(player.colorHex)}">— ${player.name}'s Turn —</b>`);
  setPhaseUI(pi, 'Start Phase');
  await startPhase(pi); if (isGameOver()) return;
  setPhaseUI(pi, 'Move Phase I');
  await movePhase(pi, true); if (isGameOver()) return;
  setPhaseUI(pi, 'Combat Phase');
  await combatPhase(pi); if (isGameOver()) return;
  setPhaseUI(pi, 'Move Phase II');
  await movePhase(pi, false); if (isGameOver()) return;
  setPhaseUI(pi, 'End Phase');
  await endPhase(pi);
}

export async function gameLoop(context) {
  const { players, currentPlayerIndex, setCurrentPlayerIndex, updateHUD, sleep, playTurn, isGameOver } = context;
  while (!isGameOver()) {
    await playTurn(currentPlayerIndex());
    if (isGameOver()) break;
    setCurrentPlayerIndex((currentPlayerIndex() + 1) % players().length);
    updateHUD();
    await sleep(300);
  }
}
