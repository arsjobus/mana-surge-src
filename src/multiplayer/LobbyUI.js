import { WebRtcPeer } from './WebRtcPeer.js';
import { createSignalingInvite, joinSignalingInvite } from './SignalingClient.js';

const INVITE_PREFIX = 'mana-join-';
const SEAT_NAMES = ['Red', 'Blue', 'Green'];
const START_LABEL = 'Start match';
/** How long "Start match" waits for a guest who has joined but is still connecting. */
const START_WAIT_MS = 20_000;
const SEAT_STATE_TEXT = {
  inviting: 'Creating invite…',
  invited: 'Invite ready, waiting for the guest to join',
  joined: 'Guest joined, connecting directly…',
  connecting: 'Connecting directly…',
  connected: 'Connected',
  failed: 'Connection failed',
  expired: 'Invite expired'
};

const seatName = seat => SEAT_NAMES[seat] ?? `Seat ${seat + 1}`;
const nameList = seats => seats.map(seatName).join(' and ');

/** Start a private match through the configured short-lived signaling relay. */
export function setupMultiplayerLobby({ state, onStartMatch = () => {} }) {
  const $ = id => document.getElementById(id);
  const modal = $('multiplayer-modal');
  const status = $('lobby-status');
  const result = $('lobby-code-result');
  const output = $('lobby-code-output');
  const seatList = $('lobby-seats');
  const startButton = $('lobby-start-match');
  const startCpuButton = $('lobby-start-cpu');
  const createButton = $('host-create-btn');
  const hostPeers = new Map();
  const inviteSessions = new Map();
  const seatInfo = new Map();
  let guestPeer = null;
  let guestSignal = null;
  let guestConnected = false;
  let guestFailure = '';
  let guestSeatConfirmed = false;
  let guestMatchStarted = false;
  let guestStartTriggered = false;
  let operation = 0;
  let role = null;
  let starting = false;

  const setStatus = message => { status.textContent = message; };
  const setOutput = (title, value) => {
    result.hidden = false;
    $('lobby-code-title').textContent = title;
    output.value = value;
    output.focus(); output.select();
  };
  const matchInProgress = () => !!state.multiplayerCoordinator && !state.multiplayerCoordinator.closed;
  const modeOf = seat => document.querySelector(`.seat-mode[data-seat="${seat}"]`)?.value;
  const guestSeatsFromUI = () => [0, 1, 2].filter(seat => seat !== state.humanColorIndex && modeOf(seat) === 'guest');

  /* ---- Per-seat status list (host) ---- */
  function renderSeats() {
    if (!seatList) return;
    seatList.replaceChildren();
    for (const [seat, info] of [...seatInfo].sort((a, b) => a[0] - b[0])) {
      const item = document.createElement('li');
      item.className = `lobby-seat lobby-seat-${info.state}`;
      const name = document.createElement('b');
      name.textContent = seatName(seat);
      const text = document.createElement('span');
      text.textContent = info.detail ? `${SEAT_STATE_TEXT[info.state]}: ${info.detail}` : SEAT_STATE_TEXT[info.state];
      item.append(name, text);
      if (info.state === 'failed' || info.state === 'expired') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'game-btn';
        retry.textContent = 'New invite';
        retry.addEventListener('click', () => { retryGuest(seat); });
        item.append(retry);
      }
      seatList.append(item);
    }
    seatList.hidden = seatInfo.size === 0;
  }
  function updateStartControls() {
    if (!startCpuButton) return;
    const missing = guestSeatsFromUI().filter(seat => !hostPeers.get(seat)?.isOpen);
    startCpuButton.hidden = role === 'guest' || missing.length === 0;
    if (missing.length) startCpuButton.textContent = `Start with CPU for ${nameList(missing)}`;
  }
  function setSeat(seat, stateName, detail = '') {
    seatInfo.set(seat, { state: stateName, detail });
    renderSeats();
    updateStartControls();
  }
  function closeSeatTransport(seat) {
    inviteSessions.get(seat)?.close();
    inviteSessions.delete(seat);
    hostPeers.get(seat)?.close();
    hostPeers.delete(seat);
  }
  function dropSeat(seat) {
    closeSeatTransport(seat);
    seatInfo.delete(seat);
    renderSeats();
    updateStartControls();
  }
  function setStartBusy(busy) {
    startButton.disabled = busy;
    if (startCpuButton) startCpuButton.disabled = busy;
    startButton.textContent = busy ? 'Waiting for guests…' : START_LABEL;
  }

  const startConfirmedGuest = () => {
    if (role !== 'guest' || guestStartTriggered || !guestSeatConfirmed || !guestMatchStarted || !state.multiplayer || !guestPeer) return;
    guestStartTriggered = true;
    $('guest-join-btn').hidden = true;
    onStartMatch(state.multiplayer);
  };
  const closeSessions = () => {
    operation++;
    for (const invite of inviteSessions.values()) invite.close();
    inviteSessions.clear();
    for (const peer of hostPeers.values()) peer.close();
    hostPeers.clear();
    seatInfo.clear();
    renderSeats();
    guestSignal?.close(); guestSignal = null;
    guestPeer?.close(); guestPeer = null;
    guestConnected = false;
    guestFailure = '';
    updateStartControls();
  };
  const open = () => { modal.style.display = 'flex'; setStatus('Choose host or guest to begin.'); };
  $('lobby-close').addEventListener('click', () => { closeSessions(); modal.style.display = 'none'; });
  $('lobby-cancel').addEventListener('click', () => {
    closeSessions();
    role = null;
    result.hidden = true;
    $('lobby-seat-confirm').hidden = true;
    $('guest-join-btn').hidden = true;
    setStatus('Lobby cancelled.');
  });

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
    const chooser = $('invite-seat');
    const previous = chooser.value;
    const openSeats = guestSeatsFromUI();
    chooser.innerHTML = openSeats.map(seat => `<option value="${seat}">${seatName(seat)}</option>`).join('');
    if (openSeats.includes(Number(previous))) chooser.value = previous;
    chooser.disabled = !openSeats.length;
    // A seat that is no longer open to a guest must not keep a live invite.
    if (!matchInProgress()) for (const seat of [...hostPeers.keys()]) if (!openSeats.includes(seat)) dropSeat(seat);
    updateStartControls();
  }
  document.querySelectorAll('.seat-mode').forEach(select => select.addEventListener('change', refreshInviteSeats));
  refreshInviteSeats();

  /** Rebuild the host config from the current lobby controls, keeping the match id. */
  function syncHostConfig() {
    const hostSeat = state.humanColorIndex;
    const guestSeats = guestSeatsFromUI();
    const roster = [0, 1, 2].map(seat => ({ seat, controller: seat === hostSeat ? 'host' : guestSeats.includes(seat) ? 'guest' : 'cpu' }));
    const previous = role === 'host' ? state.multiplayer : null;
    const config = state.multiplayer = { role: 'host', hostSeat, roster, matchId: previous?.matchId ?? crypto.randomUUID(), peers: hostPeers };
    config.retryGuest = retryGuest;
    config.reopenLobby = open;
    return config;
  }

  async function createInvite(seat, config, attempt = operation) {
    const existing = hostPeers.get(seat);
    if (existing?.isOpen) throw new Error(`${seatName(seat)} is already connected.`);
    // A stale invite (failed, expired or abandoned) is replaced rather than blocking the seat.
    if (existing) closeSeatTransport(seat);
    setSeat(seat, 'inviting');
    const peer = new WebRtcPeer({ role: 'host', matchId: config.matchId, localSeat: config.hostSeat, remoteSeat: seat });
    hostPeers.set(seat, peer);
    peer.addStateListener((value, detail) => {
      if (hostPeers.get(seat) !== peer || peer.closed) return;
      if (value === 'connected' || value === 'recovered') {
        setSeat(seat, 'connected');
        setStatus(`${seatName(seat)} connected directly.`);
      } else if (value === 'disconnected' && seatInfo.get(seat)?.state === 'connected') {
        setSeat(seat, 'connecting', 'connection interrupted, retrying…');
      } else if (value === 'failed' || value === 'closed') {
        const reason = detail || peer.failureReason || 'The connection closed.';
        setSeat(seat, 'failed', reason);
        setStatus(`${seatName(seat)}: ${reason}`);
      }
    });
    const coordinator = state.multiplayerCoordinator;
    if (coordinator) {
      if (coordinator.peers.has(seat)) coordinator.replacePeer(seat, peer);
      else coordinator.addPeer(seat, peer);
    }
    try {
      const offer = await peer.createOffer();
      if (attempt !== operation || hostPeers.get(seat) !== peer) { peer.close(); return; }
      const invite = await createSignalingInvite({ matchId: config.matchId, hostSeat: config.hostSeat, seat,
        score: state.winScore, offer, onStatus: setStatus,
        onGuestJoined: () => { if (hostPeers.get(seat) === peer && seatInfo.get(seat)?.state === 'invited') setSeat(seat, 'joined'); } });
      if (attempt !== operation || hostPeers.get(seat) !== peer) { invite.close(); peer.close(); return; }
      inviteSessions.set(seat, invite);
      setSeat(seat, 'invited');
      setOutput(`Invite for ${seatName(seat)}`, `${INVITE_PREFIX}${invite.code}`);
      setStatus(`Invite ready for ${seatName(seat)}. Send it to the intended player.`);
      invite.waitForAnswer().then(({ seat: answerSeat, answer }) => {
        if (answerSeat !== seat || hostPeers.get(seat) !== peer) return;
        setSeat(seat, 'connecting');
        setStatus(`${seatName(seat)}: connecting directly…`);
        return peer.acceptAnswer(answer);
      }).catch(error => {
        if (hostPeers.get(seat) !== peer || peer.closed) return;
        setSeat(seat, error.code === 'ROOM_EXPIRED' ? 'expired' : 'failed', error.code === 'ROOM_EXPIRED' ? '' : error.message);
        setStatus(`${seatName(seat)}: ${error.message}`);
      }).finally(() => { if (inviteSessions.get(seat) === invite) inviteSessions.delete(seat); });
    } catch (error) {
      if (hostPeers.get(seat) === peer) hostPeers.delete(seat);
      peer.close();
      if (attempt === operation) setSeat(seat, 'failed', error.message);
      throw error;
    }
  }

  async function retryGuest(seat) {
    if (role !== 'host' || !Number.isInteger(seat)) return false;
    const config = matchInProgress() ? state.multiplayer : syncHostConfig();
    if (!config || config.roster?.[seat]?.controller !== 'guest') return false;
    closeSeatTransport(seat);
    try {
      await createInvite(seat, config);
      setStatus(`Fresh invite ready for ${seatName(seat)}.`);
      return true;
    } catch (error) { setStatus(`Could not recreate the connection: ${error.message}`); return false; }
  }

  function describeNotReady(seats) {
    return seats.map(seat => {
      const info = seatInfo.get(seat);
      switch (info?.state) {
        case 'invited': return `${seatName(seat)} has not joined yet. Send them the invite code.`;
        case 'inviting': return `${seatName(seat)}'s invite is still being created.`;
        case 'joined': case 'connecting': return `${seatName(seat)} is still connecting.`;
        case 'failed': return `${seatName(seat)}'s connection failed.${info.detail ? ` ${info.detail}` : ''}`;
        case 'expired': return `${seatName(seat)}'s invite expired.`;
        default: return `${seatName(seat)} has no invite yet.`;
      }
    }).join(' ');
  }

  /**
   * Start the match once every guest seat has an open data channel. A guest who
   * has joined but is still connecting is waited for; anyone still missing can
   * be replaced by a CPU (`cpuFill`) instead of leaving the host stuck.
   */
  async function startMatch({ cpuFill = false } = {}) {
    if (starting) return;
    if (role === 'guest' && guestPeer) return setStatus('You joined a match as a guest. Cancel the lobby first if you want to host instead.');
    role = 'host';
    const config = syncHostConfig();
    const guestSeats = config.roster.filter(entry => entry.controller === 'guest').map(entry => entry.seat);
    const uninvited = guestSeats.filter(seat => !hostPeers.has(seat));
    if (uninvited.length && !cpuFill) {
      updateStartControls();
      return setStatus(`Create an invite for ${nameList(uninvited)}, or set ${uninvited.length > 1 ? 'those seats' : 'that seat'} to CPU.`);
    }
    const attempt = operation;
    starting = true;
    setStartBusy(true);
    try {
      const connecting = guestSeats.filter(seat => ['joined', 'connecting'].includes(seatInfo.get(seat)?.state) && hostPeers.has(seat) && !hostPeers.get(seat).isOpen);
      if (connecting.length) {
        setStatus(`Waiting for ${nameList(connecting)} to finish connecting…`);
        await Promise.all(connecting.map(seat => hostPeers.get(seat).waitForOpen(START_WAIT_MS).catch(() => {})));
        if (attempt !== operation) return;
      }
      const notReady = guestSeats.filter(seat => !hostPeers.get(seat)?.isOpen);
      if (notReady.length && !cpuFill) {
        setStatus(`Can't start yet. ${describeNotReady(notReady)} You can wait, send a fresh invite, or start with CPU for the missing seat${notReady.length > 1 ? 's' : ''}.`);
        return;
      }
      for (const seat of notReady) {
        config.roster[seat].controller = 'cpu';
        dropSeat(seat);
        const select = document.querySelector(`.seat-mode[data-seat="${seat}"]`);
        if (select) select.value = 'cpu';
      }
      if (notReady.length) refreshInviteSeats();
      onStartMatch(config);
    } finally {
      starting = false;
      setStartBusy(false);
      updateStartControls();
    }
  }
  startButton.addEventListener('click', () => { startMatch(); });
  startCpuButton?.addEventListener('click', () => { startMatch({ cpuFill: true }); });

  createButton.addEventListener('click', async () => {
    if (role !== 'host') closeSessions();
    if (role === 'guest' || role === null) role = 'host';
    const config = syncHostConfig();
    const chooser = $('invite-seat');
    if (!chooser.value) return setStatus('All seats are ready as host/CPU. Start the match when ready.');
    const seat = Number(chooser.value);
    if (!guestSeatsFromUI().includes(seat)) return setStatus('Choose an open guest seat.');
    createButton.disabled = true;
    try { await createInvite(seat, config, operation); }
    catch (error) { setStatus(`Could not create invite: ${error.message}`); }
    finally { createButton.disabled = false; }
  });

  /* ---- Guest ---- */
  function updateGuestStatus() {
    if (role !== 'guest' || !guestPeer || !state.multiplayer) return;
    const name = seatName(state.multiplayer.localSeat);
    if (guestFailure) return setStatus(`Could not connect to the host. ${guestFailure} Ask the host for a new invite and join again.`);
    if (!guestConnected) return setStatus(guestSeatConfirmed ? `${name} seat confirmed. Still connecting to the host…` : `Joined the invite for ${name}. Connecting directly to the host…`);
    setStatus(guestSeatConfirmed ? 'Seat confirmed. The match will start automatically when the host starts.' : `Connected to the host. Confirm your ${name} seat.`);
  }

  $('guest-prepare-btn').addEventListener('click', async () => {
    const attempt = ++operation;
    guestSignal?.close(); guestSignal = null;
    guestPeer?.close(); guestPeer = null;
    guestConnected = false;
    guestFailure = '';
    role = 'guest';
    updateStartControls();
    try {
      const code = $('guest-offer').value.trim().replace(/^mana-join-/, '');
      if (!/^[A-Za-z0-9_-]{10,16}$/.test(code)) throw new Error('Enter a valid invite code.');
      const signal = await joinSignalingInvite(code);
      if (attempt !== operation) { signal.close(); return; }
      guestSignal = signal;
      const { offer, matchId, seat, hostSeat, score } = guestSignal;
      if (![0, 1, 2].includes(seat) || ![0, 1, 2].includes(hostSeat) || seat === hostSeat) throw new Error('Invalid invite seat.');
      const peer = guestPeer = new WebRtcPeer({ role: 'guest', matchId, localSeat: seat, remoteSeat: hostSeat });
      state.multiplayer = { role, hostSeat, localSeat: seat, matchId, winScore: score, peer };
      guestSeatConfirmed = false;
      guestMatchStarted = false;
      guestStartTriggered = false;
      // Listen before the answer is sent so neither the channel opening nor the
      // host's start message can be missed.
      peer.onMessage = message => {
        if (message.type !== 'matchStarted') return;
        guestMatchStarted = true;
        startConfirmedGuest();
      };
      peer.addStateListener((value, detail) => {
        if (guestPeer !== peer) return;
        if (value === 'connected' || value === 'recovered') { guestConnected = true; guestFailure = ''; }
        else if (value === 'failed' || (value === 'closed' && !peer.closed)) {
          guestConnected = false;
          guestFailure = detail || peer.failureReason || 'The connection closed.';
          if (!guestStartTriggered) $('lobby-seat-confirm').hidden = true;
        } else if (value === 'disconnected') guestConnected = false;
        if (!guestStartTriggered) updateGuestStatus();
      });
      const answer = await peer.acceptOffer(offer);
      if (attempt !== operation) { guestSignal?.close(); peer.close(); return; }
      if (!await guestSignal.submitAnswer(answer)) throw new Error('Could not return the connection answer.');
      setOutput(`You are joining as ${seatName(seat)}`, `Seat: ${seatName(seat)}`);
      $('lobby-seat-confirm').textContent = `Confirm ${seatName(seat)} seat`;
      $('lobby-seat-confirm').hidden = !!guestFailure;
      $('guest-join-btn').hidden = true;
      $('lobby-seat-confirm').onclick = () => {
        guestSeatConfirmed = true;
        updateGuestStatus();
        startConfirmedGuest();
      };
      updateGuestStatus();
    } catch (error) {
      if (attempt === operation) {
        guestSignal?.close(); guestSignal = null;
        guestPeer?.close(); guestPeer = null;
        $('lobby-seat-confirm').hidden = true;
      }
      setStatus(error.message);
    }
  });

  $('lobby-copy-btn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(output.value); setStatus('Invite copied.'); }
    catch { setStatus('Select and copy the invite.'); }
  });
  startButton.hidden = false;
  $('lobby-seat-confirm').hidden = true;
  $('guest-join-btn').hidden = true;
  $('guest-join-btn').disabled = false;
  if (startCpuButton) startCpuButton.hidden = true;
  renderSeats();
  return { open, close: closeSessions, retryGuest };
}
