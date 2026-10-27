export function sleep(ms){ return new Promise(res=>setTimeout(res,ms)); }
export function tweenPromise(scene, targets, props, duration, ease){
  return new Promise(resolve=>{
    scene.tweens.add({targets, ...props, duration, ease: ease||'Sine.easeInOut', onComplete:()=>resolve()});
  });
}
