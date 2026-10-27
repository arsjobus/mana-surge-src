import { WebRtcPeer } from './WebRtcPeer.js';
import { SessionCoordinator } from './SessionCoordinator.js';
import { exportSignalingCode, importSignalingCode } from './SignalingCode.js';

const encode = value => `mana-room1.${btoa(unescape(encodeURIComponent(JSON.stringify(value)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
function decode(code, expected) {
  try {
    if (typeof code !== 'string' || code.length > 100_000 || !code.startsWith('mana-room1.')) return null;
    const raw = code.slice(11).replace(/-/g, '+').replace(/_/g, '/');
    const value = JSON.parse(decodeURIComponent(escape(atob(raw + '='.repeat((4 - raw.length % 4) % 4)))));
    return value?.v === 1 && value.type === expected ? value : null;
  } catch { return null; }
}

/** UI and signaling lifecycle for the manual host/guest lobby. */
export function setupMultiplayerLobby({ state, onStartMatch = () => {} }) {
  const modal = document.getElementById('multiplayer-modal');
  const status = document.getElementById('lobby-status');
  const result = document.getElementById('lobby-code-result');
  const output = document.getElementById('lobby-code-output');
  const coordinatorRef = { current: null };
  const hostPeers = new Map();
  let guestPeer = null;
  let role = null;
  let roster = null;
  let confirmed = false;
  const setStatus = message => { status.textContent = message; };
  const setOutput = (title, code) => {
    result.hidden = false;
    document.getElementById('lobby-code-title').textContent = title;
    output.value = code;
    output.focus(); output.select();
  };
  const closeSessions = () => {
    coordinatorRef.current?.close(); coordinatorRef.current = null;
    for (const peer of hostPeers.values()) peer.close();
    hostPeers.clear();
    guestPeer?.close(); guestPeer = null;
  };
  const open = () => { modal.style.display = 'flex'; setStatus('Choose host or guest to begin.'); };
  document.getElementById('lobby-close').addEventListener('click', () => { closeSessions(); modal.style.display = 'none'; });
  document.getElementById('lobby-cancel').addEventListener('click', () => { closeSessions(); role = null; confirmed = false; result.hidden = true; setStatus('Lobby cancelled.'); });

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
  async function retryGuest(seat) {
    const config = state.multiplayer;
    if (role !== 'host' || !config || !Number.isInteger(seat) || config.roster?.[seat]?.controller !== 'guest') return false;
    const previous = hostPeers.get(seat);
    if (previous) { previous.onState = () => {}; previous.close(); }
    hostPeers.delete(seat);
    try {
      const peer = new WebRtcPeer({ role: 'host', matchId: config.matchId, localSeat: config.hostSeat, remoteSeat: seat,
        onState: value => setStatus(`Seat ${seat + 1}: ${value}`), onError: () => setStatus(`Seat ${seat + 1}: connection error.`) });
      hostPeers.set(seat, peer);
      if (coordinatorRef.current?.peers.has(seat)) coordinatorRef.current.replacePeer(seat, peer);
      else coordinatorRef.current?.addPeer(seat, peer);
      const offer = await peer.createOffer();
      setOutput(`Fresh host invite for ${['Red', 'Blue', 'Green'][seat]}`, encode({ v: 1, type: 'offer', matchId: config.matchId, hostSeat: config.hostSeat, seat, score: state.winScore, offer }));
      setStatus(`Fresh invite ready for ${['Red', 'Blue', 'Green'][seat]}. Ask the same player to prepare an answer and return it here.`);
      return true;
    } catch (error) {
      hostPeers.delete(seat);
      setStatus(`Could not recreate the connection: ${error.message}`);
      return false;
    }
  }
  document.querySelectorAll('.seat-mode').forEach(select => select.addEventListener('change', refreshInviteSeats));
  refreshInviteSeats();
  document.getElementById('host-create-btn').addEventListener('click', async () => {
    const reuse = role === 'host' && state.multiplayer;
    if (!reuse) closeSessions();
    role = 'host'; confirmed = true;
    const hostSeat = state.humanColorIndex;
    const openSeats = [...document.querySelectorAll('.seat-mode')].filter(select => select.value === 'guest').map(select => Number(select.dataset.seat)).filter(seat => seat !== hostSeat);
    const cpuSeats = [0, 1, 2].filter(seat => seat !== hostSeat && !openSeats.includes(seat));
    roster = [0, 1, 2].map(seat => ({ seat, controller: seat === hostSeat ? 'host' : openSeats.includes(seat) ? 'guest' : 'cpu' }));
    const matchId = reuse ? state.multiplayer.matchId : crypto.randomUUID();
    state.multiplayer = { role, hostSeat, roster, matchId, peers: hostPeers };
    state.multiplayer.retryGuest = retryGuest;
    document.getElementById('lobby-start-match').onclick = () => {
      if (openSeats.some(openSeat => !hostPeers.has(openSeat))) return setStatus('Create an invite for each open guest seat, or change that seat to CPU.');
      const notConnected = openSeats.filter(openSeat => hostPeers.get(openSeat)?.channel?.readyState !== 'open');
      if (notConnected.length) return setStatus(`Waiting for ${notConnected.map(seat => ['Red', 'Blue', 'Green'][seat]).join(' and ')} to connect. Ask them to prepare the invite and return their answer code first.`);
      onStartMatch(state.multiplayer);
    };
    const seat = Number(document.getElementById('invite-seat').value);
    if (!document.getElementById('invite-seat').value) { setStatus('All seats are ready as host/CPU. Start the match when ready.'); return; }
    if (!openSeats.includes(seat) || hostPeers.has(seat)) { setStatus('That seat already has an invite. Choose another open seat.'); return; }
    try {
      const peer = new WebRtcPeer({ role: 'host', matchId, localSeat: hostSeat, remoteSeat: seat, onState: value => setStatus(`Seat ${seat + 1}: ${value}`), onError: () => setStatus(`Seat ${seat + 1}: connection error.`) });
      hostPeers.set(seat, peer);
      const offer = await peer.createOffer();
      setOutput(`Host invite for ${['Red', 'Blue', 'Green'][seat]}`, encode({ v: 1, type: 'offer', matchId, hostSeat, seat, score: state.winScore, offer }));
      setStatus(`Offer ready for ${['Red', 'Blue', 'Green'][seat]}. Share it only with the intended player.`);
    } catch (error) { setStatus(`Could not create invite: ${error.message}`); }
    document.getElementById('host-answer-btn').onclick = async () => {
      const data = decode(document.getElementById('host-answer').value.trim(), 'answer');
      const target = data && hostPeers.get(data.seat);
      if (!data || !target || data.matchId !== matchId) return setStatus('That answer code is invalid, expired, or for another seat.');
      try { await target.acceptAnswer(data.answer); setStatus(`Seat ${data.seat + 1}: connecting. The guest will synchronize from the host before acting.`); }
      catch { setStatus('Could not apply answer. Create a fresh invite and try again.'); }
    };
  });

  document.getElementById('guest-prepare-btn').addEventListener('click', async () => {
    closeSessions(); role = 'guest'; confirmed = false;
    const data = decode(document.getElementById('guest-offer').value.trim(), 'offer');
    if (!data || ![0, 1, 2].includes(data.seat) || ![0, 1, 2].includes(data.hostSeat) || data.seat === data.hostSeat || !importSignalingCode(exportSignalingCode(data.offer), 'offer')) return setStatus('Invalid or unsupported host invite code.');
    try {
      guestPeer = new WebRtcPeer({ role: 'guest', matchId: data.matchId, localSeat: data.seat, remoteSeat: data.hostSeat, onState: value => setStatus(`Connection: ${value}`), onError: () => setStatus('Connection error.') });
      const answer = await guestPeer.acceptOffer(data.offer);
      state.multiplayer = { role, hostSeat: data.hostSeat, localSeat: data.seat, matchId: data.matchId, winScore: data.score, peer: guestPeer };
      setOutput(`You are joining as ${['Red', 'Blue', 'Green'][data.seat]}`, encode({ v: 1, type: 'answer', matchId: data.matchId, seat: data.seat, answer }));
      document.getElementById('guest-seat-confirm').textContent = `Confirm ${['Red', 'Blue', 'Green'][data.seat]} seat`;
      document.getElementById('guest-seat-confirm').onclick = () => { confirmed = true; setStatus('Seat confirmed. Return the answer code to the host and wait for the match to start.'); };
      document.getElementById('guest-join-btn').onclick = () => confirmed ? onStartMatch(state.multiplayer) : setStatus('Confirm your assigned seat first.');
      document.getElementById('guest-seat-confirm').hidden = false;
      document.getElementById('guest-join-btn').hidden = false;
      setStatus(`Host assigned you the ${['Red', 'Blue', 'Green'][data.seat]} seat. Check before confirming.`);
    } catch (error) { setStatus(`Could not prepare guest connection: ${error.message}`); }
  });
  document.getElementById('lobby-copy-btn').addEventListener('click', async () => { try { await navigator.clipboard.writeText(output.value); setStatus('Connection code copied.'); } catch { setStatus('Select and copy the connection code.'); } });
  document.getElementById('lobby-start-match').hidden = false;
  document.getElementById('guest-seat-confirm').hidden = true;
  document.getElementById('guest-join-btn').hidden = true;
  return { open, close: closeSessions, retryGuest };
}
