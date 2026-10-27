const SIGNAL_TIMEOUT_MS = 30_000;
const INVITE_WAIT_MS = 9 * 60 * 1000;

export function defaultSignalingUrl() {
  if (globalThis.MANA_SURGE_SIGNALING_URL) return globalThis.MANA_SURGE_SIGNALING_URL;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return local ? `${scheme}//${location.hostname}:8787/signal` : `${scheme}//${location.host}/signal`;
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); reject(new Error('Signaling service timed out')); }, SIGNAL_TIMEOUT_MS);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(socket); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not reach signaling service')); }, { once: true });
  });
}

function receive(socket, expected, onMessage = () => {}, timeoutMs = SIGNAL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Signaling service timed out')), timeoutMs);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.removeEventListener('message', handleMessage);
      socket.removeEventListener('close', handleClose);
      error ? reject(error) : resolve(value);
    };
    const handleMessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return finish(new Error('Signaling service sent invalid data')); }
      onMessage(message);
      if (message.type === 'error') return finish(new Error(signalingError(message.code)));
      if (expected.includes(message.type)) finish(null, message);
    };
    const handleClose = () => finish(new Error('Signaling connection closed'));
    socket.addEventListener('message', handleMessage);
    socket.addEventListener('close', handleClose, { once: true });
  });
}

function signalingError(code) {
  return ({ ROOM_FULL: 'That invite has already been used.', ROOM_EXPIRED: 'That invite is invalid or expired.', INVALID_MESSAGE: 'The signaling service rejected the connection.' })[code] || 'Signaling failed.';
}

export async function createSignalingInvite({ url = defaultSignalingUrl(), matchId, hostSeat, seat, score, offer, onStatus = () => {} }) {
  const socket = await openSocket(url);
  socket.send(JSON.stringify({ type: 'create', matchId, hostSeat, seat, score, offer }));
  let created;
  try { created = await receive(socket, ['created'], message => { if (message.type === 'guestJoined') onStatus('Guest found. Connecting directly…'); }); }
  catch (error) { socket.close(); throw error; }
  let answerPromise = receive(socket, ['answer'], message => { if (message.type === 'guestJoined') onStatus('Guest found. Connecting directly…'); }, INVITE_WAIT_MS);
  return {
    code: created.code,
    waitForAnswer: async () => {
      const message = await answerPromise;
      socket.close();
      return { seat: message.seat, answer: message.answer };
    },
    close: () => { answerPromise = Promise.reject(new Error('Invite cancelled')); answerPromise.catch(() => {}); socket.close(); }
  };
}

export async function joinSignalingInvite(code, { url = defaultSignalingUrl() } = {}) {
  const socket = await openSocket(url);
  socket.send(JSON.stringify({ type: 'join', code: String(code || '').trim() }));
  let message;
  try { message = await receive(socket, ['offer']); }
  catch (error) { socket.close(); throw error; }
  return {
    ...message,
    submitAnswer: answer => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ type: 'answer', code: String(code || '').trim(), answer }));
      socket.close();
      return true;
    },
    close: () => socket.close()
  };
}
