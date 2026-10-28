import { WebRtcPeer } from './WebRtcPeer.js';
import { createSignalingInvite, joinSignalingInvite } from './SignalingClient.js';

const INVITE_PREFIX = 'mana-join-';

/** Start a private match through the configured short-lived signaling relay. */
export function setupMultiplayerLobby({ state, onStartMatch = () => {} }) {
  const modal = document.getElementById('multiplayer-modal');
  const status = document.getElementById('lobby-status');
  const result = document.getElementById('lobby-code-result');
  const output = document.getElementById('lobby-code-output');
  const hostPeers = new Map();
  const inviteSessions = new Map();
  let guestPeer = null;
  let guestSignal = null;
  let guestSeatConfirmed = false;
  let guestMatchStarted = false;
  let guestStartTriggered = false;
  let operation = 0;
  let role = null;

  const setStatus = message => { status.textContent = message; };
  const setOutput = (title, value) => {
    result.hidden = false;
    document.getElementById('lobby-code-title').textContent = title;
    output.value = value;
    output.focus(); output.select();
  };
  const startConfirmedGuest = () => {
    if (role !== 'guest' || guestStartTriggered || !guestSeatConfirmed || !guestMatchStarted || !state.multiplayer || !guestPeer) return;
    guestStartTriggered = true;
    document.getElementById('guest-join-btn').hidden = true;
    onStartMatch(state.multiplayer);
  };
  const closeSessions = () => {
    operation++;
    for (const invite of inviteSessions.values()) invite.close();
    inviteSessions.clear();
    for (const peer of hostPeers.values()) peer.close();
    hostPeers.clear();
    guestSignal?.close(); guestSignal = null;
    guestPeer?.close(); guestPeer = null;
  };
  const open = () => { modal.style.display = 'flex'; setStatus('Choose host or guest to begin.'); };
  document.getElementById('lobby-close').addEventListener('click', () => { closeSessions(); modal.style.display = 'none'; });
  document.getElementById('lobby-cancel').addEventListener('click', () => { closeSessions(); role = null; result.hidden = true; setStatus('Lobby cancelled.'); });

  document.querySelectorAll('.host-seat-btn').forEach(button => button.addEventListener('click', () => {
    state.humanColorIndex = Number(button.dataset.seat);
    document.querySelectorAll('.host-seat-btn').forEach(item => item.classList.toggle('selected', item === button));
    document.querySelectorAll('.seat-mode').forEach(select => {
      const seat = Number(select.dataset.seat);
      if (seat === state.humanColorIndex) { select.disabled = true; select.innerHTML = '<option value="host">Host</option>'; }
      else { select.disabled = false; select.innerHTML = '<option value="cpu">CPU</option><option value="guest">Open to guest</option>'; }
    });
    refreshInviteSeats();
  }));
  function refreshInviteSeats() {
    const chooser = document.getElementById('invite-seat');
    const openSeats = [...document.querySelectorAll('.seat-mode')].filter(select => select.value === 'guest').map(select => Number(select.dataset.seat));
    chooser.innerHTML = openSeats.map(seat => `<option value="${seat}">${['Red', 'Blue', 'Green'][seat]}</option>`).join('');
    chooser.disabled = !openSeats.length;
  }
  document.querySelectorAll('.seat-mode').forEach(select => select.addEventListener('change', refreshInviteSeats));
  refreshInviteSeats();

  async function createInvite(seat, config, attempt = operation) {
    if (hostPeers.has(seat)) throw new Error('That seat already has an invite.');
    const peer = new WebRtcPeer({ role: 'host', matchId: config.matchId, localSeat: config.hostSeat, remoteSeat: seat,
      onState: value => setStatus(`Seat ${seat + 1}: ${value}`), onError: () => setStatus(`Seat ${seat + 1}: connection error.`) });
    hostPeers.set(seat, peer);
    const coordinator = state.multiplayerCoordinator;
    if (coordinator) {
      if (coordinator.peers.has(seat)) coordinator.replacePeer(seat, peer);
      else coordinator.addPeer(seat, peer);
    }
    try {
      const offer = await peer.createOffer();
      if (attempt !== operation || hostPeers.get(seat) !== peer) { peer.close(); return; }
      const invite = await createSignalingInvite({ matchId: config.matchId, hostSeat: config.hostSeat, seat,
        score: state.winScore, offer, onStatus: setStatus });
      if (attempt !== operation || hostPeers.get(seat) !== peer) { invite.close(); peer.close(); return; }
      inviteSessions.set(seat, invite);
      setOutput(`Invite for ${['Red', 'Blue', 'Green'][seat]}`, `${INVITE_PREFIX}${invite.code}`);
      setStatus(`Invite ready for ${['Red', 'Blue', 'Green'][seat]}. Send it to the intended player.`);
      invite.waitForAnswer().then(({ seat: answerSeat, answer }) => {
        if (answerSeat !== seat || hostPeers.get(seat) !== peer) return;
        return peer.acceptAnswer(answer).then(() => setStatus(`Seat ${seat + 1}: connecting directly…`));
      }).catch(error => {
        if (hostPeers.get(seat) === peer) setStatus(`Seat ${seat + 1}: ${error.message}`);
      }).finally(() => inviteSessions.delete(seat));
    } catch (error) {
      if (hostPeers.get(seat) === peer) hostPeers.delete(seat);
      peer.close();
      throw error;
    }
  }

  async function retryGuest(seat) {
    const config = state.multiplayer;
    if (role !== 'host' || !config || !Number.isInteger(seat) || config.roster?.[seat]?.controller !== 'guest') return false;
    hostPeers.get(seat)?.close(); hostPeers.delete(seat);
    inviteSessions.get(seat)?.close(); inviteSessions.delete(seat);
    try {
      await createInvite(seat, config);
      setStatus(`Fresh invite ready for ${['Red', 'Blue', 'Green'][seat]}.`);
      return true;
    } catch (error) { setStatus(`Could not recreate the connection: ${error.message}`); return false; }
  }

  document.getElementById('host-create-btn').addEventListener('click', async () => {
    const reuse = role === 'host' && state.multiplayer;
    if (!reuse) closeSessions();
    role = 'host';
    const hostSeat = state.humanColorIndex;
    const openSeats = [...document.querySelectorAll('.seat-mode')].filter(select => select.value === 'guest').map(select => Number(select.dataset.seat)).filter(seat => seat !== hostSeat);
    const roster = [0, 1, 2].map(seat => ({ seat, controller: seat === hostSeat ? 'host' : openSeats.includes(seat) ? 'guest' : 'cpu' }));
    const config = state.multiplayer = { role, hostSeat, roster, matchId: reuse ? state.multiplayer.matchId : crypto.randomUUID(), peers: hostPeers };
    config.retryGuest = retryGuest;
    config.reopenLobby = open;
    document.getElementById('lobby-start-match').onclick = () => {
      if (openSeats.some(seat => !hostPeers.has(seat))) return setStatus('Create an invite for each open guest seat, or change that seat to CPU.');
      const waiting = openSeats.filter(seat => hostPeers.get(seat)?.channel?.readyState !== 'open');
      if (waiting.length) return setStatus(`Waiting for ${waiting.map(seat => ['Red', 'Blue', 'Green'][seat]).join(' and ')} to connect.`);
      onStartMatch(config);
    };
    const seat = Number(document.getElementById('invite-seat').value);
    if (!document.getElementById('invite-seat').value) return setStatus('All seats are ready as host/CPU. Start the match when ready.');
    if (!openSeats.includes(seat)) return setStatus('Choose an open guest seat.');
    try { await createInvite(seat, config, operation); }
    catch (error) { setStatus(`Could not create invite: ${error.message}`); }
  });

  document.getElementById('guest-prepare-btn').addEventListener('click', async () => {
    const attempt = ++operation;
    guestSignal?.close(); guestSignal = null;
    guestPeer?.close(); guestPeer = null;
    role = 'guest';
    try {
      const code = document.getElementById('guest-offer').value.trim().replace(/^mana-join-/, '');
      if (!/^[A-Za-z0-9_-]{10,16}$/.test(code)) throw new Error('Enter a valid invite code.');
      const signal = await joinSignalingInvite(code);
      if (attempt !== operation) { signal.close(); return; }
      guestSignal = signal;
      const { offer, matchId, seat, hostSeat, score } = guestSignal;
      if (![0, 1, 2].includes(seat) || ![0, 1, 2].includes(hostSeat) || seat === hostSeat) throw new Error('Invalid invite seat.');
      guestPeer = new WebRtcPeer({ role: 'guest', matchId, localSeat: seat, remoteSeat: hostSeat,
        onState: value => setStatus(`Connection: ${value}`), onError: () => setStatus('Connection error.') });
      const answer = await guestPeer.acceptOffer(offer);
      if (attempt !== operation) { guestSignal.close(); guestPeer.close(); return; }
      if (!await guestSignal.submitAnswer(answer)) throw new Error('Could not return the connection answer.');
      state.multiplayer = { role, hostSeat, localSeat: seat, matchId, winScore: score, peer: guestPeer };
      guestSeatConfirmed = false;
      guestMatchStarted = false;
      guestStartTriggered = false;
      guestPeer.onMessage = message => {
        if (message.type !== 'matchStarted') return;
        guestMatchStarted = true;
        startConfirmedGuest();
      };
      setOutput(`You are joining as ${['Red', 'Blue', 'Green'][seat]}`, `Seat: ${['Red', 'Blue', 'Green'][seat]}`);
      document.getElementById('lobby-seat-confirm').textContent = `Confirm ${['Red', 'Blue', 'Green'][seat]} seat`;
      document.getElementById('lobby-seat-confirm').hidden = false;
      document.getElementById('guest-join-btn').hidden = true;
      document.getElementById('lobby-seat-confirm').onclick = () => {
        guestSeatConfirmed = true;
        setStatus(`Seat confirmed. The match will start automatically when the host starts.`);
        startConfirmedGuest();
      };
      setStatus(`Connected to the invite service. The answer was returned to the host automatically. Confirm your ${['Red', 'Blue', 'Green'][seat]} seat.`);
    } catch (error) { setStatus(error.message); }
  });

  document.getElementById('lobby-copy-btn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(output.value); setStatus('Invite copied.'); }
    catch { setStatus('Select and copy the invite.'); }
  });
  document.getElementById('lobby-start-match').hidden = false;
  document.getElementById('lobby-seat-confirm').hidden = true;
  document.getElementById('guest-join-btn').hidden = true;
  document.getElementById('guest-join-btn').disabled = false;
  return { open, close: closeSessions, retryGuest };
}
