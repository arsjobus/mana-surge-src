/** Turn and phase sequencing. The scene supplies each phase implementation. */
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
