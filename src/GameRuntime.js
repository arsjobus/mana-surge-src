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
import { createTroop as createTroopView, destroyTroop as destroyTroopView, refreshLockVisual as refreshTroopLockVisual, burst as troopBurst, moveSpritesTo as moveTroopSprites } from './entities/Troop.js';
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
function applyHostSnapshot(snapshot){
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
  for (const tile of gameState.tiles.values()) tile.occupantId = null;
  for (const troop of gameState.troops) { troop.sprite?.destroy(); troop.selSprite?.destroy(); }
  gameState.troops = [];
  snapshot.players.forEach((player, i) => Object.assign(gameState.players[i], { mana: player.mana, actionPoints: player.actionPoints, spawner: { ...player.spawner } }));
  for (const item of snapshot.tiles) Object.assign(getTile(item.q,item.r), { type: item.type, occupantId: null });
  for (const item of snapshot.troops) {
    const troop = createTroop(item.owner, item.q, item.r, false);
    troop.id = item.id;
    getTile(item.q,item.r).occupantId = item.id;
  }
  gameState.nextTroopId = snapshot.nextTroopId;
  gameState.winScore = snapshot.winScore;
  gameState.currentPlayerIndex = snapshot.activeSeat;
  gameState.stateVersion = snapshot.stateVersion;
  clearHighlights();
  updateHUD();
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
  if (session?.role !== 'guest' || session.phase !== 'move1' || session.activeSeat !== session.localSeat || guestMovePhaseRunning || gameState.gameOver) return;
  guestMovePhaseRunning = true;
  runMovePhase(ruleContext(), session.localSeat, true).catch(error => console.error('Guest move phase failed:', error)).finally(() => { guestMovePhaseRunning = false; });
}
function startGuestSpawnPhase(){
  const session = gameState.session;
  if (session?.role !== 'guest' || session.phase !== 'spawn' || session.activeSeat !== session.localSeat || guestSpawnPhaseRunning || gameState.gameOver) return;
  guestSpawnPhaseRunning = true;
  runStartPhase(ruleContext(), session.localSeat).catch(error => console.error('Guest spawn phase failed:', error)).finally(() => { guestSpawnPhaseRunning = false; });
}
function ruleContext(){return {players:()=>gameState.players,troops:()=>gameState.troops,tiles:()=>gameState.tiles,countTiles,getTile,isLocked,getStats,isEmptyTile,neighbors,sleep,log,coloredName,cssColor,createTroop,destroyTroop,waitFor,validateIntent,updateHUD,document,hexSize:HEX_SIZE,axialToPixel:(q,r)=>axialToPixel(q,r,HEX_SIZE),boardX,boardY,burst,winScore:gameState.winScore,setGameOver:value=>{gameState.gameOver=value;},showVictory,weights:AIW,cpuChooseSpawnTile:(_pi,options)=>chooseCpuSpawnTile({getTile},options),waitForSpawn:chooseSpawnTileHuman,hasLegalMove,hasLegalAttack,daggerAvailable,gameOver:()=>gameState.gameOver,performSacrifice,executeMove,executeAttack,clearHighlights,multiplayerRole:gameState.session?.role,requestGuestMove,actionApplied:action=>{const session=gameState.session;if(session?.role==='host')session.publishAccepted(action,{type:action.type},session.createSnapshot(gameState));},setDecision:(seat,phase)=>{const session=gameState.session;if(!session)return;session.setDecision({seat,phase});if(session.role==='host')session.publishSnapshot(session.createSnapshot(gameState));},moveDecision:(pi,isPreCombat)=>CPU_MOVE_TREE({pi,isPreCombat}),combatDecision:pi=>CPU_COMBAT_TREE({pi})};}
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
  document.getElementById('victory-modal').style.display = 'flex';
}
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
  return promise.then(intent=>{ clearHighlights(); return validateIntent(intent,'spawn',pi,options)?.coord || options[0]; });
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
      const coordinator = new SessionCoordinator({ role, matchId, localSeat: local, onMessage: ({ seat, message }) => {
        if (message.type === 'actionRequest' && role === 'host' && gameState.session) {
          const action = message.payload;
          const phase = gameState.session.phase;
          const intent = action.type === 'spawn' && phase === 'spawn'
            ? { type: 'spawn', q: action.tile.q, r: action.tile.r }
            : action.type === 'move' && phase === 'move1'
              ? { type: 'move', troopId: action.troopId, q: action.to.q, r: action.to.r }
              : action.type === 'pass' && phase === 'move1' ? { type: 'skip' } : null;
          const pendingKind = phase === 'spawn' ? 'spawnChoice' : 'move';
          const pending = localActions.current();
          const checked = intent && validateIntent(intent, phase === 'spawn' ? 'spawn' : 'move', seat, pending?.options || []);
          const requestSeq = (gameState.session.lastRequestSeq.get(seat) || 0) + 1;
          let rejection = null;
          if (message.rateLimited) rejection = 'RATE_LIMITED';
          else if (gameState.session.roster?.[seat]?.controller !== 'guest') rejection = 'NOT_YOUR_SEAT';
          else if (gameState.session.activeSeat !== seat || pending?.playerIndex !== seat || pending?.kind !== pendingKind) rejection = 'NOT_YOUR_TURN';
          else if (!['move1', 'spawn'].includes(phase)) rejection = 'WRONG_PHASE';
          else if (!checked) rejection = 'ILLEGAL_ACTION';
          if (rejection) coordinator.sendTo(seat, 'actionRejected', { requestSeq, code: rejection });
          else {
            const authorized = gameState.session.authorizeRequest(seat, action, requestSeq);
            if (!authorized.ok) coordinator.sendTo(seat, 'actionRejected', { requestSeq, code: authorized.code });
            else localActions.submit(intent);
          }
        }
        if (message.type === 'hello' && role === 'host' && gameState.session) {
          coordinator.sendTo(seat, 'seatAssignment', { seat, snapshot: gameState.session.createSnapshot(gameState, 'spawn') });
        }
        if (message.type === 'seatAssignment' && role === 'guest') {
          const snapshot = message.payload.snapshot;
          if (gameState.session?.acceptSnapshot({ stateVersion: snapshot.stateVersion, state: snapshot }, applyHostSnapshot)) gameState.session.onStatus(`Connected as ${gameState.players[local].name}. Waiting for host actions.`);
        }
        if ((message.type === 'snapshot' || message.type === 'actionAccepted') && role === 'guest') {
          const accepted = message.type === 'snapshot'
            ? gameState.session?.acceptSnapshot(message.payload, applyHostSnapshot)
            : gameState.session?.acceptHostUpdate(message.payload, applyHostSnapshot);
          if (!accepted) gameState.session?.onStatus('Host update was invalid or out of order. Waiting for a fresh snapshot.');
          else if (message.type === 'actionAccepted' && pendingGuestMoveResolve) {
            const resolve = pendingGuestMoveResolve;
            pendingGuestMoveResolve = null;
            resolve(true);
          }
          if (accepted) { startGuestSpawnPhase(); startGuestMovePhase(); }
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
        onEnd: result => { if (result.reason === 'hostDisconnected') showHostDisconnected(); }
      });
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
