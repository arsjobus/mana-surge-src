const CREDITS=[{role:'Design, Code & Art',name:'Alexander Shepherd'}];

/**
 * Choose which end-of-match buttons are shown.
 *  solo  - Return to Main Menu
 *  host  - Play Again (starts the next match) + Leave Match
 *  guest - waiting note + Leave Match (only the host can start a match)
 *  menu  - Return to Main Menu only (disconnect and error dialogs)
 */
export function configureMatchEndButtons(mode) {
  const play=document.getElementById('playagain-btn'),leave=document.getElementById('leave-match-btn'),note=document.getElementById('match-end-note');
  play.style.display=mode==='guest'?'none':'';
  play.textContent=mode==='host'?'Play Again':'Return to Main Menu';
  play.dataset.action=mode==='host'?'rematch':'menu';
  leave.style.display=mode==='host'||mode==='guest'?'':'none';
  note.textContent=mode==='guest'?'Waiting for the host to start another match…':'';
}

export function setupModalUI({state,onStart,onMultiplayer=()=>{},onPlayAgain=()=>{},onLeave=()=>location.reload()}) {
  document.querySelectorAll('.color-btn').forEach(btn=>btn.addEventListener('click',()=>{state.humanColorIndex=parseInt(btn.dataset.color,10);document.querySelectorAll('.color-btn').forEach(b=>b.classList.toggle('selected',b===btn));}));
  document.querySelectorAll('.diff-btn').forEach(btn=>btn.addEventListener('click',()=>{state.difficulty=btn.dataset.diff;document.querySelectorAll('.diff-btn').forEach(b=>b.classList.toggle('selected',b===btn));}));
  document.getElementById('winscore-slider').addEventListener('input',e=>{state.winScore=parseInt(e.target.value,10);document.getElementById('winscore-value').textContent=state.winScore;document.getElementById('intro-winscore').textContent=state.winScore;document.getElementById('help-winscore').textContent=state.winScore;});
  document.getElementById('start-btn').addEventListener('click',()=>{document.getElementById('hidden-start-overlay').style.display='none';onStart();});
  document.getElementById('multiplayer-btn').addEventListener('click',onMultiplayer);
  const openHelp=()=>{const modal=document.getElementById('help-modal');modal.style.display='flex';modal.querySelector('.modal-box').scrollTop=0;document.getElementById('help-winscore').textContent=state.winScore;};
  document.getElementById('rules-btn').addEventListener('click',openHelp);document.getElementById('help-btn').addEventListener('click',openHelp);
  ['close-help','close-help-x'].forEach(id=>document.getElementById(id).addEventListener('click',()=>{document.getElementById('help-modal').style.display='none';}));
  document.getElementById('credits-btn').addEventListener('click',()=>{document.getElementById('credits-list').innerHTML=CREDITS.map(c=>`<div class="credit-row"><span class="credit-role">${c.role}</span><span class="credit-name">${c.name}</span></div>`).join('');const modal=document.getElementById('credits-modal');modal.style.display='flex';modal.querySelector('.modal-box').scrollTop=0;});
  ['close-credits','close-credits-x'].forEach(id=>document.getElementById(id).addEventListener('click',()=>{document.getElementById('credits-modal').style.display='none';}));
  document.getElementById('restart-btn').addEventListener('click',()=>state.session?onLeave({midMatch:!state.gameOver}):location.reload());
  document.getElementById('playagain-btn').addEventListener('click',e=>e.currentTarget.dataset.action==='rematch'?onPlayAgain():location.reload());
  document.getElementById('leave-match-btn').addEventListener('click',()=>onLeave({midMatch:false}));
}

export function presentVictory({state,pi,scene,cssColor,coloredName,boardX,boardY,burst,axialToPixel,hexSize}) {
  document.getElementById('skip-btn').disabled=true;
  document.getElementById('victory-title').textContent=state.players[pi].human?'Victory!':'Defeat...';
  document.getElementById('victory-title').style.color=cssColor(state.players[pi].colorHex);
  document.getElementById('victory-text').innerHTML=`${coloredName(pi)} has gathered <b>${state.winScore} mana points</b> and won the Surge!`;
  document.getElementById('guest-disconnect-actions').style.display='none';
  document.getElementById('host-disconnect-actions').style.display='none';
  configureMatchEndButtons(state.session?.role==='host'?'host':state.session?.role==='guest'?'guest':'solo');
  document.getElementById('victory-modal').style.display='flex';
  const px=axialToPixel(0,0,hexSize);for(let i=0;i<5;i++)scene.time.delayedCall(i*180,()=>burst(boardX(px.x)+(Math.random()*80-40),boardY(px.y)+(Math.random()*80-40),state.players[pi].colorHex,30));
}
