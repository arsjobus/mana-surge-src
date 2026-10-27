import { GameState } from './state/GameState.js';
import { Selector, Sequence, Condition, Action } from './ai/BehaviorTree.js';
import { cpuChooseMove } from './ai/CpuMoveAI.js';
import { cpuChooseAttack, cpuShouldUseDagger as aiShouldUseDagger } from './ai/CpuCombatAI.js';
/* ======================================================================
   MANA SURGE — single-file Phaser 3 implementation
   ====================================================================== */
'use strict';

import { HEX_SIZE, key, neighbors, hexDistance, axialToPixel, rotateAxial, shuffle } from './utils/hex.js';
import { sleep, tweenPromise } from './utils/async.js';
import { TILE_INFO, LOCKING_TYPES, COLOR_META } from './data/gameData.js';
import { WEIGHT_PRESETS } from './data/aiWeights.js';
import * as BoardModel from './board/BoardModel.js';
import { buildTextures, renderBoard as drawBoard } from './board/BoardRenderer.js';
import { TOKEN_SCALE, createTroop as createTroopView, destroyTroop as destroyTroopView, refreshLockVisual as refreshTroopLockVisual, burst as troopBurst, moveSpritesTo as moveTroopSprites } from './entities/Troop.js';
import { daggerAvailable as combatDaggerAvailable, performSacrifice as resolveSacrifice, executeAttack as resolveAttack } from './systems/CombatSystem.js';
import { startPhase as runStartPhase, chooseCpuSpawnTile } from './systems/SpawnSystem.js';
import { playTurn as runTurn, gameLoop as runGameLoop, endPhase as runEndPhase, executeMove as runExecuteMove, movePhase as runMovePhase, combatPhase as runCombatPhase } from './systems/TurnSystem.js';

const gameState = new GameState();

/* ---------------------------------------------------------------------
   Hex math (pointy-top, axial coordinates)
--------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
   Game state
--------------------------------------------------------------------- */
let scene = null;
let bgmSound = null;

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
let highlightSprites = [];
let selectionSprite = null;

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
function loadBGM(scene){
  return new Promise((resolve)=>{
    let settled = false;
    const finish = (sound)=>{ if(!settled){ settled = true; resolve(sound); } };
    try{
      scene.load.audio('bgm', 'assets/music/bgm.mp3');
      scene.load.once('complete', ()=>{
        try{ finish(scene.sound.add('bgm', {loop:true, volume:0.4})); }
        catch(e){ console.warn('BGM could not be created:', e); finish(null); }
      });
      scene.load.once('loaderror', (file)=>{
        console.warn('BGM failed to load (expected if this file was opened directly via '+
          'file:// -- try serving the folder from a local web server instead):', file && file.src);
        finish(null);
      });
      scene.load.start();
    }catch(e){
      console.warn('BGM loading skipped:', e);
      finish(null);
    }
    setTimeout(()=>finish(null), 8000); // safety net, never block the game on this
  });
}
function startBGM(scene, sound){
  if(!sound) return;
  bgmSound = sound;
  const tryPlay = ()=>{ try{ sound.play(); }catch(e){ console.warn('BGM play failed:', e); } };
  if(scene.sound.locked) scene.sound.once('unlocked', tryPlay);
  else tryPlay();
  const btn = document.getElementById('mute-btn');
  btn.style.display = 'flex';
  btn.style.alignItems = 'center';
  btn.style.justifyContent = 'center';
  btn.addEventListener('click', ()=>{
    sound.setMute(!sound.mute);
    btn.textContent = sound.mute ? '🔇' : '🔊';
  });
}


/* ---------------------------------------------------------------------
   Texture generation (SVG -> Phaser textures)
--------------------------------------------------------------------- */


async function destroyTroop(troop, isThorns){ return destroyTroopView(troopContext(),troop,isThorns); }
function refreshLockVisual(troop){ refreshTroopLockVisual(troopContext(),troop); }
function burst(x,y,color,count){ troopBurst(scene,x,y,color,count); }
function moveSpritesTo(troop,x,y){ return moveTroopSprites(scene,troop,x,y); }

/* ---------------------------------------------------------------------
   Highlighting & tile info
--------------------------------------------------------------------- */
function clearHighlights(){
  highlightSprites.forEach(s=>{ if(s && s.setAlpha) s.setAlpha(0); if(s && s._tween){ s._tween.stop(); s._tween=null; } });
  highlightSprites = [];
  if(selectionSprite){ selectionSprite.setAlpha(0); selectionSprite=null; }
}
function highlightTroopSelected(troop){
  troop.selSprite.setAlpha(1);
  if(troop.selSprite._tween) troop.selSprite._tween.stop();
  troop.selSprite._tween = scene.tweens.add({targets:troop.selSprite, scale:{from:TOKEN_SCALE*1.1, to:TOKEN_SCALE*1.35}, alpha:{from:1,to:0.35}, duration:600, yoyo:true, repeat:-1});
  selectionSprite = troop.selSprite;
}
function highlightMoveTargets(coords){
  coords.forEach(c=>{
    const t = getTile(c.q,c.r);
    t.highlightSprite.setTint(0x6fffb0).setAlpha(0.85);
    t.highlightSprite._tween = scene.tweens.add({targets:t.highlightSprite, alpha:{from:0.5,to:0.95}, duration:550, yoyo:true, repeat:-1});
    highlightSprites.push(t.highlightSprite);
  });
}
function highlightAttackTargets(troopList){
  troopList.forEach(tr=>{
    tr.selSprite.setTint(0xff5757).setAlpha(0.9);
    tr.selSprite._tween = scene.tweens.add({targets:tr.selSprite, scale:{from:TOKEN_SCALE*1.15,to:TOKEN_SCALE*1.4}, alpha:{from:0.5,to:1}, duration:450, yoyo:true, repeat:-1});
    highlightSprites.push(tr.selSprite);
  });
}
function highlightSpawnOptions(coords){
  coords.forEach(c=>{
    const t = getTile(c.q,c.r);
    t.highlightSprite.setTint(0xffd76a).setAlpha(0.9);
    t.highlightSprite._tween = scene.tweens.add({targets:t.highlightSprite, alpha:{from:0.5,to:1}, duration:500, yoyo:true, repeat:-1});
    highlightSprites.push(t.highlightSprite);
  });
}

function showTileInfo(tile, troop){
  const info = TILE_INFO[tile.type] || TILE_INFO.plain;
  let html = `<b>${info.name}</b><br>${info.desc}`;
  if(troop){
    const st = getStats(troop);
    html += `<br><span style="color:${cssColor(playerColorHex(troop.owner))}">${playerName(troop.owner)} troop</span> — ATK ${st.atk} / DEF ${st.def}${isLocked(troop)?' (locked)':''}`;
  }
  document.getElementById('tile-info').innerHTML = html;
}
function cssColor(hex){ return '#'+hex.toString(16).padStart(6,'0'); }

/* ---------------------------------------------------------------------
   Input handling
--------------------------------------------------------------------- */
function waitFor(kind, pi){
  return new Promise(resolve=>{ gameState.pending = {kind, pi, resolve, selected:null, options:null, picks:[]}; });
}

function ruleContext(){
  return {
    players:()=>gameState.players, troops:()=>gameState.troops, tiles:()=>gameState.tiles, countTiles,
    getTile, isLocked, getStats, isEmptyTile, neighbors, sleep, log, coloredName, cssColor,
    createTroop, destroyTroop, waitFor, updateHUD, document, axialToPixel:(q,r)=>axialToPixel(q,r,HEX_SIZE),
    boardX, boardY, burst, winScore:gameState.winScore, setGameOver:(value)=>{ gameState.gameOver=value; },
    showVictory, weights:AIW, cpuChooseSpawnTile:(_pi, options)=>chooseCpuSpawnTile({getTile},options),
    waitForSpawn:chooseSpawnTileHuman, hasLegalMove, hasLegalAttack, daggerAvailable,
    gameOver:()=>gameState.gameOver, performSacrifice, executeMove, executeAttack, clearHighlights,
    moveDecision:(pi,isPreCombat)=>CPU_MOVE_TREE({pi,isPreCombat}),
    combatDecision:(pi)=>CPU_COMBAT_TREE({pi})
  };
}

function daggerAvailable(pi){
  return combatDaggerAvailable({countTiles, troops:()=>gameState.troops},pi);
}

// The CPU should treat the Sacrificial Dagger as a late-game/surplus finishing
// move, not an early priority: only reach for it once it has a healthy troop
// surplus to spare, or as a genuine closing push when already near victory.
function cpuShouldUseDagger(pi){
  return aiShouldUseDagger({players:gameState.players,troops:gameState.troops,weights:AIW()},pi);
}

function onTroopClicked(troop){
  if(!gameState.pending) return;
  const {kind, pi} = gameState.pending;
  if(kind==='sacrifice'){
    if(troop.owner===pi && !gameState.pending.picks.includes(troop)){
      gameState.pending.picks.push(troop);
      troop.selSprite.setTint(0xd94fa0).setAlpha(1);
      if(gameState.pending.picks.length>=3){
        const resolveFn = gameState.pending.resolve; const picks=gameState.pending.picks; gameState.pending=null; clearHighlights();
        resolveFn(picks);
      }
    }
    return;
  }
  if(kind==='move'){
    if(troop.owner===pi && !isLocked(troop)){
      const targets = neighbors(troop.q,troop.r).filter(n=>gameState.tiles.has(key(n.q,n.r)) && isEmptyTile(n));
      if(targets.length===0){ flashInvalid(troop); return; }
      clearHighlights();
      gameState.pending.selected = troop;
      highlightTroopSelected(troop);
      highlightMoveTargets(targets);
    }
  } else if(kind==='attack'){
    if(gameState.pending.selected && troop.owner!==pi){
      const src = gameState.pending.selected;
      if(hexDistance(src,troop)===1){
        const resolveFn = gameState.pending.resolve; gameState.pending=null; clearHighlights();
        resolveFn({type:'attack', attacker:src, defender:troop});
        return;
      }
    }
    if(troop.owner===pi && !isLocked(troop)){
      const targets = neighbors(troop.q,troop.r).map(n=>getTroopAt(n.q,n.r)).filter(t=>t && t.owner!==pi);
      if(targets.length===0){ flashInvalid(troop); return; }
      clearHighlights();
      gameState.pending.selected = troop;
      highlightTroopSelected(troop);
      highlightAttackTargets(targets);
    }
  }
}

function onTileClicked(tile){
  if(!gameState.pending) return;
  if(gameState.pending.kind==='move' && gameState.pending.selected){
    const src = gameState.pending.selected;
    if(hexDistance(src,tile)===1 && isEmptyTile(tile)){
      const resolveFn = gameState.pending.resolve; gameState.pending=null; clearHighlights();
      resolveFn({type:'move', troop:src, target:{q:tile.q,r:tile.r}});
    }
  } else if(gameState.pending.kind==='spawnChoice' && gameState.pending.options){
    if(gameState.pending.options.some(o=>o.q===tile.q && o.r===tile.r)){
      const resolveFn = gameState.pending.resolve; gameState.pending=null; clearHighlights();
      resolveFn({q:tile.q,r:tile.r});
    }
  }
}

function flashInvalid(troop){
  scene.tweens.add({targets:troop.sprite, x:'+=4', duration:40, yoyo:true, repeat:4});
}

function setupTileInput(){
  gameState.tiles.forEach(t=>{
    t.baseSprite.setInteractive({useHandCursor:false});
    t.baseSprite.on('pointerdown', ()=>onTileClicked(t));
    t.baseSprite.on('pointerover', ()=>showTileInfo(t, getTroopAt(t.q,t.r)));
  });
}

/* ---------------------------------------------------------------------
   HUD
--------------------------------------------------------------------- */
function buildManaPanel(){
  const panel = document.getElementById('mana-panel');
  panel.innerHTML='';
  gameState.players.forEach((p,i)=>{
    const row = document.createElement('div');
    row.className='mana-row';
    row.id='mana-row-'+i;
    row.style.setProperty('--rowcolor', cssColor(p.colorHex));
    row.innerHTML = `<div class="mr-top"><span class="mr-name">${p.name}</span><span class="mr-count">0 / ${gameState.winScore}</span></div>
      <div class="mana-bar-bg"><div class="mana-bar-fill" style="width:0%"></div></div>`;
    panel.appendChild(row);
  });
}
function updateHUD(){
  gameState.players.forEach((p,i)=>{
    const row = document.getElementById('mana-row-'+i);
    row.classList.toggle('active', i===gameState.currentPlayerIndex);
    row.querySelector('.mr-count').textContent = `${p.mana} / ${gameState.winScore}`;
    row.querySelector('.mana-bar-fill').style.width = (p.mana/gameState.winScore*100)+'%';
  });
  const p = gameState.players[gameState.currentPlayerIndex];
  document.getElementById('turn-text').textContent = p.name+"'s Turn";
  document.getElementById('turn-dot').style.background = cssColor(p.colorHex);
  document.getElementById('turn-dot').style.color = cssColor(p.colorHex);
  const pipsEl = document.getElementById('ap-pips');
  pipsEl.innerHTML='';
  const maxPips = Math.max(p.actionPoints||0, p.maxActionPointsSeen||1);
  for(let i=0;i<maxPips;i++){
    const d = document.createElement('div');
    d.className = 'pip'+(i<(p.actionPoints||0) ? ' on':'');
    pipsEl.appendChild(d);
  }
}
function setPhaseUI(pi, phase){
  document.getElementById('phase-text').textContent = phase;
}
// The on-screen scrolling log was removed to keep the bottom bar to a single
// compact row (so it never overlaps the board on short windows). Game events
// still go to the browser console for anyone who wants to follow along.
function log(msg){
  console.log(msg.replace(/<[^>]+>/g,''));
}

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
  document.getElementById('skip-btn').disabled = true;
  document.getElementById('victory-title').textContent = gameState.players[pi].human ? 'Victory!' : 'Defeat...';
  document.getElementById('victory-title').style.color = cssColor(gameState.players[pi].colorHex);
  document.getElementById('victory-text').innerHTML = `${coloredName(pi)} has gathered <b>${gameState.winScore} mana points</b> and won the Surge!`;
  document.getElementById('victory-modal').style.display='flex';
  const px = axialToPixel(0,0,HEX_SIZE);
  for(let i=0;i<5;i++){
    scene.time.delayedCall(i*180, ()=>burst(boardX(px.x)+ (Math.random()*80-40), boardY(px.y)+(Math.random()*80-40), gameState.players[pi].colorHex, 30));
  }
}

/* ---------------------------------------------------------------------
   Phaser scene
--------------------------------------------------------------------- */
class MainScene extends Phaser.Scene {
  constructor(){ super('main'); }
  async create(){
    scene = this;
    boardCX = this.scale.width/2;
    boardCY = this.scale.height/2;
    const loadingMsg = this.add.text(boardCX, boardCY, 'Weaving the realm…', {
      fontFamily:'Georgia, serif', fontSize:'20px', color:'#e8c974'
    }).setOrigin(0.5).setDepth(100);

    try{
      const [, bgm] = await Promise.all([ buildTextures(this), loadBGM(this) ]);
      this._loadedBGM = bgm;
    }catch(e){
      console.error('Texture build failed:', e);
      loadingMsg.setText('Failed to load graphics — check console (F12).');
      return;
    }
    loadingMsg.destroy();

    gameState.players = COLOR_META.map((c,i)=>({...c, human:i===gameState.humanColorIndex, mana:0, actionPoints:1}));
    try{
      buildBoard();
      drawBoard(this, gameState.tiles, gameState.players, {x:boardCX, y:boardCY});
      setupTileInput();
      setupInitialTroops();
      buildManaPanel();
      updateHUD();
      startBGM(this, this._loadedBGM); // begins now that actual play is starting
      gameState.currentPlayerIndex = 0;
      syncUIStage(); // safety re-sync now that the canvas layout has fully settled
      gameLoop();
    }catch(e){
      console.error('Game setup failed:', e);
      this.add.text(boardCX, boardCY, 'Something went wrong — check console (F12).', {
        fontFamily:'Georgia, serif', fontSize:'18px', color:'#ff8a8a'
      }).setOrigin(0.5).setDepth(100);
    }
  }
}

/* ---------------------------------------------------------------------
   Boot / UI wiring
--------------------------------------------------------------------- */
let phaserGame = null;
function boot(){
  const config = {
    type: Phaser.AUTO,
    width: 1100,
    height: 820,
    parent: 'game-container',
    transparent: true,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.NO_CENTER },
    scene: [MainScene]
  };
  phaserGame = new Phaser.Game(config);
  // Keep the HTML HUD (#ui-stage) locked to wherever Phaser actually renders
  // the canvas -- this is what makes the board and its UI move/scale as one
  // unit on every window size, instead of the UI staying pinned to the raw
  // browser edges while a letterboxed canvas floats independently.
  phaserGame.events.once('ready', ()=>{
    phaserGame.scale.on('resize', syncUIStage);
    syncUIStage();
  });
  window.addEventListener('resize', syncUIStage);
  // Extra robustness: catch layout changes that don't fire a window resize
  // event at all (devtools panel toggling, some mobile browser chrome
  // changes, etc.) by watching the container's actual box directly.
  if(window.ResizeObserver){
    new ResizeObserver(()=>syncUIStage()).observe(document.getElementById('game-container'));
  }
}
function syncUIStage(){
  if(!phaserGame || !phaserGame.canvas) return;
  const rect = phaserGame.canvas.getBoundingClientRect();
  if(rect.width===0 || rect.height===0) return;
  const stage = document.getElementById('ui-stage');
  stage.style.left = rect.left+'px';
  stage.style.top = rect.top+'px';
  stage.style.transform = `scale(${rect.width/1100})`;
}

document.querySelectorAll('.color-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    gameState.humanColorIndex = parseInt(btn.dataset.color, 10);
    document.querySelectorAll('.color-btn').forEach(b=>b.classList.toggle('selected', b===btn));
  });
});
document.querySelectorAll('.diff-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    gameState.difficulty = btn.dataset.diff;
    document.querySelectorAll('.diff-btn').forEach(b=>b.classList.toggle('selected', b===btn));
  });
});
document.getElementById('winscore-slider').addEventListener('input', (e)=>{
  gameState.winScore = parseInt(e.target.value, 10);
  document.getElementById('winscore-value').textContent = gameState.winScore;
  document.getElementById('intro-winscore').textContent = gameState.winScore;
  document.getElementById('help-winscore').textContent = gameState.winScore;
});
document.getElementById('start-btn').addEventListener('click', ()=>{
  document.getElementById('hidden-start-overlay').style.display='none';
  boot();
});
function openHelpModal(){
  const modal = document.getElementById('help-modal');
  modal.style.display='flex';
  modal.querySelector('.modal-box').scrollTop = 0;
  document.getElementById('help-winscore').textContent = gameState.winScore;
}
document.getElementById('rules-btn').addEventListener('click', openHelpModal);
document.getElementById('help-btn').addEventListener('click', openHelpModal);
document.getElementById('close-help').addEventListener('click', ()=>{
  document.getElementById('help-modal').style.display='none';
});
document.getElementById('close-help-x').addEventListener('click', ()=>{
  document.getElementById('help-modal').style.display='none';
});

/* ---------------------------------------------------------------------
   Credits — easy to maintain/extend: just add {role, name} entries below
--------------------------------------------------------------------- */
const CREDITS = [
  { role: "Design, Code & Art", name: "Alexander Shepherd" }
];

function renderCredits(){
  const list = document.getElementById('credits-list');
  list.innerHTML = CREDITS.map(c =>
    `<div class="credit-row"><span class="credit-role">${c.role}</span><span class="credit-name">${c.name}</span></div>`
  ).join('');
}
function openCreditsModal(){
  renderCredits();
  const modal = document.getElementById('credits-modal');
  modal.style.display='flex';
  modal.querySelector('.modal-box').scrollTop = 0;
}
document.getElementById('credits-btn').addEventListener('click', openCreditsModal);
document.getElementById('close-credits').addEventListener('click', ()=>{
  document.getElementById('credits-modal').style.display='none';
});
document.getElementById('close-credits-x').addEventListener('click', ()=>{
  document.getElementById('credits-modal').style.display='none';
});
document.getElementById('skip-btn').addEventListener('click', ()=>{
  if(gameState.pending && (gameState.pending.kind==='move' || gameState.pending.kind==='attack')){
    const r = gameState.pending.resolve; gameState.pending=null; clearHighlights();
    r({type:'skip'});
  } else if(gameState.pending && gameState.pending.kind==='sacrifice'){
    const r = gameState.pending.resolve; gameState.pending=null; clearHighlights();
    r(null);
  }
});
document.getElementById('dagger-btn').addEventListener('click', ()=>{
  if(gameState.pending && (gameState.pending.kind==='move' || gameState.pending.kind==='attack')){
    const r = gameState.pending.resolve; gameState.pending=null; clearHighlights();
    r({type:'dagger'});
  }
});
document.getElementById('restart-btn').addEventListener('click', ()=>{ location.reload(); });
document.getElementById('playagain-btn').addEventListener('click', ()=>{ location.reload(); });

