import { setupModalUI } from './ui/ModalUI.js';
import { gameState, startGame } from './GameRuntime.js';

setupModalUI({ state: gameState, onStart: startGame });
