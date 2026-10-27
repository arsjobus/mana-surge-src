export function createGameHUD({state, cssColor, actions}) {
  function buildManaPanel() { const panel=document.getElementById('mana-panel');panel.innerHTML='';state.players.forEach((p,i)=>{const row=document.createElement('div');row.className='mana-row';row.id='mana-row-'+i;row.style.setProperty('--rowcolor',cssColor(p.colorHex));row.innerHTML=`<div class="mr-top"><span class="mr-name">${p.name}</span><span class="mr-count">0 / ${state.winScore}</span></div><div class="mana-bar-bg"><div class="mana-bar-fill" style="width:0%"></div></div>`;panel.appendChild(row);}); }
  function updateHUD() { state.players.forEach((p,i)=>{const row=document.getElementById('mana-row-'+i);row.classList.toggle('active',i===state.currentPlayerIndex);row.querySelector('.mr-count').textContent=`${p.mana} / ${state.winScore}`;row.querySelector('.mana-bar-fill').style.width=(p.mana/state.winScore*100)+'%';});const p=state.players[state.currentPlayerIndex];document.getElementById('turn-text').textContent=p.name+"'s Turn";document.getElementById('turn-dot').style.background=cssColor(p.colorHex);document.getElementById('turn-dot').style.color=cssColor(p.colorHex);const el=document.getElementById('ap-pips');el.innerHTML='';for(let i=0;i<Math.max(p.actionPoints||0,p.maxActionPointsSeen||1);i++){const d=document.createElement('div');d.className='pip'+(i<(p.actionPoints||0)?' on':'');el.appendChild(d);} }
  function setPhaseUI(_pi,phase){document.getElementById('phase-text').textContent=phase;}
  function log(msg){console.log(msg.replace(/<[^>]+>/g,''));}
  function setupActionButtons(clearHighlights){
    document.getElementById('skip-btn').addEventListener('click',()=>{const p=actions.current();if(p&&(p.kind==='move'||p.kind==='attack')){clearHighlights();actions.submit({type:'skip'});}else if(p?.kind==='sacrifice'){clearHighlights();actions.cancel();}});
    document.getElementById('dagger-btn').addEventListener('click',()=>{const p=actions.current();if(p&&(p.kind==='move'||p.kind==='attack')){clearHighlights();actions.submit({type:'dagger'});}});
  }
  return {buildManaPanel,updateHUD,setPhaseUI,log,setupActionButtons};
}
