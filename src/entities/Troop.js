import { HEX_SIZE, axialToPixel } from '../utils/hex.js';
import { tweenPromise } from '../utils/async.js';

export const TOKEN_SCALE = (HEX_SIZE * 0.5) / 40;

export function createTroop(context, owner, q, r, animate) {
  const { scene, tiles, troops, nextId, boardOrigin, playerColor, getStats, isLocked, onClick, onHover, burst } = context;
  const tile = tiles.get(`${q},${r}`);
  const troop = { id: nextId(), owner, q, r };
  tile.occupantId = troop.id;
  const px = axialToPixel(q, r, HEX_SIZE);
  const x = boardOrigin.x + px.x, y = boardOrigin.y + px.y;
  const glow = scene.add.image(x,y,'particleGlow').setScale(1.5).setAlpha(0.5).setTint(playerColor(owner)).setDepth(3).setBlendMode('ADD');
  const sprite = scene.add.image(x,y,'tokenBadge').setScale(animate?0:TOKEN_SCALE).setTint(playerColor(owner)).setDepth(4).setInteractive({useHandCursor:true});
  const lock = scene.add.image(x,y,'lockRing').setScale(TOKEN_SCALE*1.05).setAlpha(0).setDepth(5).setTint(0xffd76a);
  const sel = scene.add.image(x,y,'selRing').setScale(TOKEN_SCALE*1.15).setAlpha(0).setDepth(5).setTint(0xffffff);
  const statText = scene.add.text(x,y,'1/1', {
    fontFamily:'Georgia, serif', fontSize: Math.round(HEX_SIZE*0.42)+'px', fontStyle:'bold', color:'#ffffff',
    stroke:'#000000', strokeThickness:3
  }).setOrigin(0.5).setDepth(5);
  troop.sprite = sprite; troop.glow = glow; troop.lockSprite = lock; troop.selSprite = sel; troop.statText = statText;
  sprite.on('pointerdown', ()=>onClick(troop));
  sprite.on('pointerover', ()=>onHover(tile, troop));
  troops.push(troop);
  refreshLockVisual(context, troop);
  if(animate){
    scene.tweens.add({targets:sprite, scale:TOKEN_SCALE, duration:280, ease:'Back.easeOut'});
    burst(x,y,playerColor(owner),14);
  }
  return troop;
}

export async function destroyTroop(context, troop, isThorns) {
  const { scene, tiles, troops, playerColor, burst } = context;
  const idx = troops.indexOf(troop);
  if(idx>=0) troops.splice(idx,1);
  const tile = tiles.get(`${troop.q},${troop.r}`);
  if(tile && tile.occupantId===troop.id) tile.occupantId=null;
  burst(troop.sprite.x, troop.sprite.y, isThorns?0xff4444:playerColor(troop.owner), 22);
  scene.cameras.main.shake(120, 0.0025);
  await tweenPromise(scene, [troop.sprite, troop.glow, troop.lockSprite, troop.selSprite, troop.statText], {scale:0, alpha:0}, 260, 'Back.easeIn');
  troop.sprite.destroy(); troop.glow.destroy(); troop.lockSprite.destroy(); troop.selSprite.destroy(); troop.statText.destroy();
}

export function refreshLockVisual(context, troop) {
  const locked = context.isLocked(troop);
  troop.lockSprite.setAlpha(locked?0.85:0);
  if(locked && !troop._lockTween){
    troop._lockTween = context.scene.tweens.add({targets:troop.lockSprite, angle:360, duration:5000, repeat:-1});
  }
  const st = context.getStats(troop);
  troop.statText.setText(`${st.atk}/${st.def}`);
}

export function burst(scene, x, y, color, count) {
  const em = scene.add.particles(x,y,'particleSpark',{
    speed:{min:60,max:220}, angle:{min:0,max:360}, lifespan:{min:350,max:650},
    scale:{start:0.9,end:0}, alpha:{start:1,end:0}, tint:color, blendMode:'ADD'
  }).setDepth(6);
  em.explode(count||16);
  scene.time.delayedCall(750, ()=>em.destroy());
}

export function moveSpritesTo(scene, troop, x, y) {
  return tweenPromise(scene, [troop.sprite, troop.glow, troop.lockSprite, troop.selSprite, troop.statText], {x,y}, 260);
}
