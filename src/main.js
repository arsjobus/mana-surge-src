import { setupModalUI } from './ui/ModalUI.js';
import { gameState, startGame } from './GameRuntime.js';
import { setupMultiplayerLobby } from './multiplayer/LobbyUI.js';

const lobby = setupMultiplayerLobby({ state: gameState, onStartMatch: () => {
  document.getElementById('lobby-status').textContent = 'Lobby is ready. Multiplayer match execution is the next roadmap section.';
} });
setupModalUI({ state: gameState, onStart: startGame, onMultiplayer: lobby.open });
