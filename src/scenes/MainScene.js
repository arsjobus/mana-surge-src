export function createMainScene({state, buildTextures, loadBGM, setupMatch, onError}) {
  return class MainScene extends Phaser.Scene {
    constructor(){super('main');}
    async create(){
      const origin={x:this.scale.width/2,y:this.scale.height/2};
      const loading=this.add.text(origin.x,origin.y,'Weaving the realm…',{fontFamily:'Georgia, serif',fontSize:'20px',color:'#e8c974'}).setOrigin(0.5).setDepth(100);
      let bgm;
      try{[ ,bgm ]=await Promise.all([buildTextures(this),loadBGM(this)]);}catch(error){console.error('Texture build failed:',error);loading.setText('Failed to load graphics — check console (F12).');return;}
      loading.destroy();
      try{await setupMatch(this,origin,bgm);}catch(error){console.error('Game setup failed:',error);onError(this,origin);}
    }
  };
}
