export const GAME_WIDTH = 1100;
export const GAME_HEIGHT = 820;

export function createGameConfig(scene) {
  return {
    type: Phaser.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    parent: 'game-container',
    transparent: true,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.NO_CENTER
    },
    scene: [scene]
  };
}
