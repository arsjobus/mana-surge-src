import { GameState } from './state/GameState.js';
import { createLocalActionAdapter, validateActionIntent } from './multiplayer/ActionSystem.js';
import { createBoardInput } from './ui/BoardInput.js';
import { createGameHUD } from './ui/GameHUD.js';
import { presentVictory } from './ui/ModalUI.js';
import { createUIStage } from './ui/UIStage.js';
import { loadBGM, startBGM } from './systems/AudioSystem.js';
import { createMainScene } from './scenes/MainScene.js';
import { createGameConfig, GAME_WIDTH } from './config/gameConfig.js';
import { Selector, Sequence, Condition, Action } from './ai/BehaviorTree.js';
import { cpuChooseMove } from './ai/CpuMoveAI.js';
import { cpuChooseAttack, cpuShouldUseDagger as aiShouldUseDagger } from './ai/CpuCombatAI.js';
import { MatchSession } from './multiplayer/MatchSession.js';
import { SessionCoordinator } from './multiplayer/SessionCoordinator.js';
/* ======================================================================
   MANA SURGE — browser game runtime
   ====================================================================== */
'use strict';

import { HEX_SIZE, key, neighbors, hexDistance, axialToPixel } from './utils/hex.js';
import { sleep } from './utils/async.js';
import { TILE_INFO, LOCKING_TYPES, COLOR_META } from './data/gameData.js';
import { WEIGHT_PRESETS } from './data/aiWeights.js';
import * as BoardModel from './board/BoardModel.js';
import { buildTextures, renderBoard as drawBoard } from './board/BoardRenderer.js';
import { TOKEN_SCALE, createTroop as createTroopView, destroyTroop as destroyTroopView, refreshLockVisual as refreshTroopLockVisual, burst as troopBurst, moveSpritesTo as moveTroopSprites } from './entities/Troop.js';
import { daggerAvailable as combatDaggerAvailable, performSacrifice as resolveSacrifice, executeAttack as resolveAttack } from './systems/CombatSystem.js';
import { startPhase as runStartPhase, chooseCpuSpawnTile } from './systems/SpawnSystem.js';
import { playTurn as runTurn, gameLoop as runGameLoop, endPhase as runEndPhase, executeMove as runExecuteMove, movePhase as runMovePhase, combatPhase as runCombatPhase } from './systems/TurnSystem.js';

export const gameState = new GameState();
const localActions = createLocalActionAdapter();

/* ---------------------------------------------------------------------
   Hex math (pointy-top, axial coordinates)
--------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
   Game state
--------------------------------------------------------------------- */
let scene = null;
let multiplayerSetup = null;
let pendingGuestMoveResolve = null;
let guestMovePhaseRunning = false;
let guestSpawnPhaseRunning = false;
let guestCombatPhaseRunning = false;
let disconnectedGuestSeat = null;

/* ---------------------------------------------------------------------
   Tile type descriptions
--------------------------------------------------------------------- */
// Difficulty is chosen on the start screen and locked in for the match.
// Each tier is a full weight set for the CPU behavior tree below (see
// scoreMoveTarget / cpuChooseAttack / cpuShouldUseDagger), not just a
// mistake-chance dial. Beyond the original per-tile scoring weights, this
// genome also includes a few genuinely strategic behaviors: economyDecay
// fades the value of extra-action/extra-spawn shrines as the game nears
// its end (rush them early, stop bothering late); defendLockedBonus and
// reinforceBonus make CPUs actively defend and garrison shrines they
// already hold instead of only chasing new ones; pressureMarginScale
// makes both CPUs lean harder on whichever player -- human or CPU -- is
// closest to winning, not just a fixed target. All of it was produced by
// a companion self-play training program (see /trainer in the project
// folder): a genetic algorithm evolved the "hard" weights by playing
// thousands of 3-way CPU-vs-CPU matches (with a Hall of Fame of past
// champions in the mix, so it can't just cycle in circles) and rewarding
// wins, then a calibration pass found the mistakeChance value for
// "medium" and "easy" that makes each one win a target fraction of its
// matches against "hard". Regenerate these by running
// `node train.js && node calibrate.js weights/evolved.json` in that
// folder and pasting the resulting JSON back in here.
function AIW(){ return WEIGHT_PRESETS[gameState.difficulty]; }

// Victory threshold, chosen on the start screen via the slider (10/20/30/40/50).

// Which color the human plays as (0=Red, 1=Blue, 2=Green). The board itself
// is fixed -- Red's spawner is always the left corner, Blue upper-right,
// Green bottom -- so this just decides which of those three seats the human
// sits in; the other two are always CPU-controlled, and turn order still
// goes clockwise Red -> Blue -> Green regardless of which one is human.
let boardCX = 0, boardCY = 0;
let boardInput = null;
const cssColor = hex => '#'+hex.toString(16).padStart(6,'0');
const hud = createGameHUD({state:gameState,cssColor,actions:localActions});
function inputContext(){return {state:gameState,scene,actions:localActions,getTile,getTroopAt,isLocked,isEmptyTile,neighbors,key,hexDistance,tileInfo:TILE_INFO,playerColor:playerColorHex,playerName,getStats,cssColor};}
function ensureBoardInput(){if(!boardInput)boardInput=createBoardInput(inputContext());return boardInput;}
function clearHighlights(){ensureBoardInput().clearHighlights();}
function showTileInfo(tile,troop){ensureBoardInput().showTileInfo(tile,troop);}
function onTroopClicked(troop){ensureBoardInput().onTroopClicked(troop);}
function setupTileInput(){ensureBoardInput().setup();}
function highlightSpawnOptions(coords){ensureBoardInput().highlightSpawnOptions(coords);}

function boardX(px){ return boardCX + px; }
function boardY(py){ return boardCY + py; }

function playerColorHex(pi){ return gameState.players[pi].colorHex; }
function playerName(pi){ return gameState.players[pi].name; }

function getTile(q,r){ return BoardModel.getTile(gameState.tiles,q,r); }
function isLocked(troop){ return BoardModel.isLocked(gameState.tiles,troop); }
function getStats(troop){ return BoardModel.getStats(gameState.tiles,troop); }
function getTroopAt(q,r){ return BoardModel.getTroopAt(gameState.tiles,gameState.troops,q,r); }
function isEmptyTile(coord){ return BoardModel.isEmptyTile(gameState.tiles,coord); }
function countTiles(pi,type){ return BoardModel.countTiles(gameState.tiles,gameState.troops,pi,type); }
function hasLegalMove(pi){ return BoardModel.hasLegalMove(gameState.tiles,gameState.troops,pi); }
function hasLegalAttack(pi){ return BoardModel.hasLegalAttack(gameState.tiles,gameState.troops,pi); }

// Exact board layout extracted and verified (via pixel measurement + 3-fold
// rotational symmetry validation) from the reference board image. This is a
// fixed, hand-authored layout so every match is provably identical and fair
// for all three players -- not randomly generated.
function buildBoard(){ gameState.tiles = BoardModel.buildBoard(gameState.players); }

function troopContext(){
  return {
    scene, tiles:gameState.tiles, troops:gameState.troops, nextId:()=>gameState.nextTroopId++, boardOrigin:{x:boardCX,y:boardCY},
    playerColor:playerColorHex, getStats, isLocked,
    onClick:onTroopClicked, onHover:showTileInfo,
    burst:(x,y,color,count)=>troopBurst(scene,x,y,color,count)
  };
}
function createTroop(owner,q,r,animate){ return createTroopView(troopContext(),owner,q,r,animate); }
function setupInitialTroops(){ BoardModel.setupInitialTroops(gameState.players,gameState.tiles,createTroop); }

function waitFor(kind,pi,options=[]){return localActions.request(kind,pi,options);}
function validateIntent(intent,phase,pi,spawnOptions=[]){return validateActionIntent({troops:()=>gameState.troops,getTroop:id=>gameState.troops.find(troop=>troop.id===id),isLocked,isEmptyTile,neighbors,getTroopAt,daggerAvailable},intent,{phase,playerIndex:pi,spawnOptions});}
/* Guests replace the shared model immediately, then present the change the way the
   host sees it (tweened moves, spawn pop-in, combat/sacrifice/mana effects). The
   presentation runs on one ordered queue so rapid host updates never overlap. */
let guestVisualQueue = Promise.resolve();
function queueGuestVisual(step){
  guestVisualQueue = guestVisualQueue.then(step).catch(error => console.error('Guest visual effect failed:', error));
}
function troopSprites(troop){ return [troop.sprite, troop.glow, troop.lockSprite, troop.selSprite, troop.statText]; }
function placeTroopSprites(troop,q,r){
  const pixel = axialToPixel(q, r, HEX_SIZE);
  for (const sprite of troopSprites(troop)) sprite?.setPosition(boardX(pixel.x), boardY(pixel.y));
}
function discardTroopSprites(troop){
  troop._lockTween?.stop();
  for (const sprite of troopSprites(troop)) sprite?.destroy();
}
/** `action` is the host's accepted action (null for plain snapshots); `animate: false` snaps to the snapshot. */
function applyHostSnapshot(snapshot, action = null, { animate = true } = {}){
  if (!snapshot || !Array.isArray(snapshot.players) || snapshot.players.length !== 3 || !Array.isArray(snapshot.tiles) || snapshot.tiles.length !== gameState.tiles.size || !Array.isArray(snapshot.troops) || !Number.isSafeInteger(snapshot.nextTroopId) || !Number.isSafeInteger(snapshot.winScore)) return false;
  const tileKeys = new Set();
  if (snapshot.tiles.some(tile => { const tileKey = key(tile.q,tile.r); if (!Number.isInteger(tile.q) || !Number.isInteger(tile.r) || !gameState.tiles.has(tileKey) || tileKeys.has(tileKey) || !Object.hasOwn(TILE_INFO,tile.type)) return true; tileKeys.add(tileKey); return false; })) return false;
  const troopIds = new Set();
  const troopCoords = new Set();
  for (const troop of snapshot.troops) {
    const coordKey = key(troop.q,troop.r);
    if (!Number.isSafeInteger(troop.id) || troop.id < 1 || troopIds.has(troop.id) || !Number.isInteger(troop.owner) || troop.owner < 0 || troop.owner > 2 || !gameState.tiles.has(coordKey) || troopCoords.has(coordKey)) return false;
    troopIds.add(troop.id);
    troopCoords.add(coordKey);
  }
  if (snapshot.nextTroopId <= Math.max(0, ...troopIds) || snapshot.players.some(player => !Number.isSafeInteger(player.mana) || !Number.isSafeInteger(player.actionPoints) || !player.spawner || !Number.isInteger(player.spawner.q) || !Number.isInteger(player.spawner.r))) return false;
  // Keep sprites for troops that still exist so they can tween to their new
  // tile instead of being rebuilt or teleported.
  const existing = new Map(gameState.troops.map(troop => [troop.id, troop]));
  const oldMana = gameState.players.map(player => player.mana);
  const attacker = action?.type === 'attack' ? existing.get(action.attackerId) : null;
  const defender = action?.type === 'attack' ? existing.get(action.defenderId) : null;
  const attackInfo = attacker && defender ? { attacker, defender, attackerStats: getStats(attacker), defenderStats: getStats(defender) } : null;
  for (const tile of gameState.tiles.values()) tile.occupantId = null;
  gameState.troops = [];
  snapshot.players.forEach((player, i) => Object.assign(gameState.players[i], { mana: player.mana, actionPoints: player.actionPoints, spawner: { ...player.spawner } }));
  for (const item of snapshot.tiles) Object.assign(getTile(item.q,item.r), { type: item.type, occupantId: null });
  const moves = [], spawns = [];
  for (const item of snapshot.troops) {
    let troop = existing.get(item.id);
    if (troop) {
      existing.delete(item.id);
      const moved = troop.q !== item.q || troop.r !== item.r;
      troop.owner = item.owner;
      troop.q = item.q;
      troop.r = item.r;
      if (moved && animate) moves.push({ troop, q: item.q, r: item.r });
      else if (moved) placeTroopSprites(troop, item.q, item.r);
      if (!moved || !animate) refreshLockVisual(troop);
      gameState.troops.push(troop);
    } else {
      troop = createTroop(item.owner,item.q,item.r,false);
      troop.id = item.id;
      if (animate) {
        // Hidden until the queued pop-in plays, matching the host's spawn effect.
        troop.sprite.setScale(0); troop.glow.setAlpha(0); troop.statText.setAlpha(0);
        spawns.push(troop);
      }
    }
    getTile(item.q,item.r).occupantId = item.id;
  }
  const removed = [...existing.values()];
  // A troop that vanished while moving was impaled on thorns: show it arrive first.
  const thornsVictim = animate && action?.type === 'move' ? removed.find(troop => troop.id === action.troopId) : null;
  if (thornsVictim && gameState.tiles.has(key(action.to.q, action.to.r))) moves.push({ troop: thornsVictim, q: action.to.q, r: action.to.r, thorns: true });
  const manaGains = snapshot.players.map((player, i) => player.mana > oldMana[i]);
  gameState.nextTroopId = snapshot.nextTroopId;
  gameState.winScore = snapshot.winScore;
  gameState.currentPlayerIndex = snapshot.activeSeat;
  gameState.stateVersion = snapshot.stateVersion;
  clearHighlights();
  updateHUD();
  if (!animate) {
    removed.forEach(discardTroopSprites);
    return true;
  }
  if (!attackInfo && !moves.length && !spawns.length && !removed.length && !manaGains.some(Boolean)) return true;
  queueGuestVisual(async () => {
    if (attackInfo) {
      const { attackerStats: a, defenderStats: d } = attackInfo;
      log(`⚔️ ${coloredName(attackInfo.attacker.owner)} (${a.atk}/${a.def}) attacks ${coloredName(attackInfo.defender.owner)} (${d.atk}/${d.def}).`);
      burst((attackInfo.attacker.sprite.x + attackInfo.defender.sprite.x) / 2, (attackInfo.attacker.sprite.y + attackInfo.defender.sprite.y) / 2, 0xffffff, 20);
      await sleep(200);
      if (!removed.length) log('Both troops bounce off harmlessly.');
    }
    for (const troop of spawns) {
      scene.tweens.add({ targets: troop.sprite, scale: TOKEN_SCALE, duration: 280, ease: 'Back.easeOut' });
      troop.glow.setAlpha(0.5); troop.statText.setAlpha(1);
      burst(troop.sprite.x, troop.sprite.y, playerColorHex(troop.owner), 14);
    }
    if (moves.length) await Promise.all(moves.map(({ troop, q, r }) => { const pixel = axialToPixel(q, r, HEX_SIZE); return moveSpritesTo(troop, boardX(pixel.x), boardY(pixel.y)); }));
    for (const { troop, thorns } of moves) {
      if (thorns) { log(`💀 ${coloredName(troop.owner)}'s troop is impaled by thorns!`); continue; }
      refreshLockVisual(troop);
      const tile = getTile(troop.q, troop.r);
      if (action?.type === 'move' && troop.id === action.troopId && LOCKING_TYPES.includes(tile.type)) log(`${coloredName(troop.owner)} claims ${TILE_INFO[tile.type].name}.`);
    }
    for (const troop of removed) {
      troop._lockTween?.stop();
      await destroyTroop(troop, troop === thornsVictim);
    }
    const center = axialToPixel(0, 0, HEX_SIZE);
    manaGains.forEach((gained, pi) => {
      if (!gained) return;
      const player = gameState.players[pi];
      if (action?.type === 'sacrifice') { log(`🗡️ ${coloredName(pi)} sacrifices 3 troops for 1 mana. (${player.mana}/${gameState.winScore})`); burst(boardX(center.x), boardY(center.y), 0xc9b8ff, 24); }
      else { log(`✨ ${coloredName(pi)} channels a Mana Point! (${player.mana}/${gameState.winScore})`); burst(boardX(center.x), boardY(center.y), 0xffd76a, 30); }
    });
  });
  return true;
}
function requestGuestMove(action){
  const session = gameState.session;
  if (session?.role !== 'guest' || pendingGuestMoveResolve) return Promise.resolve(false);
  return new Promise(resolve => {
    pendingGuestMoveResolve = resolve;
    if (!session.requestAction(action, session.nextRequestSeq)) {
      pendingGuestMoveResolve = null;
      resolve(false);
    }
  });
}
function requestGuestCombat(action){ return requestGuestMove(action); }
function requestGuestSacrifice(troopIds){ return requestGuestMove({ type: 'sacrifice', troopIds }); }
function requestGuestSacrificeCancel(){ return requestGuestMove({ type: 'cancelSacrifice' }); }
function requestGuestSpawn(tile){
  const session = gameState.session;
  if (session?.role !== 'guest' || pendingGuestMoveResolve) return Promise.resolve(null);
  return new Promise(resolve => {
    pendingGuestMoveResolve = accepted => resolve(accepted ? tile : null);
    if (!session.requestAction({ type: 'spawn', tile }, session.nextRequestSeq)) {
      pendingGuestMoveResolve = null;
      resolve(null);
    }
  });
}
function startGuestMovePhase(){
  const session = gameState.session;
  if (session?.role !== 'guest' || !['move1', 'move2'].includes(session.phase) || session.activeSeat !== session.localSeat || guestMovePhaseRunning || gameState.gameOver) return;
  guestMovePhaseRunning = true;
  runMovePhase(ruleContext(), session.localSeat, session.phase === 'move1').catch(error => console.error('Guest move phase failed:', error)).finally(() => { guestMovePhaseRunning = false; });
}
function startGuestSpawnPhase(){
  const session = gameState.session;
  if (session?.role !== 'guest' || session.phase !== 'spawn' || session.activeSeat !== session.localSeat || guestSpawnPhaseRunning || gameState.gameOver) return;
  guestSpawnPhaseRunning = true;
  runStartPhase(ruleContext(), session.localSeat).catch(error => console.error('Guest spawn phase failed:', error)).finally(() => { guestSpawnPhaseRunning = false; });
}
function startGuestCombatPhase(){
  const session = gameState.session;
  if (session?.role !== 'guest' || session.phase !== 'combat' || session.activeSeat !== session.localSeat || guestCombatPhaseRunning || gameState.gameOver) return;
  guestCombatPhaseRunning = true;
  runCombatPhase(ruleContext(), session.localSeat).catch(error => console.error('Guest combat phase failed:', error)).finally(() => { guestCombatPhaseRunning = false; });
}
function ruleContext(){return {players:()=>gameState.players,troops:()=>gameState.troops,tiles:()=>gameState.tiles,countTiles,getTile,isLocked,getStats,isEmptyTile,neighbors,sleep,log,coloredName,cssColor,createTroop,destroyTroop,waitFor,validateIntent,updateHUD,document,hexSize:HEX_SIZE,axialToPixel:(q,r)=>axialToPixel(q,r,HEX_SIZE),boardX,boardY,burst,winScore:gameState.winScore,setGameOver:value=>{gameState.gameOver=value;},showVictory:pi=>{gameState.session?.endForVictory(pi);showVictory(pi);},weights:AIW,cpuChooseSpawnTile:(_pi,options)=>chooseCpuSpawnTile({getTile},options),waitForSpawn:chooseSpawnTileHuman,hasLegalMove,hasLegalAttack,daggerAvailable,gameOver:()=>gameState.gameOver,performSacrifice,executeMove,executeAttack,clearHighlights,waitUntilResumed:()=>gameState.session?.waitUntilResumed(),multiplayerRole:gameState.session?.role,requestGuestMove,requestGuestCombat,requestGuestSacrifice,requestGuestSacrificeCancel,publishState:()=>{const session=gameState.session;if(session?.role==='host')session.publishSnapshot(session.createSnapshot(gameState));},actionApplied:action=>{const session=gameState.session;if(session?.role==='host')session.publishAccepted(action,{type:action.type},session.createSnapshot(gameState));},setDecision:(seat,phase)=>{const session=gameState.session;if(!session)return;session.setDecision({seat,phase});if(session.role==='host')session.publishSnapshot(session.createSnapshot(gameState));},moveDecision:(pi,isPreCombat)=>CPU_MOVE_TREE({pi,isPreCombat}),combatDecision:pi=>CPU_COMBAT_TREE({pi})};}
function daggerAvailable(pi){return combatDaggerAvailable({countTiles,troops:()=>gameState.troops},pi);}
function cpuShouldUseDagger(pi){return aiShouldUseDagger({players:gameState.players,troops:gameState.troops,weights:AIW()},pi);}

/* ---------------------------------------------------------------------
   Background music
   ---------------------------------------------------------------------
   Loads assets/music/bgm.mp3 (relative to this HTML file) and loops it
   during actual gameplay. This is the one asset in the whole game that
   ISN'T embedded inline, so unlike the SVG textures it goes through
   Phaser's normal loader and normal HTTP(S)/relative-path rules apply:
   if this file is opened directly (double-clicked, file:// URL), some
   browsers block loading local sibling files over file:// entirely, and
   the load will fail. That's handled gracefully below -- the game just
   plays silently rather than breaking. Serving the folder from a simple
   local web server (e.g. `python3 -m http.server`) avoids the issue.
--------------------------------------------------------------------- */
// Audio loading and mute wiring live in AudioSystem.


/* ---------------------------------------------------------------------
   Texture generation (SVG -> Phaser textures)
--------------------------------------------------------------------- */


async function destroyTroop(troop, isThorns){ return destroyTroopView(troopContext(),troop,isThorns); }
function refreshLockVisual(troop){ refreshTroopLockVisual(troopContext(),troop); }
function burst(x,y,color,count){ troopBurst(scene,x,y,color,count); }
function moveSpritesTo(troop,x,y){ return moveTroopSprites(scene,troop,x,y); }

/* ---------------------------------------------------------------------
   UI modules
--------------------------------------------------------------------- */
function buildManaPanel(){ hud.buildManaPanel(); }
function updateHUD(){ hud.updateHUD(); }
function setPhaseUI(pi,phase){ hud.setPhaseUI(pi,phase); }
function log(msg){ hud.log(msg); }
function showHostDisconnected(){
  gameState.gameOver = true;
  localActions.cancel();
  pendingGuestMoveResolve?.(false);
  pendingGuestMoveResolve = null;
  gameState.multiplayerCoordinator?.close();
  const title = document.getElementById('victory-title');
  const message = document.getElementById('victory-text');
  title.textContent = 'Match ended';
  title.style.color = '#e8c974';
  message.textContent = 'The host disconnected. This match has ended. Restart to return to solo setup.';
  document.getElementById('guest-disconnect-actions').style.display = 'none';
  document.getElementById('host-disconnect-actions').style.display = 'flex';
  document.getElementById('rejoin-host-btn').onclick = () => multiplayerSetup?.reopenLobby?.();
  document.getElementById('victory-modal').style.display = 'flex';
}
function showGuestDisconnected({ seat, name }) {
  disconnectedGuestSeat = seat;
  const title = document.getElementById('victory-title');
  title.textContent = 'Guest disconnected';
  title.style.color = '#e8c974';
  document.getElementById('victory-text').textContent = `${name} disconnected. Create a fresh invite for this seat, replace it with a CPU, or end the match.`;
  document.getElementById('host-disconnect-actions').style.display = 'none';
  document.getElementById('guest-disconnect-actions').style.display = 'flex';
  document.getElementById('victory-modal').style.display = 'flex';
}
document.getElementById('replace-guest-btn').addEventListener('click', () => {
  const seat = disconnectedGuestSeat;
  const session = gameState.session;
  if (seat === null || !session?.replaceDisconnectedGuest(seat)) return;
  localActions.cancel();
  gameState.players[seat].human = false;
  gameState.multiplayerCoordinator?.removePeer(seat);
  document.getElementById('guest-disconnect-actions').style.display = 'none';
  document.getElementById('host-disconnect-actions').style.display = 'none';
  document.getElementById('victory-modal').style.display = 'none';
  disconnectedGuestSeat = null;
  updateHUD();
});
document.getElementById('retry-guest-btn').addEventListener('click', async () => {
  const seat = disconnectedGuestSeat;
  if (seat === null || !multiplayerSetup?.retryGuest) return;
  const ok = await multiplayerSetup.retryGuest(seat);
  if (!ok) return;
  document.getElementById('victory-text').textContent = 'Fresh invite created. Send it to the same player, then paste their new answer code in the lobby.';
  document.getElementById('guest-disconnect-actions').style.display = 'none';
  disconnectedGuestSeat = null;
  multiplayerSetup.reopenLobby?.();
});
document.getElementById('end-disconnected-match-btn').addEventListener('click', () => {
  const seat = disconnectedGuestSeat;
  if (seat === null || !gameState.session?.endForGuestDisconnect(seat)) return;
  gameState.gameOver = true;
  localActions.cancel();
  gameState.multiplayerCoordinator?.close();
  document.getElementById('victory-title').textContent = 'Match ended';
  document.getElementById('victory-text').textContent = 'The match ended after a guest disconnected. Restart to return to solo setup.';
  document.getElementById('guest-disconnect-actions').style.display = 'none';
  document.getElementById('host-disconnect-actions').style.display = 'none';
  document.getElementById('victory-modal').style.display = 'flex';
});
hud.setupActionButtons(clearHighlights);

/* ---------------------------------------------------------------------
   Game flow
--------------------------------------------------------------------- */
async function startPhase(pi){
  return runStartPhase(ruleContext(),pi);
}

function chooseSpawnTileHuman(options,pi=gameState.currentPlayerIndex){
  if (gameState.session?.role === 'guest') {
    const session = gameState.session;
    return new Promise(resolve => {
      const choose = async () => {
        const intent = await waitFor('spawnChoice', pi, options);
        clearHighlights();
        const checked = validateIntent(intent, 'spawn', pi, options);
        if (!checked) { resolve(options[0]); return; }
        resolve(await requestGuestSpawn(checked.coord));
      };
      document.getElementById('skip-btn').disabled = true;
      highlightSpawnOptions(options);
      choose();
    });
  }
  document.getElementById('skip-btn').disabled = true;
  const promise = waitFor('spawnChoice', pi, options);
  highlightSpawnOptions(options);
  return promise.then(intent=>{
    clearHighlights();
    if (intent?.type === 'cancel' && gameState.session?.roster?.[pi]?.controller === 'cpu') return chooseCpuSpawnTile({getTile}, options);
    return validateIntent(intent,'spawn',pi,options)?.coord || options[0];
  });
}

function cpuChooseSpawnTile(pi, options){
  return chooseCpuSpawnTile({getTile},options);
}

async function performSacrifice(pi){
  return resolveSacrifice(ruleContext(),pi);
}

const aiContext = () => ({ state: gameState, weights: AIW(), getTile, getTroopAt, getStats, isLocked, isEmptyTile });
const chooseMove = (pi) => cpuChooseMove(aiContext(), pi);
const chooseAttack = (pi) => cpuChooseAttack(aiContext(), pi);
const UNMISSABLE_CLAIM_TYPES = ['mana_pool','extra_action','extra_spawn','dagger'];
const CPU_MOVE_TREE = Selector(
  Sequence(
    Condition(bb => bb.isPreCombat && gameState.players[bb.pi].actionPoints <= 1),
    Condition(bb => { bb.pendingAttack = chooseAttack(bb.pi); return !!bb.pendingAttack; }),
    Condition(bb => {
      bb.bestMove = chooseMove(bb.pi);
      if(!bb.bestMove) return true;
      const targetType = getTile(bb.bestMove.target.q, bb.bestMove.target.r).type;
      return !UNMISSABLE_CLAIM_TYPES.includes(targetType);
    }),
    Action(() => ({type:'hold'}))
  ),
  Sequence(
    Condition(bb => { bb.bestMove = bb.bestMove || chooseMove(bb.pi); return !!bb.bestMove; }),
    Action(bb => ({type:'move', troop:bb.bestMove.troop, target:bb.bestMove.target}))
  ),
  Sequence(Condition(bb => daggerAvailable(bb.pi)), Condition(bb => cpuShouldUseDagger(bb.pi)), Action(() => ({type:'sacrifice'}))),
  Action(() => ({type:'pass'}))
);
const CPU_COMBAT_TREE = Selector(
  Sequence(Condition(bb => { bb.bestAttack = chooseAttack(bb.pi); return !!bb.bestAttack; }),
    Action(bb => ({type:'attack', attacker:bb.bestAttack.attacker, defender:bb.bestAttack.defender}))),
  Sequence(Condition(bb => daggerAvailable(bb.pi)), Condition(bb => cpuShouldUseDagger(bb.pi)), Action(() => ({type:'sacrifice'}))),
  Action(() => ({type:'pass'}))
);

async function movePhase(pi, isPreCombat){ return runMovePhase(ruleContext(), pi, isPreCombat); }

async function combatPhase(pi){ return runCombatPhase(ruleContext(), pi); }

async function endPhase(pi){
  return runEndPhase(ruleContext(), pi);
}

async function executeMove(troop, targetTile){
  return runExecuteMove({ ...ruleContext(), hexSize: HEX_SIZE, moveSpritesTo, refreshLockVisual, lockingTypes: LOCKING_TYPES, tileInfo: TILE_INFO }, troop, targetTile);
}

async function executeAttack(attacker, defender){
  return resolveAttack(ruleContext(),attacker,defender);
}

function coloredName(pi){
  return `<span style="color:${cssColor(playerColorHex(pi))}">${playerName(pi)}</span>`;
}

/* ---------------------------------------------------------------------
   Main loop
--------------------------------------------------------------------- */
async function playTurn(pi){
return runTurn({...ruleContext(),setPhaseUI,startPhase,movePhase,combatPhase,endPhase,isGameOver:()=>gameState.gameOver},pi);
}
async function gameLoop(){
  return runGameLoop({...ruleContext(),currentPlayerIndex:()=>gameState.currentPlayerIndex,setCurrentPlayerIndex:(value)=>{gameState.currentPlayerIndex=value;},playTurn,isGameOver:()=>gameState.gameOver});
}

function showVictory(pi){
  presentVictory({state:gameState,pi,scene,cssColor,coloredName,boardX,boardY,burst,axialToPixel,hexSize:HEX_SIZE});
}

/* ---------------------------------------------------------------------
   Phaser scene
--------------------------------------------------------------------- */
const MainScene = createMainScene({state:gameState,buildTextures,loadBGM,setupMatch:async(thisScene,origin,bgm)=>{
    scene=thisScene;boardCX=origin.x;boardCY=origin.y;boardInput=createBoardInput(inputContext());
    if (multiplayerSetup) {
      const { role, hostSeat, localSeat, roster, matchId, peers, peer } = multiplayerSetup;
      const local = role === 'host' ? hostSeat : localSeat;
      gameState.players = COLOR_META.map((c, i) => ({ ...c, human: role === 'host' ? roster[i]?.controller !== 'cpu' : i === local, mana: 0, actionPoints: 1 }));
      const coordinator = new SessionCoordinator({ role, matchId, localSeat: local, onMessage: async ({ seat, message }) => {
        if (message.type === 'actionRequest' && role === 'host' && gameState.session) {
          const action = message.payload;
          const phase = gameState.session.phase;
          const intent = action.type === 'spawn' && phase === 'spawn'
            ? { type: 'spawn', q: action.tile.q, r: action.tile.r }
            : action.type === 'move' && ['move1', 'move2'].includes(phase)
              ? { type: 'move', troopId: action.troopId, q: action.to.q, r: action.to.r }
            : action.type === 'attack' && phase === 'combat'
              ? { type: 'attack', attackerId: action.attackerId, defenderId: action.defenderId }
              : action.type === 'pass' && ['move1', 'move2', 'combat'].includes(phase) ? { type: 'skip' }
                : action.type === 'sacrifice' && ['move1', 'move2', 'combat'].includes(phase) ? { type: 'sacrifice', troopIds: action.troopIds } : action.type === 'cancelSacrifice' && ['move1', 'move2', 'combat'].includes(phase) ? { type: 'cancel' } : null;
          const pendingKind = phase === 'spawn' ? 'spawnChoice' : ['sacrifice', 'cancelSacrifice'].includes(action.type) ? 'sacrifice' : phase === 'combat' ? 'attack' : 'move';
          const pending = localActions.current();
          const checked = action.type === 'cancelSacrifice' && pending?.kind === 'sacrifice'
            ? { type: 'cancel' }
            : intent && validateIntent(intent, action.type === 'sacrifice' ? 'sacrifice' : phase === 'spawn' ? 'spawn' : phase === 'combat' ? 'attack' : 'move', seat, pending?.options || []);
          const requestSeq = (gameState.session.lastRequestSeq.get(seat) || 0) + 1;
          let rejection = null;
          if (message.rateLimited) rejection = 'RATE_LIMITED';
          else if (gameState.session.roster?.[seat]?.controller !== 'guest') rejection = 'NOT_YOUR_SEAT';
          else if (gameState.session.activeSeat !== seat || pending?.playerIndex !== seat || (action.type === 'sacrifice' ? !['move', 'attack', 'sacrifice'].includes(pending?.kind) : pending?.kind !== pendingKind)) rejection = 'NOT_YOUR_TURN';
          else if (!['move1', 'move2', 'spawn', 'combat'].includes(phase)) rejection = 'WRONG_PHASE';
          else if (!checked) rejection = 'ILLEGAL_ACTION';
          if (rejection) coordinator.sendTo(seat, 'actionRejected', { requestSeq, code: rejection });
          else {
            const authorized = gameState.session.authorizeRequest(seat, action, requestSeq);
            if (!authorized.ok) coordinator.sendTo(seat, 'actionRejected', { requestSeq, code: authorized.code });
            else if (action.type === 'sacrifice') {
              const player = gameState.players[seat];
              const context = { ...ruleContext(), waitFor: async () => intent };
              const succeeded = await resolveSacrifice(context, seat);
              if (succeeded) {
                player.actionPoints--;
                // The host's turn loop is waiting for its own local choice for
                // this guest seat. Release that prompt after applying the guest
                // action so it can continue from the updated authoritative state.
                localActions.submit({ type: 'skip' });
                gameState.session.publishAccepted(action, { type: 'sacrifice' }, gameState.session.createSnapshot(gameState));
                updateHUD();
              } else coordinator.sendTo(seat, 'actionRejected', { requestSeq, code: 'ILLEGAL_ACTION' });
            } else { localActions.submit(intent); if (action.type === 'cancelSacrifice') gameState.session.publishAccepted(action, { type: 'cancelSacrifice' }, gameState.session.createSnapshot(gameState)); }
          }
        }
        if (message.type === 'hello' && role === 'host' && gameState.session) {
          coordinator.sendTo(seat, 'seatAssignment', { seat, snapshot: gameState.session.createSnapshot(gameState) });
          gameState.session.resumeGuest(seat);
        }
        if (message.type === 'seatAssignment' && role === 'guest') {
          const snapshot = message.payload.snapshot;
          if (gameState.session?.acceptSnapshot({ stateVersion: snapshot.stateVersion, state: snapshot }, state => applyHostSnapshot(state, null, { animate: false }))) gameState.session.onStatus(`Connected as ${gameState.players[local].name}. Waiting for host actions.`);
        }
        if ((message.type === 'snapshot' || message.type === 'actionAccepted') && role === 'guest') {
          const accepted = message.type === 'snapshot'
            ? gameState.session?.acceptSnapshot(message.payload, state => applyHostSnapshot(state))
            : gameState.session?.acceptHostUpdate(message.payload, state => applyHostSnapshot(state, message.payload.action));
          if (!accepted) gameState.session?.onStatus('Host update was invalid or out of order. Waiting for a fresh snapshot.');
          else if (message.type === 'actionAccepted' && pendingGuestMoveResolve) {
            const resolve = pendingGuestMoveResolve;
            pendingGuestMoveResolve = null;
            resolve(true);
          }
          if (accepted) { startGuestSpawnPhase(); startGuestMovePhase(); startGuestCombatPhase(); }
        }
        if (message.type === 'matchEnded' && role === 'guest') {
          const winnerSeat = message.payload.winnerSeat;
          if (gameState.session?.acceptMatchEnd(winnerSeat)) {
            gameState.gameOver = true;
            localActions.cancel();
            pendingGuestMoveResolve?.(false);
            pendingGuestMoveResolve = null;
            // Let queued combat/mana effects finish before the result modal covers them.
            queueGuestVisual(() => showVictory(winnerSeat));
          }
        }
        if (message.type === 'actionRejected' && role === 'guest') {
          if (!gameState.session) return;
          gameState.session.pendingRequest = null;
          const resolve = pendingGuestMoveResolve;
          pendingGuestMoveResolve = null;
          resolve?.(false);
          gameState.session.onStatus(`Host rejected the action (${message.payload.code}).`);
        }
        if (message.type === 'disconnect') gameState.session?.peerDisconnected(seat);
      }, onPeerState: (seat, status) => {
        if (status === 'connected' && role === 'guest') coordinator.startHandshake(seat);
        if (status === 'disconnected' || status === 'failed' || status === 'closed') gameState.session?.peerDisconnected(seat);
      } });
      if (role === 'host') for (const [seat, hostPeer] of peers) coordinator.addPeer(seat, hostPeer);
      else coordinator.addPeer(hostSeat, peer);
      gameState.multiplayerCoordinator = coordinator;
      gameState.session = new MatchSession({ role, localSeat: local, hostSeat, matchId, roster,
        sendTo: (seat, type, payload) => coordinator.sendTo(seat, type, payload),
        broadcast: (type, payload) => coordinator.broadcast(type, payload),
        onStatus: message => { const el = document.getElementById('phase-text'); if (el) el.textContent = message; },
        onEnd: result => { if (result.reason === 'hostDisconnected') showHostDisconnected(); },
        onGuestDisconnect: showGuestDisconnected
      });
      if (role === 'host') coordinator.broadcast('matchStarted', {});
      if (role === 'guest' && peer.channel?.readyState === 'open') coordinator.startHandshake(hostSeat);
    } else {
      gameState.players=COLOR_META.map((c,i)=>({...c,human:i===gameState.humanColorIndex,mana:0,actionPoints:1}));
      gameState.session = null;
      gameState.multiplayerCoordinator?.close();
      gameState.multiplayerCoordinator = null;
    }
    try{
      buildBoard();
      drawBoard(thisScene, gameState.tiles, gameState.players, {x:boardCX, y:boardCY});
      setupTileInput();
      setupInitialTroops();
      buildManaPanel();
      updateHUD();
      startBGM(thisScene,bgm);
      gameState.currentPlayerIndex = 0;
      syncUIStage();
      if (multiplayerSetup?.role !== 'guest') gameLoop();
      else gameState.session?.onStatus('Synchronized with host. Waiting for host turn updates.');
    }catch(e){
      throw e;
    }
  },onError:(thisScene,origin)=>{
      thisScene.add.text(origin.x,origin.y,'Something went wrong — check console (F12).',{
        fontFamily:'Georgia, serif',fontSize:'18px',color:'#ff8a8a'
      }).setOrigin(0.5).setDepth(100);
  }});

/* ---------------------------------------------------------------------
   Boot / UI wiring
--------------------------------------------------------------------- */
let syncUIStage = ()=>{};
export function startGame(multiplayer = null){
  multiplayerSetup = multiplayer;
  if (multiplayer?.role === 'guest') gameState.winScore = multiplayer.winScore || gameState.winScore;
  const phaserGame = new Phaser.Game(createGameConfig(MainScene));
  syncUIStage=createUIStage(phaserGame,GAME_WIDTH);
}
