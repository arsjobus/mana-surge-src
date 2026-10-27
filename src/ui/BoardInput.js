import { TOKEN_SCALE } from '../entities/Troop.js';

export function createBoardInput(context) {
  const { state, scene, actions, getTile, getTroopAt, isLocked, isEmptyTile, neighbors, key, hexDistance, tileInfo, playerColor, playerName, getStats, cssColor } = context;
  let highlights = [];
  let selection = null;
  function canControlPendingAction(pending) {
    return !(state.session?.role === 'host' && state.session.roster?.[pending?.playerIndex]?.controller === 'guest');
  }
  function clearHighlights() {
    highlights.forEach(sprite => { if (sprite?.setAlpha) sprite.setAlpha(0); if (sprite?._tween) { sprite._tween.stop(); sprite._tween = null; } });
    highlights = [];
    if (selection) { selection.setAlpha(0); selection = null; }
  }
  function selectTroop(troop) {
    troop.selSprite.setAlpha(1);
    if (troop.selSprite._tween) troop.selSprite._tween.stop();
    troop.selSprite._tween = scene.tweens.add({ targets: troop.selSprite, scale:{from:TOKEN_SCALE*1.1,to:TOKEN_SCALE*1.35}, alpha:{from:1,to:0.35}, duration:600, yoyo:true, repeat:-1 });
    selection = troop.selSprite;
  }
  function highlightTiles(coords, tint) {
    coords.forEach(c => {
      const sprite = getTile(c.q,c.r).highlightSprite;
      sprite.setTint(tint).setAlpha(0.9);
      sprite._tween = scene.tweens.add({targets:sprite,alpha:{from:0.5,to:1},duration:500,yoyo:true,repeat:-1});
      highlights.push(sprite);
    });
  }
  function highlightAttacks(troops) {
    troops.forEach(t => { t.selSprite.setTint(0xff5757).setAlpha(0.9); t.selSprite._tween=scene.tweens.add({targets:t.selSprite,scale:{from:TOKEN_SCALE*1.15,to:TOKEN_SCALE*1.4},alpha:{from:0.5,to:1},duration:450,yoyo:true,repeat:-1}); highlights.push(t.selSprite); });
  }
  function showTileInfo(tile, troop) {
    const info = tileInfo[tile.type] || tileInfo.plain;
    let html = `<b>${info.name}</b><br>${info.desc}`;
    if (troop) { const stats=getStats(troop); html += `<br><span style="color:${cssColor(playerColor(troop.owner))}">${playerName(troop.owner)} troop</span> — ATK ${stats.atk} / DEF ${stats.def}${isLocked(troop)?' (locked)':''}`; }
    document.getElementById('tile-info').innerHTML=html;
  }
  function invalid(troop) { scene.tweens.add({targets:troop.sprite,x:'+=4',duration:40,yoyo:true,repeat:4}); }
  function onTroopClicked(troop) {
    const pending=actions.current(); if(!pending || !canControlPendingAction(pending)) return;
    const {kind,playerIndex}=pending;
    if(kind==='sacrifice') { if(troop.owner===playerIndex&&!pending.picks.includes(troop)){ pending.picks.push(troop); troop.selSprite.setTint(0xd94fa0).setAlpha(1); if(pending.picks.length>=3){const troopIds=pending.picks.map(pick=>pick.id);clearHighlights();actions.submit({type:'sacrifice',troopIds});} } return; }
    if(kind==='move'&&troop.owner===playerIndex&&!isLocked(troop)) { const targets=neighbors(troop.q,troop.r).filter(n=>state.tiles.has(key(n.q,n.r))&&isEmptyTile(n)); if(!targets.length){invalid(troop);return;} clearHighlights();pending.selected=troop.id;selectTroop(troop);highlightTiles(targets,0x6fffb0); }
    else if(kind==='attack') {
      const selectedTroop=state.troops.find(item=>item.id===pending.selected);
      if(selectedTroop&&troop.owner!==playerIndex&&hexDistance(selectedTroop,troop)===1){clearHighlights();actions.submit({type:'attack',attackerId:selectedTroop.id,defenderId:troop.id});return;}
      if(troop.owner===playerIndex&&!isLocked(troop)){const targets=neighbors(troop.q,troop.r).map(n=>getTroopAt(n.q,n.r)).filter(t=>t&&t.owner!==playerIndex);if(!targets.length){invalid(troop);return;}clearHighlights();pending.selected=troop.id;selectTroop(troop);highlightAttacks(targets);}
    }
  }
  function onTileClicked(tile) {
    const pending=actions.current();if(!pending || !canControlPendingAction(pending))return;
    if(pending.kind==='move'&&pending.selected){const troop=state.troops.find(item=>item.id===pending.selected);if(troop&&hexDistance(troop,tile)===1&&isEmptyTile(tile)){clearHighlights();actions.submit({type:'move',troopId:troop.id,q:tile.q,r:tile.r});}}
    else if(pending.kind==='spawnChoice'&&pending.options?.some(o=>o.q===tile.q&&o.r===tile.r)){clearHighlights();actions.submit({type:'spawn',q:tile.q,r:tile.r});}
  }
  function setup() { state.tiles.forEach(tile=>{tile.baseSprite.setInteractive({useHandCursor:false});tile.baseSprite.on('pointerdown',()=>onTileClicked(tile));tile.baseSprite.on('pointerover',()=>showTileInfo(tile,getTroopAt(tile.q,tile.r)));}); }
  return {clearHighlights,highlightSpawnOptions:coords=>highlightTiles(coords,0xffd76a),setup,onTroopClicked,showTileInfo};
}
