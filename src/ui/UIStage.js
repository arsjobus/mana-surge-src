export function createUIStage(game, width=1100) {
  function sync() { if(!game?.canvas)return;const rect=game.canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;const stage=document.getElementById('ui-stage');stage.style.left=rect.left+'px';stage.style.top=rect.top+'px';stage.style.transform=`scale(${rect.width/width})`; }
  game.events.once('ready',()=>{game.scale.on('resize',sync);sync();});
  window.addEventListener('resize',sync);
  if(window.ResizeObserver)new ResizeObserver(sync).observe(document.getElementById('game-container'));
  return sync;
}
