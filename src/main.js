/* ======================================================================
   MANA SURGE — single-file Phaser 3 implementation
   ====================================================================== */
'use strict';

import { N, INNER_RADIUS, HEX_SIZE, DIRS, key, neighbors, hexDistance, axialToPixel, hexPolygonPoints, cubeFromAxial, axialFromCube, rotate60Cube, rotateAxial, shuffle } from './utils/hex.js';
import { sleep, tweenPromise } from './utils/async.js';
import { TILE_INFO, LOCKING_TYPES, COLOR_META } from './data/gameData.js';
import { WEIGHT_PRESETS } from './data/aiWeights.js';
import * as BoardModel from './board/BoardModel.js';


/* ---------------------------------------------------------------------
   Hex math (pointy-top, axial coordinates)
--------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
   Game state
--------------------------------------------------------------------- */
let tiles = new Map();
let troops = [];
let nextTroopId = 1;
let players = [];
let currentPlayerIndex = 0;
let gameOver = false;
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
let difficulty = 'medium';
function AIW(){ return WEIGHT_PRESETS[difficulty]; }

// Victory threshold, chosen on the start screen via the slider (10/20/30/40/50).
let winScore = 10;

// Which color the human plays as (0=Red, 1=Blue, 2=Green). The board itself
// is fixed -- Red's spawner is always the left corner, Blue upper-right,
// Green bottom -- so this just decides which of those three seats the human
// sits in; the other two are always CPU-controlled, and turn order still
// goes clockwise Red -> Blue -> Green regardless of which one is human.
let humanColorIndex = 0;
let boardCX = 0, boardCY = 0;
let pending = null; // {kind, pi, resolve, selected, options}
let highlightSprites = [];
let selectionSprite = null;

function boardX(px){ return boardCX + px; }
function boardY(py){ return boardCY + py; }

function playerColorHex(pi){ return players[pi].colorHex; }
function playerName(pi){ return players[pi].name; }

function getTile(q,r){ return BoardModel.getTile(tiles,q,r); }
function isLocked(troop){ return BoardModel.isLocked(tiles,troop); }
function getStats(troop){ return BoardModel.getStats(tiles,troop); }
function getTroopAt(q,r){ return BoardModel.getTroopAt(tiles,troops,q,r); }
function isEmptyTile(coord){ return BoardModel.isEmptyTile(tiles,coord); }
function countTiles(pi,type){ return BoardModel.countTiles(tiles,troops,pi,type); }
function hasLegalMove(pi){ return BoardModel.hasLegalMove(tiles,troops,pi); }
function hasLegalAttack(pi){ return BoardModel.hasLegalAttack(tiles,troops,pi); }

// Exact board layout extracted and verified (via pixel measurement + 3-fold
// rotational symmetry validation) from the reference board image. This is a
// fixed, hand-authored layout so every match is provably identical and fair
// for all three players -- not randomly generated.
function buildBoard(){ tiles = BoardModel.buildBoard(players); }

function setupInitialTroops(){ BoardModel.setupInitialTroops(players,tiles,createTroop); }

/* ---------------------------------------------------------------------
   Texture generation (SVG -> Phaser textures)
--------------------------------------------------------------------- */
function svgUrl(svg){ return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg); }

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

function loadSVGTexture(scene, key, svgString, w, h){
  return new Promise((resolve)=>{
    const img = new Image(w, h);
    img.onload = ()=>{
      try{
        if(!scene.textures.exists(key)) scene.textures.addImage(key, img);
      }catch(e){ console.error('addImage failed for', key, e); }
      resolve();
    };
    img.onerror = (e)=>{ console.error('SVG texture failed to load:', key, e); resolve(); };
    img.src = svgUrl(svgString);
  });
}

function buildTextures(scene){
  const hexPts = hexPolygonPoints(60,60,54);
  const hexPtsInner = hexPolygonPoints(60,60,50);
  const defs = [];
  const add = (key, svg, w, h) => defs.push([key, svg, w, h]);
  const BORDER = '#7a5626'; // warm brown hex border, matching reference art

  // --- Stone tile (outer "home" ring) ---
  add('hexStone', `
    <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <defs><radialGradient id="gs" cx="45%" cy="35%" r="75%">
        <stop offset="0%" stop-color="#a8a8ac"/><stop offset="60%" stop-color="#8c8c92"/><stop offset="100%" stop-color="#6c6c74"/>
      </radialGradient></defs>
      <polygon points="${hexPts}" fill="url(#gs)" stroke="${BORDER}" stroke-width="2"/>
      <circle cx="42" cy="46" r="7" fill="#7a7a82" opacity="0.5"/>
      <circle cx="78" cy="70" r="9" fill="#9a9aa0" opacity="0.4"/>
      <circle cx="70" cy="38" r="5" fill="#77777e" opacity="0.45"/>
      <circle cx="46" cy="82" r="6" fill="#7d7d84" opacity="0.4"/>
    </svg>`, 120,120);

  // --- Grass tile (inner battlefield) ---
  add('hexGrass', `
    <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <defs><radialGradient id="gg" cx="45%" cy="32%" r="75%">
        <stop offset="0%" stop-color="#8fd15a"/><stop offset="60%" stop-color="#6fb144"/><stop offset="100%" stop-color="#588f36"/>
      </radialGradient></defs>
      <polygon points="${hexPts}" fill="url(#gg)" stroke="${BORDER}" stroke-width="2"/>
      <circle cx="40" cy="42" r="6" fill="#a3e070" opacity="0.35"/>
      <circle cx="80" cy="66" r="8" fill="#4f8a30" opacity="0.3"/>
      <circle cx="70" cy="36" r="5" fill="#9fdd6c" opacity="0.3"/>
      <circle cx="46" cy="84" r="6" fill="#4f8a30" opacity="0.3"/>
    </svg>`, 120,120);

  add('hexRing', `
    <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <polygon points="${hexPolygonPoints(60,60,51)}" fill="#ffffff" fill-opacity="0.16" stroke="#ffffff" stroke-width="6"/>
    </svg>`, 120,120);

  // --- Mana Pool: glowing blue orb with a pearl ring ---
  add('iconMana', `
    <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <defs><radialGradient id="mg" cx="42%" cy="32%" r="65%">
        <stop offset="0%" stop-color="#e6f7ff"/><stop offset="45%" stop-color="#6ec3ff"/><stop offset="100%" stop-color="#1f5fa8"/>
      </radialGradient></defs>
      <g>
        ${Array.from({length:16},(_,i)=>{
          const a = i*22.5*Math.PI/180, x=60+38*Math.cos(a), y=60+38*Math.sin(a);
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.2" fill="#eaf4ff" opacity="0.9"/>`;
        }).join('')}
      </g>
      <circle cx="60" cy="60" r="29" fill="url(#mg)" stroke="#dff2ff" stroke-width="2"/>
      <ellipse cx="50" cy="48" rx="9" ry="6" fill="#ffffff" opacity="0.55"/>
    </svg>`, 120,120);

  // --- Thorns: pink/magenta bramble cluster ---
  add('iconThorns', `
    <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <g stroke="#d94fa0" stroke-width="3" fill="none" stroke-linecap="round">
        <path d="M60 60 L60 30 M60 60 L38 40 M60 60 L84 38 M60 60 L34 66 M60 60 L88 66 M60 60 L46 88 M60 60 L76 90"/>
        <path d="M60 30 L54 38 M60 30 L67 37 M38 40 L46 46 M84 38 L76 45 M34 66 L44 64 M88 66 L78 65 M46 88 L52 80 M76 90 L70 82"/>
      </g>
      <circle cx="60" cy="60" r="7" fill="#a8306f"/>
    </svg>`, 120,120);

  // --- Combat modifier icons (sword/shield, floating directly on the tile) ---
  add('iconSwordMinus', `
    <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <g transform="rotate(-45 60 60)">
        <rect x="56" y="28" width="8" height="46" rx="2" fill="#d7d9e0" stroke="#5b5d68" stroke-width="1.5"/>
        <polygon points="60,20 66,32 54,32" fill="#d7d9e0" stroke="#5b5d68" stroke-width="1.5"/>
        <rect x="47" y="74" width="26" height="7" rx="2" fill="#8a6a3a"/>
        <rect x="57" y="80" width="6" height="16" rx="2" fill="#5c4426"/>
      </g>
      <circle cx="88" cy="34" r="16" fill="#c23a3a" stroke="#ffb0b0" stroke-width="2"/>
      <text x="88" y="40" font-family="Georgia,serif" font-weight="bold" font-size="17" fill="#ffffff" text-anchor="middle">-1</text>
    </svg>`, 120,120);

  add('iconSwordPlus', `
    <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <g transform="rotate(-45 60 60)">
        <rect x="56" y="28" width="8" height="46" rx="2" fill="#ffe6a8" stroke="#8a6a1a" stroke-width="1.5"/>
        <polygon points="60,20 66,32 54,32" fill="#ffe6a8" stroke="#8a6a1a" stroke-width="1.5"/>
        <rect x="47" y="74" width="26" height="7" rx="2" fill="#8a6a3a"/>
        <rect x="57" y="80" width="6" height="16" rx="2" fill="#5c4426"/>
      </g>
      <circle cx="88" cy="34" r="16" fill="#3a7bc2" stroke="#b0d4ff" stroke-width="2"/>
      <text x="88" y="40" font-family="Georgia,serif" font-weight="bold" font-size="15" fill="#ffffff" text-anchor="middle">+1</text>
    </svg>`, 120,120);

  add('iconShieldPlus', `
    <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <path d="M60 26 L86 36 L86 58 C86 78 75 90 60 96 C45 90 34 78 34 58 L34 36 Z" fill="#f2d98a" stroke="#a3822f" stroke-width="2.5"/>
      <text x="60" y="68" font-family="Georgia,serif" font-weight="bold" font-size="24" fill="#7a5a12" text-anchor="middle">+1</text>
    </svg>`, 120,120);

  // --- Special ability badges: purple circle with white glyph (matches ref art) ---
  const badge = (glyphSvg) => `
    <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <defs><radialGradient id="bd" cx="40%" cy="32%" r="70%">
        <stop offset="0%" stop-color="#c9b8ff"/><stop offset="55%" stop-color="#8e78d8"/><stop offset="100%" stop-color="#5a4499"/>
      </radialGradient></defs>
      <circle cx="60" cy="60" r="34" fill="url(#bd)" stroke="#efe6ff" stroke-width="2.5"/>
      ${glyphSvg}
    </svg>`;

  add('iconLightningBadge', badge(`
    <polygon points="66,38 46,64 58,64 54,84 78,56 64,56" fill="#fff6d8"/>`), 120,120);

  add('iconSpawnBadge', badge(`
      <circle cx="60" cy="48" r="10" fill="#eee6ff"/>
      <path d="M42 82 C42 66 50 60 60 60 C70 60 78 66 78 82 Z" fill="#eee6ff"/>
      <path d="M60 38 L60 30 M56 34 L64 34" stroke="#eee6ff" stroke-width="4" stroke-linecap="round"/>`), 120,120);

  add('iconDaggerBadge', badge(`
    <g transform="rotate(20 60 60)">
      <rect x="57" y="34" width="6" height="34" rx="2" fill="#eee6ff"/>
      <polygon points="60,26 66,38 54,38" fill="#eee6ff"/>
      <rect x="50" y="68" width="20" height="6" rx="2" fill="#c9b8ff"/>
      <rect x="57" y="74" width="6" height="12" rx="2" fill="#5a4499"/>
    </g>`), 120,120);

  // --- Spawner aperture/shutter icon (tinted per player) ---
  add('iconSpawner', `
    <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="34" fill="#141414" stroke="#ffffff" stroke-width="2"/>
      <g fill="#ffffff">
        ${Array.from({length:6},(_,i)=>{
          const a0 = i*60*Math.PI/180, a1=(i*60+50)*Math.PI/180;
          const x0=60+30*Math.cos(a0), y0=60+30*Math.sin(a0);
          const x1=60+30*Math.cos(a1), y1=60+30*Math.sin(a1);
          return `<path d="M60,60 L${x0.toFixed(1)},${y0.toFixed(1)} A30,30 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" opacity="0.9"/>`;
        }).join('')}
      </g>
      <circle cx="60" cy="60" r="9" fill="#141414"/>
    </svg>`, 120,120);

  // --- Troop token: flat colored badge (stat text is added separately) ---
  add('tokenBadge', `
    <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
      <defs><radialGradient id="tk" cx="38%" cy="32%" r="70%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient></defs>
      <circle cx="50" cy="50" r="40" fill="#ffffff" stroke="#1a1a1a" stroke-width="3"/>
      <circle cx="50" cy="50" r="40" fill="url(#tk)"/>
    </svg>`, 100,100);

  add('lockRing', `
    <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="46" fill="none" stroke="#ffd76a" stroke-width="3" stroke-dasharray="7 6"/>
    </svg>`, 100,100);

  add('selRing', `
    <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="44" fill="none" stroke="#ffffff" stroke-width="4"/>
    </svg>`, 100,100);

  add('particleSpark', `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="10" fill="#ffffff"/>
    </svg>`, 32,32);

  add('particleGlow', `
    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
      <defs><radialGradient id="pg" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.9"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient></defs>
      <circle cx="24" cy="24" r="24" fill="url(#pg)"/>
    </svg>`, 48,48);

  return Promise.all(defs.map(d=>loadSVGTexture(scene, d[0], d[1], d[2], d[3])));
}

const ICON_FOR_TYPE = {
  thorns:'iconThorns', atk_minus:'iconSwordMinus', atk_plus:'iconSwordPlus', def_plus:'iconShieldPlus',
  extra_action:'iconLightningBadge', extra_spawn:'iconSpawnBadge', dagger:'iconDaggerBadge', mana_pool:'iconMana'
};
const BADGE_TYPES = ['extra_action','extra_spawn','dagger']; // rendered a touch larger, matching ref art

/* ---------------------------------------------------------------------
   Rendering
--------------------------------------------------------------------- */
const TILE_SCALE = HEX_SIZE/54;
const TOKEN_SCALE = (HEX_SIZE*0.5)/40;

function renderBoard(){
  tiles.forEach(t=>{
    const px = axialToPixel(t.q,t.r,HEX_SIZE);
    const x = boardX(px.x), y = boardY(px.y);
    const baseTex = t.biome==='green' ? 'hexGrass' : 'hexStone';
    const base = scene.add.image(x,y,baseTex).setScale(TILE_SCALE).setDepth(0);
    t.baseSprite = base;

    const ring = scene.add.image(x,y,'hexRing').setScale(TILE_SCALE).setDepth(1).setAlpha(0).setBlendMode('ADD');
    t.highlightSprite = ring;

    if(t.type==='spawner'){
      const icon = scene.add.image(x,y,'iconSpawner').setScale(TILE_SCALE*0.68).setDepth(2);
      icon.setTint(playerColorHex(t.owner));
      if(icon.postFX) icon.postFX.addGlow(playerColorHex(t.owner), 2, 0, false, 0.25, 8);
    } else if(ICON_FOR_TYPE[t.type]){
      const iconScale = BADGE_TYPES.includes(t.type) ? 0.62 : 0.58;
      const icon = scene.add.image(x,y,ICON_FOR_TYPE[t.type]).setScale(TILE_SCALE*iconScale).setDepth(2);
      if(t.type==='mana_pool'){
        scene.tweens.add({targets:icon, angle:360, duration:20000, repeat:-1});
        scene.tweens.add({targets:icon, scale:{from:TILE_SCALE*0.54, to:TILE_SCALE*0.62}, duration:1400, yoyo:true, repeat:-1, ease:'Sine.easeInOut'});
        if(icon.postFX) icon.postFX.addGlow(0x6ec3ff, 3, 0, false, 0.2, 10);
        scene.add.particles(x,y,'particleGlow',{
          speed:{min:4,max:18}, lifespan:1600, scale:{start:0.7,end:0}, alpha:{start:0.7,end:0},
          tint:0x6ec3ff, frequency:200, blendMode:'ADD',
          emitZone:{type:'random', source:new Phaser.Geom.Circle(0,0,HEX_SIZE*0.6)}
        }).setDepth(3);
      }
    }
  });

  // subtle ambient background particles
  for(let i=0;i<70;i++){
    const sx = Math.random()*1100, sy = Math.random()*820;
    const s = scene.add.image(sx,sy,'particleGlow').setScale(0.1+Math.random()*0.18).setAlpha(0.08+Math.random()*0.12).setDepth(-5);
    scene.tweens.add({targets:s, alpha:{from:s.alpha, to:s.alpha*0.2}, duration:1500+Math.random()*2500, yoyo:true, repeat:-1});
  }
}

function createTroop(owner, q, r, animate){
  const t = getTile(q,r);
  const troop = {id: nextTroopId++, owner, q, r};
  t.occupantId = troop.id;
  const px = axialToPixel(q,r,HEX_SIZE);
  const x = boardX(px.x), y = boardY(px.y);

  const glow = scene.add.image(x,y,'particleGlow').setScale(1.5).setAlpha(0.5).setTint(playerColorHex(owner)).setDepth(3).setBlendMode('ADD');
  const sprite = scene.add.image(x,y,'tokenBadge').setScale(animate?0:TOKEN_SCALE).setTint(playerColorHex(owner)).setDepth(4).setInteractive({useHandCursor:true});
  const lock = scene.add.image(x,y,'lockRing').setScale(TOKEN_SCALE*1.05).setAlpha(0).setDepth(5).setTint(0xffd76a);
  const sel = scene.add.image(x,y,'selRing').setScale(TOKEN_SCALE*1.15).setAlpha(0).setDepth(5).setTint(0xffffff);
  const statText = scene.add.text(x,y,'1/1', {
    fontFamily:'Georgia, serif', fontSize: Math.round(HEX_SIZE*0.42)+'px', fontStyle:'bold', color:'#ffffff',
    stroke:'#000000', strokeThickness:3
  }).setOrigin(0.5).setDepth(5);

  troop.sprite = sprite; troop.glow = glow; troop.lockSprite = lock; troop.selSprite = sel; troop.statText = statText;
  sprite.on('pointerdown', ()=>onTroopClicked(troop));
  sprite.on('pointerover', ()=>{ showTileInfo(t, troop); });
  troops.push(troop);
  refreshLockVisual(troop);

  if(animate){
    scene.tweens.add({targets:sprite, scale:TOKEN_SCALE, duration:280, ease:'Back.easeOut'});
    burst(x,y,playerColorHex(owner),14);
  }
  return troop;
}

async function destroyTroop(troop, isThorns){
  const idx = troops.indexOf(troop);
  if(idx>=0) troops.splice(idx,1);
  const t = getTile(troop.q,troop.r);
  if(t && t.occupantId===troop.id) t.occupantId=null;
  burst(troop.sprite.x, troop.sprite.y, isThorns?0xff4444:playerColorHex(troop.owner), 22);
  scene.cameras.main.shake(120, 0.0025);
  await tweenPromise(scene, [troop.sprite, troop.glow, troop.lockSprite, troop.selSprite, troop.statText], {scale:0, alpha:0}, 260, 'Back.easeIn');
  troop.sprite.destroy(); troop.glow.destroy(); troop.lockSprite.destroy(); troop.selSprite.destroy(); troop.statText.destroy();
}

function refreshLockVisual(troop){
  const locked = isLocked(troop);
  troop.lockSprite.setAlpha(locked?0.85:0);
  if(locked && !troop._lockTween){
    troop._lockTween = scene.tweens.add({targets:troop.lockSprite, angle:360, duration:5000, repeat:-1});
  }
  const st = getStats(troop);
  troop.statText.setText(`${st.atk}/${st.def}`);
}

function burst(x,y,color,count){
  const em = scene.add.particles(x,y,'particleSpark',{
    speed:{min:60,max:220}, angle:{min:0,max:360}, lifespan:{min:350,max:650},
    scale:{start:0.9,end:0}, alpha:{start:1,end:0}, tint:color, blendMode:'ADD'
  }).setDepth(6);
  em.explode(count||16);
  scene.time.delayedCall(750, ()=>em.destroy());
}

function moveSpritesTo(troop, x, y){
  return tweenPromise(scene, [troop.sprite, troop.glow, troop.lockSprite, troop.selSprite, troop.statText], {x,y}, 260);
}

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
  return new Promise(resolve=>{ pending = {kind, pi, resolve, selected:null, options:null, picks:[]}; });
}

function daggerAvailable(pi){
  return countTiles(pi,'dagger')>0 && troops.filter(t=>t.owner===pi).length>=3;
}

// The CPU should treat the Sacrificial Dagger as a late-game/surplus finishing
// move, not an early priority: only reach for it once it has a healthy troop
// surplus to spare, or as a genuine closing push when already near victory.
function cpuShouldUseDagger(pi){
  const w = AIW();
  const p = players[pi];
  const myTroopCount = troops.filter(t=>t.owner===pi).length;
  const hasSurplus = myTroopCount >= w.daggerSurplusThreshold;              // plenty of troops to spare
  const closingPush = p.mana >= w.daggerClosingManaThreshold && myTroopCount >= w.daggerClosingTroopThreshold; // near-victory finishing move
  return hasSurplus || closingPush;
}

function onTroopClicked(troop){
  if(!pending) return;
  const {kind, pi} = pending;
  if(kind==='sacrifice'){
    if(troop.owner===pi && !pending.picks.includes(troop)){
      pending.picks.push(troop);
      troop.selSprite.setTint(0xd94fa0).setAlpha(1);
      if(pending.picks.length>=3){
        const resolveFn = pending.resolve; const picks=pending.picks; pending=null; clearHighlights();
        resolveFn(picks);
      }
    }
    return;
  }
  if(kind==='move'){
    if(troop.owner===pi && !isLocked(troop)){
      const targets = neighbors(troop.q,troop.r).filter(n=>tiles.has(key(n.q,n.r)) && isEmptyTile(n));
      if(targets.length===0){ flashInvalid(troop); return; }
      clearHighlights();
      pending.selected = troop;
      highlightTroopSelected(troop);
      highlightMoveTargets(targets);
    }
  } else if(kind==='attack'){
    if(pending.selected && troop.owner!==pi){
      const src = pending.selected;
      if(hexDistance(src,troop)===1){
        const resolveFn = pending.resolve; pending=null; clearHighlights();
        resolveFn({type:'attack', attacker:src, defender:troop});
        return;
      }
    }
    if(troop.owner===pi && !isLocked(troop)){
      const targets = neighbors(troop.q,troop.r).map(n=>getTroopAt(n.q,n.r)).filter(t=>t && t.owner!==pi);
      if(targets.length===0){ flashInvalid(troop); return; }
      clearHighlights();
      pending.selected = troop;
      highlightTroopSelected(troop);
      highlightAttackTargets(targets);
    }
  }
}

function onTileClicked(tile){
  if(!pending) return;
  if(pending.kind==='move' && pending.selected){
    const src = pending.selected;
    if(hexDistance(src,tile)===1 && isEmptyTile(tile)){
      const resolveFn = pending.resolve; pending=null; clearHighlights();
      resolveFn({type:'move', troop:src, target:{q:tile.q,r:tile.r}});
    }
  } else if(pending.kind==='spawnChoice' && pending.options){
    if(pending.options.some(o=>o.q===tile.q && o.r===tile.r)){
      const resolveFn = pending.resolve; pending=null; clearHighlights();
      resolveFn({q:tile.q,r:tile.r});
    }
  }
}

function flashInvalid(troop){
  scene.tweens.add({targets:troop.sprite, x:'+=4', duration:40, yoyo:true, repeat:4});
}

function setupTileInput(){
  tiles.forEach(t=>{
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
  players.forEach((p,i)=>{
    const row = document.createElement('div');
    row.className='mana-row';
    row.id='mana-row-'+i;
    row.style.setProperty('--rowcolor', cssColor(p.colorHex));
    row.innerHTML = `<div class="mr-top"><span class="mr-name">${p.name}</span><span class="mr-count">0 / ${winScore}</span></div>
      <div class="mana-bar-bg"><div class="mana-bar-fill" style="width:0%"></div></div>`;
    panel.appendChild(row);
  });
}
function updateHUD(){
  players.forEach((p,i)=>{
    const row = document.getElementById('mana-row-'+i);
    row.classList.toggle('active', i===currentPlayerIndex);
    row.querySelector('.mr-count').textContent = `${p.mana} / ${winScore}`;
    row.querySelector('.mana-bar-fill').style.width = (p.mana/winScore*100)+'%';
  });
  const p = players[currentPlayerIndex];
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
  const p = players[pi];
  p.actionPoints = 1 + countTiles(pi,'extra_action');
  p.maxActionPointsSeen = Math.max(p.maxActionPointsSeen||1, p.actionPoints);
  updateHUD();
  const spawnsAllowed = 1 + countTiles(pi,'extra_spawn');
  let spawned=0;
  for(let i=0;i<spawnsAllowed;i++){
    if(troops.filter(t=>t.owner===pi).length>=15){ log(`${p.name} has no troops left in reserve.`); break; }
    const options = neighbors(p.spawner.q,p.spawner.r).filter(n=>tiles.has(key(n.q,n.r)) && isEmptyTile(n));
    if(options.length===0){ log(`${p.name}'s spawner has no open ground.`); break; }
    let choice;
    if(options.length===1){ choice = options[0]; }
    else if(p.human){
      choice = await chooseSpawnTileHuman(options);
    } else {
      choice = cpuChooseSpawnTile(pi, options);
      await sleep(280);
    }
    createTroop(pi, choice.q, choice.r, true);
    spawned++;
    await sleep(200);
  }
  if(spawned>0) log(`${coloredName(pi)} spawns ${spawned} troop${spawned>1?'s':''}.`);
  updateHUD();
}

function chooseSpawnTileHuman(options){
  document.getElementById('skip-btn').disabled = true;
  const promise = waitFor('spawnChoice', currentPlayerIndex);
  pending.options = options;
  highlightSpawnOptions(options);
  return promise.then(res=>{ clearHighlights(); return res; });
}

function cpuChooseSpawnTile(pi, options){
  const order = {extra_action:5, extra_spawn:4, atk_plus:3, def_plus:2, plain:1, atk_minus:0, thorns:-5};
  let best = options[0], bestScore=-999;
  options.forEach(o=>{
    const tp = getTile(o.q,o.r).type;
    const s = order[tp] ?? 1;
    if(s>bestScore){ bestScore=s; best=o; }
  });
  return best;
}

async function performSacrifice(pi){
  const p = players[pi];
  if(p.human){
    document.getElementById('dagger-btn').disabled = true;
    const btn = document.getElementById('skip-btn');
    btn.disabled = false; btn.textContent = 'Cancel Sacrifice';
    log(`${coloredName(pi)} channels the Sacrificial Dagger — choose 3 troops to sacrifice.`);
    const picks = await waitFor('sacrifice', pi);
    btn.disabled = true;
    if(!picks) return false; // cancelled
    for(const tr of picks){ await destroyTroop(tr, false); }
  } else {
    const mine = troops.filter(t=>t.owner===pi);
    const sorted = [...mine].sort((a,b)=>{
      const score = t => (getTile(t.q,t.r).type==='plain'?0:1) + (isLocked(t)?2:0);
      return score(a)-score(b);
    });
    const picks = sorted.slice(0,3);
    for(const tr of picks){ await destroyTroop(tr, false); }
  }
  p.mana++;
  log(`🗡️ ${coloredName(pi)} sacrifices 3 troops for 1 mana. (${p.mana}/10)`);
  const px = axialToPixel(0,0,HEX_SIZE);
  burst(boardX(px.x), boardY(px.y), 0xc9b8ff, 24);
  updateHUD();
  if(p.mana>=winScore){ gameOver=true; showVictory(pi); }
  return true;
}

/* ---------------------------------------------------------------------
   Behavior Tree framework for CPU players
   ---------------------------------------------------------------------
   Phaser has no built-in behavior-tree system (checked: nothing in core
   or the official plugin set does this), so this is a small real one,
   built from scratch instead of pulling in a third-party dependency for
   a single-file game with just three fairly small trees:
     - Selector : tries children in priority order, returns the first
                  success (a truthy result). This IS the priority list.
     - Sequence : every child must succeed, in order; returns the last
                  child's result. Used as an implicit "if / then".
     - Condition: a leaf that succeeds (returns true) if a predicate
                  holds, otherwise fails (returns null).
     - Action   : a leaf that always "succeeds", performing a lookup or
                  producing the final decision object for the tick.
   Every node is just a function bb => result, where bb ("blackboard")
   carries whatever context the tree needs (here: {pi, isPreCombat}).
   A falsy result means failure and makes the parent Selector move on
   to the next child / the parent Sequence abort.
--------------------------------------------------------------------- */
function Selector(...children){
  return function(bb){
    for(const child of children){
      const result = child(bb);
      if(result) return result;
    }
    return null;
  };
}
function Sequence(...children){
  return function(bb){
    let result = null;
    for(const child of children){
      result = child(bb);
      if(!result) return null;
    }
    return result;
  };
}
function Condition(pred){ return function(bb){ return pred(bb) ? true : null; }; }
function Action(fn){ return function(bb){ return fn(bb); }; }

// --- Move-phase tree ----------------------------------------------------
// Priority order, top to bottom:
//   1. Hold position if we're down to our last action point and a good
//      attack is already available -- bank the point for Combat instead
//      of wasting it on a lesser move.
//   2. Otherwise take the best available move.
//   3. No good move -- consider the Sacrificial Dagger (late game only).
//   4. Nothing productive to do: pass.
// Tiles rare/unique enough that passing one up this turn could mean losing
// it to another player -- these are the only prizes worth interrupting a
// "hold for attack" over. Ordinary combat shrines (atk/def) are common
// enough (18/18/15 of them) that grabbing a marginally-better one is never
// worth giving up a queued attack for.
const UNMISSABLE_CLAIM_TYPES = ['mana_pool','extra_action','extra_spawn','dagger'];
const CPU_MOVE_TREE = Selector(
  Sequence(
    Condition(bb => bb.isPreCombat && players[bb.pi].actionPoints <= 1),
    Condition(bb => { bb.pendingAttack = cpuChooseAttack(bb.pi); return !!bb.pendingAttack; }),
    Condition(bb => {
      bb.bestMove = cpuChooseMove(bb.pi);
      if(!bb.bestMove) return true;
      const targetType = getTile(bb.bestMove.target.q, bb.bestMove.target.r).type;
      return !UNMISSABLE_CLAIM_TYPES.includes(targetType);
    }),
    Action(() => ({type:'hold'}))
  ),
  Sequence(
    Condition(bb => { bb.bestMove = bb.bestMove || cpuChooseMove(bb.pi); return !!bb.bestMove; }),
    Action(bb => ({type:'move', troop:bb.bestMove.troop, target:bb.bestMove.target}))
  ),
  Sequence(
    Condition(bb => daggerAvailable(bb.pi)),
    Condition(bb => cpuShouldUseDagger(bb.pi)),
    Action(() => ({type:'sacrifice'}))
  ),
  Action(() => ({type:'pass'}))
);

// --- Combat-phase tree ---------------------------------------------------
// Priority order: take the best attack; otherwise consider the dagger;
// otherwise pass.
const CPU_COMBAT_TREE = Selector(
  Sequence(
    Condition(bb => { bb.bestAttack = cpuChooseAttack(bb.pi); return !!bb.bestAttack; }),
    Action(bb => ({type:'attack', attacker:bb.bestAttack.attacker, defender:bb.bestAttack.defender}))
  ),
  Sequence(
    Condition(bb => daggerAvailable(bb.pi)),
    Condition(bb => cpuShouldUseDagger(bb.pi)),
    Action(() => ({type:'sacrifice'}))
  ),
  Action(() => ({type:'pass'}))
);

async function movePhase(pi, isPreCombat){
  const p = players[pi];
  const btn = document.getElementById('skip-btn');
  const daggerBtn = document.getElementById('dagger-btn');
  while(true){
    if(gameOver) return;
    if(p.actionPoints<=0) break;
    const canMove = hasLegalMove(pi);
    const canDagger = daggerAvailable(pi);
    if(!canMove && !canDagger) break;
    if(p.human){
      daggerBtn.style.display = canDagger ? 'block' : 'none';
      daggerBtn.disabled = !canDagger;
      if(canMove){
        btn.disabled=false; btn.textContent='Skip Move Phase';
        const action = await waitFor('move', pi);
        btn.disabled=true;
        if(action.type==='dagger'){ const did = await performSacrifice(pi); if(did) p.actionPoints--; updateHUD(); continue; }
        if(action.type==='skip') break;
        const troop = action.troop, target = getTile(action.target.q, action.target.r);
        await executeMove(troop, target);
        p.actionPoints--; updateHUD();
      } else {
        // no legal move, but the dagger is available -- wait on the dagger only
        btn.disabled=false; btn.textContent='Skip Move Phase';
        const action = await waitFor('move', pi);
        btn.disabled=true;
        if(action.type==='dagger'){ const did = await performSacrifice(pi); if(did) p.actionPoints--; updateHUD(); continue; }
        if(action.type==='skip') break;
      }
    } else {
      await sleep(500);
      // Consult the behavior tree instead of an ad-hoc if/else chain --
      // this is what decides hold vs. move vs. sacrifice vs. pass.
      const decision = CPU_MOVE_TREE({pi, isPreCombat});
      if(decision.type==='move'){
        await executeMove(decision.troop, getTile(decision.target.q,decision.target.r));
        p.actionPoints--; updateHUD();
        await sleep(250);
      } else if(decision.type==='sacrifice'){
        const did = await performSacrifice(pi);
        if(did) p.actionPoints--; updateHUD();
        await sleep(250);
      } else break; // 'hold' or 'pass' -- end the phase, preserving any remaining AP
    }
  }
  document.getElementById('dagger-btn').style.display='none';
  clearHighlights();
}

async function combatPhase(pi){
  const p = players[pi];
  const btn = document.getElementById('skip-btn');
  const daggerBtn = document.getElementById('dagger-btn');
  while(true){
    if(gameOver) return;
    if(p.actionPoints<=0) break;
    const canAttack = hasLegalAttack(pi);
    const canDagger = daggerAvailable(pi);
    if(!canAttack && !canDagger) break;
    if(p.human){
      daggerBtn.style.display = canDagger ? 'block' : 'none';
      daggerBtn.disabled = !canDagger;
      if(canAttack){
        btn.disabled=false; btn.textContent='Skip Combat Phase';
        const action = await waitFor('attack', pi);
        btn.disabled=true;
        if(action.type==='dagger'){ const did = await performSacrifice(pi); if(did) p.actionPoints--; updateHUD(); continue; }
        if(action.type==='skip') break;
        await executeAttack(action.attacker, action.defender);
        p.actionPoints--; updateHUD();
      } else {
        btn.disabled=false; btn.textContent='Skip Combat Phase';
        const action = await waitFor('attack', pi);
        btn.disabled=true;
        if(action.type==='dagger'){ const did = await performSacrifice(pi); if(did) p.actionPoints--; updateHUD(); continue; }
        if(action.type==='skip') break;
      }
    } else {
      await sleep(550);
      const decision = CPU_COMBAT_TREE({pi});
      if(decision.type==='attack'){
        await executeAttack(decision.attacker, decision.defender);
        p.actionPoints--; updateHUD();
        await sleep(300);
      } else if(decision.type==='sacrifice'){
        const did = await performSacrifice(pi);
        if(did) p.actionPoints--; updateHUD();
        await sleep(300);
      } else break;
    }
  }
  document.getElementById('dagger-btn').style.display='none';
  clearHighlights();
}

async function endPhase(pi){
  const p = players[pi];
  const manaTile = getTile(0,0);
  if(manaTile.occupantId!=null){
    const troop = troops.find(t=>t.id===manaTile.occupantId);
    if(troop && troop.owner===pi){
      p.mana++;
      log(`✨ ${coloredName(pi)} channels a Mana Point! (${p.mana}/10)`);
      const px = axialToPixel(0,0,HEX_SIZE);
      burst(boardX(px.x), boardY(px.y), 0xffd76a, 30);
      updateHUD();
      if(p.mana>=winScore){ gameOver=true; showVictory(pi); }
    }
  }
}

async function executeMove(troop, targetTile){
  const oldTile = getTile(troop.q,troop.r);
  oldTile.occupantId=null;
  troop.q = targetTile.q; troop.r = targetTile.r;
  const px = axialToPixel(targetTile.q, targetTile.r, HEX_SIZE);
  await moveSpritesTo(troop, boardX(px.x), boardY(px.y));
  if(targetTile.type==='thorns'){
    log(`💀 ${coloredName(troop.owner)}'s troop is impaled by thorns!`);
    await destroyTroop(troop, true);
    return;
  }
  targetTile.occupantId = troop.id;
  refreshLockVisual(troop);
  if(LOCKING_TYPES.includes(targetTile.type)){
    log(`${coloredName(troop.owner)} claims ${TILE_INFO[targetTile.type].name}.`);
  }
}

async function executeAttack(attacker, defender){
  const aS = getStats(attacker), dS = getStats(defender);
  const aKills = aS.atk >= dS.def;
  const dKills = dS.atk >= aS.def;
  log(`⚔️ ${coloredName(attacker.owner)} (${aS.atk}/${aS.def}) attacks ${coloredName(defender.owner)} (${dS.atk}/${dS.def}).`);
  const midX = (attacker.sprite.x+defender.sprite.x)/2, midY = (attacker.sprite.y+defender.sprite.y)/2;
  burst(midX, midY, 0xffffff, 20);
  await sleep(200);
  if(aKills) await destroyTroop(defender, false);
  if(dKills) await destroyTroop(attacker, false);
  if(!aKills && !dKills) log(`Both troops bounce off harmlessly.`);
}

function coloredName(pi){
  return `<span style="color:${cssColor(playerColorHex(pi))}">${playerName(pi)}</span>`;
}

/* ---------------------------------------------------------------------
   CPU AI heuristics
--------------------------------------------------------------------- */
function isIsolated(troop){
  return !neighbors(troop.q,troop.r).some(n=>{
    const t = getTroopAt(n.q,n.r);
    return t && t.owner===troop.owner;
  });
}
function gameProgress(){
  // 0 = fresh game, 1 = someone is one mana point from winning. Used to
  // fade out "build my economy" behavior in favor of "close the game out".
  const leaderMana = Math.max(...players.map(p=>p.mana));
  return Math.max(0, Math.min(1, leaderMana/winScore));
}
function scoreMoveTarget(troop, target, pi, myLockedAllies){
  const w = AIW();
  const tile = getTile(target.q, target.r);
  let score=0;
  const curDist = hexDistance(troop, {q:0,r:0});
  const newDist = hexDistance(target, {q:0,r:0});
  score += (curDist-newDist)*w.centerPull;
  const economyFactor = 1 - gameProgress()*w.economyDecay;
  if(tile.type==='mana_pool') score += w.manaPool;
  if(tile.type==='extra_action') score += w.extraAction * economyFactor;
  if(tile.type==='extra_spawn') score += w.extraSpawn * economyFactor;
  if(tile.type==='dagger') score += w.dagger;
  if(tile.type==='atk_plus') score += w.atkPlus;
  if(tile.type==='def_plus') score += w.defPlus;
  if(tile.type==='atk_minus') score += w.atkMinus;
  if(tile.type==='thorns') score += w.thorns;
  // Baseline aggression: drift toward the human player's nearest troop even
  // when nothing else is happening, so CPUs actively hunt rather than idle
  // near their own shrines. Weighted below the center-pull and shrine bonuses
  // above, so it only breaks ties / fills in when there's no bigger prize.
  const humanTroops = troops.filter(t=>players[t.owner].human);
  if(humanTroops.length){
    const curHDist = Math.min(...humanTroops.map(h=>hexDistance(troop,h)));
    const newHDist = Math.min(...humanTroops.map(h=>hexDistance(target,h)));
    score += (curHDist-newHDist)*w.huntNearestEnemy;
  }
  const hypDef = 1 + (tile.type==='def_plus'?1:0);
  neighbors(target.q,target.r).forEach(nb=>{
    const e = getTroopAt(nb.q,nb.r);
    if(e && e.owner!==pi){
      const es = getStats(e);
      const et = getTile(e.q,e.r);
      const enemyIsHighValue = et.type==='mana_pool' || LOCKING_TYPES.includes(et.type);
      if(enemyIsHighValue){
        // Getting adjacent sets up a mana/shrine-denying attack next combat phase --
        // this is a good thing to do, not a risk to avoid.
        score += w.setupHighValueAttack;
      } else if(es.atk >= hypDef){
        score += w.genericRisk; // generic risk of a pointless trade elsewhere on the board
      }
    }
  });
  // Extra urgency to converge on a contested Mana Pool: prioritize landing
  // directly adjacent to it so the following Combat phase can contest it.
  // Only rewards actually gaining adjacency this move -- a troop that is
  // already adjacent and shuffling sideways to a different ring tile should
  // NOT keep re-earning this bonus, or it'll wander instead of attacking.
  const manaTile = getTile(0,0);
  if(manaTile.occupantId!=null){
    const occ = troops.find(t=>t.id===manaTile.occupantId);
    const wasAdjacent = hexDistance(troop,{q:0,r:0})===1;
    const willBeAdjacent = hexDistance(target,{q:0,r:0})===1;
    if(occ && occ.owner!==pi && willBeAdjacent && !wasAdjacent){
      score += w.manaAdjacencyRush;
    }
  }
  // Garrison a locked economy/mana troop of mine that nobody's guarding yet,
  // instead of leaving it standing alone as a free kill for an opponent.
  if(myLockedAllies && myLockedAllies.length){
    myLockedAllies.forEach(lockedAlly=>{
      if(lockedAlly.id===troop.id) return;
      const distNow = hexDistance(troop, lockedAlly);
      const distAfter = hexDistance(target, lockedAlly);
      if(distAfter===1 && distNow!==1){
        const alreadyGuarded = neighbors(lockedAlly.q,lockedAlly.r).some(n=>{
          const t2 = getTroopAt(n.q,n.r);
          return t2 && t2.owner===pi && t2.id!==troop.id;
        });
        if(!alreadyGuarded) score += w.reinforceBonus;
      }
    });
  }
  return score;
}
function cpuChooseMove(pi){
  let best=null, bestScore=2; // threshold: don't move without benefit
  const candidates = [];
  const myLockedAllies = troops.filter(t=>t.owner===pi && LOCKING_TYPES.includes(getTile(t.q,t.r).type));
  troops.filter(t=>t.owner===pi && !isLocked(t)).forEach(troop=>{
    neighbors(troop.q,troop.r).filter(n=>tiles.has(key(n.q,n.r)) && isEmptyTile(n)).forEach(target=>{
      const s = scoreMoveTarget(troop, target, pi, myLockedAllies);
      candidates.push({troop,target,score:s});
      if(s>bestScore){ bestScore=s; best={troop,target,score:s}; }
    });
  });
  if(candidates.length===0) return null;
  // Difficulty: a chance to pick a random legal move instead of the best one.
  if(Math.random() < AIW().mistakeChance){
    return candidates[Math.floor(Math.random()*candidates.length)];
  }
  return best;
}
function cpuChooseAttack(pi){
  const w = AIW();
  let best=null, bestScore=0;
  const candidates = [];
  // "The leader" is whoever has the most mana right now -- usually the
  // human, but not always, since the two CPUs are independent rivals too.
  // Pressuring whoever's actually closest to winning (instead of always
  // fixating on the human) means the CPUs back off a struggling human and
  // lean harder on anyone, human or CPU, who's about to close the game out.
  const leader = players.reduce((a,_,i)=> players[i].mana>players[a].mana ? i : a, 0);
  const leaderMargin = players[leader].mana / winScore;
  const myLockedTroops = troops.filter(t=>t.owner===pi && LOCKING_TYPES.includes(getTile(t.q,t.r).type));
  troops.filter(t=>t.owner===pi && !isLocked(t)).forEach(troop=>{
    const aS = getStats(troop);
    neighbors(troop.q,troop.r).forEach(nb=>{
      const enemy = getTroopAt(nb.q,nb.r);
      if(enemy && enemy.owner!==pi){
        const dS = getStats(enemy);
        const iKill = aS.atk >= dS.def;
        const iDie = dS.atk >= aS.def;
        const et = getTile(enemy.q,enemy.r);
        const highValue = et.type==='mana_pool' ? w.highValueMana : LOCKING_TYPES.includes(et.type) ? w.highValueLocking : 0;
        // Both CPUs like picking off targets that have no ally backing them
        // up, lean harder on whoever's in the lead, and treat an enemy
        // threatening a shrine I already hold as worth acting on even when
        // the trade itself looks marginal.
        const isolatedBonus = isIsolated(enemy) ? w.isolatedBonus : 0;
        const isLeader = enemy.owner===leader;
        const leaderBonus = isLeader ? w.pressureLeader*(1 + w.pressureMarginScale*leaderMargin) : 0;
        const threatensMyLocked = myLockedTroops.some(lt=>
          neighbors(lt.q,lt.r).some(n=>n.q===enemy.q && n.r===enemy.r));
        const defendBonus = threatensMyLocked ? w.defendLockedBonus : 0;
        const pressureBonus = leaderBonus + isolatedBonus + defendBonus;
        let score;
        if(iKill && !iDie) score = w.freeKillBase + highValue + pressureBonus;  // free kill, always take it
        else if(iKill && iDie) score = w.mutualTradeBase + highValue + pressureBonus; // mutual trade — worth it to deny value tiles / pressure the leader
        else if(!iKill && !iDie) score = w.pointlessBump + defendBonus*0.5;         // pointless bump, unless it still chases off a shrine threat
        else score = w.loseForNothingBase + highValue*w.loseForNothingHighValueMult + pressureBonus*w.loseForNothingPressureMult; // I'd die for nothing, unless it's very high value
        candidates.push({attacker:troop, defender:enemy, score});
        if(score>bestScore){ bestScore=score; best={attacker:troop, defender:enemy, score}; }
      }
    });
  });
  if(candidates.length===0) return null;
  // Difficulty: a chance to pick a random legal attack instead of the best one.
  if(Math.random() < w.mistakeChance){
    return candidates[Math.floor(Math.random()*candidates.length)];
  }
  return best;
}

/* ---------------------------------------------------------------------
   Main loop
--------------------------------------------------------------------- */
async function playTurn(pi){
  const p = players[pi];
  log(`<b style="color:${cssColor(p.colorHex)}">— ${p.name}'s Turn —</b>`);
  setPhaseUI(pi,'Start Phase');
  await startPhase(pi); if(gameOver) return;
  setPhaseUI(pi,'Move Phase I');
  await movePhase(pi, true); if(gameOver) return;
  setPhaseUI(pi,'Combat Phase');
  await combatPhase(pi); if(gameOver) return;
  setPhaseUI(pi,'Move Phase II');
  await movePhase(pi, false); if(gameOver) return;
  setPhaseUI(pi,'End Phase');
  await endPhase(pi);
}
async function gameLoop(){
  while(!gameOver){
    await playTurn(currentPlayerIndex);
    if(gameOver) break;
    currentPlayerIndex = (currentPlayerIndex+1)%players.length;
    updateHUD();
    await sleep(300);
  }
}

function showVictory(pi){
  document.getElementById('skip-btn').disabled = true;
  document.getElementById('victory-title').textContent = players[pi].human ? 'Victory!' : 'Defeat...';
  document.getElementById('victory-title').style.color = cssColor(players[pi].colorHex);
  document.getElementById('victory-text').innerHTML = `${coloredName(pi)} has gathered <b>${winScore} mana points</b> and won the Surge!`;
  document.getElementById('victory-modal').style.display='flex';
  const px = axialToPixel(0,0,HEX_SIZE);
  for(let i=0;i<5;i++){
    scene.time.delayedCall(i*180, ()=>burst(boardX(px.x)+ (Math.random()*80-40), boardY(px.y)+(Math.random()*80-40), players[pi].colorHex, 30));
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

    players = COLOR_META.map((c,i)=>({...c, human:i===humanColorIndex, mana:0, actionPoints:1}));
    try{
      buildBoard();
      renderBoard();
      setupTileInput();
      setupInitialTroops();
      buildManaPanel();
      updateHUD();
      startBGM(this, this._loadedBGM); // begins now that actual play is starting
      currentPlayerIndex = 0;
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
    humanColorIndex = parseInt(btn.dataset.color, 10);
    document.querySelectorAll('.color-btn').forEach(b=>b.classList.toggle('selected', b===btn));
  });
});
document.querySelectorAll('.diff-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    difficulty = btn.dataset.diff;
    document.querySelectorAll('.diff-btn').forEach(b=>b.classList.toggle('selected', b===btn));
  });
});
document.getElementById('winscore-slider').addEventListener('input', (e)=>{
  winScore = parseInt(e.target.value, 10);
  document.getElementById('winscore-value').textContent = winScore;
  document.getElementById('intro-winscore').textContent = winScore;
  document.getElementById('help-winscore').textContent = winScore;
});
document.getElementById('start-btn').addEventListener('click', ()=>{
  document.getElementById('hidden-start-overlay').style.display='none';
  boot();
});
function openHelpModal(){
  const modal = document.getElementById('help-modal');
  modal.style.display='flex';
  modal.querySelector('.modal-box').scrollTop = 0;
  document.getElementById('help-winscore').textContent = winScore;
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
  if(pending && (pending.kind==='move' || pending.kind==='attack')){
    const r = pending.resolve; pending=null; clearHighlights();
    r({type:'skip'});
  } else if(pending && pending.kind==='sacrifice'){
    const r = pending.resolve; pending=null; clearHighlights();
    r(null);
  }
});
document.getElementById('dagger-btn').addEventListener('click', ()=>{
  if(pending && (pending.kind==='move' || pending.kind==='attack')){
    const r = pending.resolve; pending=null; clearHighlights();
    r({type:'dagger'});
  }
});
document.getElementById('restart-btn').addEventListener('click', ()=>{ location.reload(); });
document.getElementById('playagain-btn').addEventListener('click', ()=>{ location.reload(); });

