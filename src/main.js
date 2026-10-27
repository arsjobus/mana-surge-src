import { setupModalUI } from './ui/ModalUI.js';
import { gameState, startGame } from './GameRuntime.js';
import { setupMultiplayerLobby } from './multiplayer/LobbyUI.js';

const lobby = setupMultiplayerLobby({ state: gameState, onStartMatch: match => {
  match.retryGuest = lobby.retryGuest;
  match.reopenLobby = lobby.open;
  document.getElementById('multiplayer-modal').style.display = 'none';
  document.getElementById('hidden-start-overlay').style.display = 'none';
  document.getElementById('victory-modal').style.display = 'none';
  document.getElementById('guest-disconnect-actions').style.display = 'none';
  document.getElementById('host-disconnect-actions').style.display = 'none';
  startGame(match);
} });
setupModalUI({ state: gameState, onStart: startGame, onMultiplayer: lobby.open });
