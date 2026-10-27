import { HEX_SIZE, axialToPixel, hexPolygonPoints } from '../utils/hex.js';

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

export function buildTextures(scene){
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
export const TOKEN_SCALE = (HEX_SIZE*0.5)/40;

export function renderBoard(scene, tiles, players, boardOrigin){
  const boardX = (px) => boardOrigin.x + px;
  const boardY = (py) => boardOrigin.y + py;
  const playerColorHex = (pi) => players[pi].colorHex;
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

