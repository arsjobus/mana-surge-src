export function loadBGM(scene) { return new Promise(resolve=>{let settled=false;const finish=sound=>{if(!settled){settled=true;resolve(sound);}};try{scene.load.audio('bgm','assets/music/bgm.mp3');scene.load.once('complete',()=>{try{finish(scene.sound.add('bgm',{loop:true,volume:0.4}));}catch(e){console.warn('BGM could not be created:',e);finish(null);}});scene.load.once('loaderror',file=>{console.warn('BGM failed to load:',file&&file.src);finish(null);});scene.load.start();}catch(e){console.warn('BGM loading skipped:',e);finish(null);}setTimeout(()=>finish(null),8000);}); }
export function startBGM(scene,sound) {
  if(sound){
    const play=()=>{try{sound.play();}catch(e){console.warn('BGM play failed:',e);}};
    if(scene.sound.locked)scene.sound.once('unlocked',play);else play();
  }
  const btn=document.getElementById('mute-btn');
  btn.style.display='flex';
  btn.style.alignItems='center';
  btn.style.justifyContent='center';
  btn.addEventListener('click',()=>{
    const muted=sound?!sound.mute:btn.textContent==='🔊';
    if(sound)sound.setMute(muted);
    btn.textContent=muted?'🔇':'🔊';
  });
}
