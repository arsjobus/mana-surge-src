import { GameState } from './state/GameState.js';
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

/* ---------------------------------------------------------------------
   Hex math (pointy-top, axial coordinates)
--------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
   Game state
--------------------------------------------------------------------- */
let scene = null;

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
const hud = createGameHUD({state:gameState,cssColor});
function inputContext(){return {state:gameState,scene,getTile,getTroopAt,isLocked,isEmptyTile,neighbors,key,hexDistance,tileInfo:TILE_INFO,playerColor:playerColorHex,playerName,getStats,cssColor};}
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

function waitFor(kind,pi){return new Promise(resolve=>{gameState.pending={kind,pi,resolve,selected:null,options:null,picks:[]};});}
function ruleContext(){return {players:()=>gameState.players,troops:()=>gameState.troops,tiles:()=>gameState.tiles,countTiles,getTile,isLocked,getStats,isEmptyTile,neighbors,sleep,log,coloredName,cssColor,createTroop,destroyTroop,waitFor,updateHUD,document,hexSize:HEX_SIZE,axialToPixel:(q,r)=>axialToPixel(q,r,HEX_SIZE),boardX,boardY,burst,winScore:gameState.winScore,setGameOver:value=>{gameState.gameOver=value;},showVictory,weights:AIW,cpuChooseSpawnTile:(_pi,options)=>chooseCpuSpawnTile({getTile},options),waitForSpawn:chooseSpawnTileHuman,hasLegalMove,hasLegalAttack,daggerAvailable,gameOver:()=>gameState.gameOver,performSacrifice,executeMove,executeAttack,clearHighlights,moveDecision:(pi,isPreCombat)=>CPU_MOVE_TREE({pi,isPreCombat}),combatDecision:pi=>CPU_COMBAT_TREE({pi})};}
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
hud.setupActionButtons(clearHighlights);

/* ---------------------------------------------------------------------
   Game flow
--------------------------------------------------------------------- */
async function startPhase(pi){
  return runStartPhase(ruleContext(),pi);
}

function chooseSpawnTileHuman(options){
  document.getElementById('skip-btn').disabled = true;
  const promise = waitFor('spawnChoice', gameState.currentPlayerIndex);
  gameState.pending.options = options;
  highlightSpawnOptions(options);
  return promise.then(res=>{ clearHighlights(); return res; });
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
    gameState.players=COLOR_META.map((c,i)=>({...c,human:i===gameState.humanColorIndex,mana:0,actionPoints:1}));
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
      gameLoop();
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
export function startGame(){
  const phaserGame = new Phaser.Game(createGameConfig(MainScene));
  syncUIStage=createUIStage(phaserGame,GAME_WIDTH);
}
