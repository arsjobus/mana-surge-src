const SIGNAL_TIMEOUT_MS = 30_000;
const INVITE_WAIT_MS = 9 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
// The host waits for the guest's answer by polling the relay, and every poll is a
// serverless invocation. Poll slowly while nobody has joined (a person has to
// receive, paste and confirm the invite first) and quickly only once a guest
// has joined, when the answer is seconds away.
const POLL_WAITING_MS = [[30_000, 2_000], [120_000, 4_000], [Infinity, 8_000]];
const POLL_JOINED_MS = 1_000;
const POLL_ERROR_BASE_MS = 1_000;
const MAX_POLL_FAILURES = 6;
const RETRY_BASE_MS = 400;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** `transient` errors (network blips, 5xx) are safe to retry; the rest are final. */
class SignalingError extends Error {
  constructor(message, { code = null, transient = false, reason = '', status = 0 } = {}) {
    super(message);
    this.name = 'SignalingError';
    this.code = code;
    this.transient = transient;
    this.reason = reason;
    this.status = status;
  }
}

export function defaultSignalingUrl() {
  if (globalThis.MANA_SURGE_SIGNALING_URL) return globalThis.MANA_SURGE_SIGNALING_URL;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!local) return `${location.origin}/api/signaling`;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.hostname}:8787/signal`;
}

function isHttpSignalingUrl(url) {
  return /^https?:/.test(url);
}

async function signalingRequestOnce(url, data) {
  // JSON.stringify silently drops `undefined` fields, which the relay would then
  // reject as a bare 400. Catch that here, where the culprit is still known.
  const missing = Object.keys(data).filter(key => data[key] === undefined);
  if (missing.length) {
    throw new SignalingError(`${signalingError('INVALID_MESSAGE')} (missing ${missing.join(', ')})`, { code: 'INVALID_MESSAGE' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        // A "simple" content type avoids a CORS preflight, which would otherwise
        // double the invocation count when the game is hosted on another origin.
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(data),
        signal: controller.signal
      });
    } catch {
      throw new SignalingError('Could not reach the signaling service.', { code: 'NETWORK', transient: true });
    }
    const retryable = response.status >= 500 || response.status === 429;
    let result;
    try { result = await response.json(); }
    catch { throw new SignalingError('Signaling service sent invalid data.', { code: 'BAD_RESPONSE', transient: retryable }); }
    if (!response.ok) {
      const reason = typeof result?.reason === 'string' ? result.reason : '';
      console.warn(`Signaling "${data.action}" failed: HTTP ${response.status} ${result?.code ?? ''}${reason ? ` - ${reason}` : ''}`);
      // NOT_JOINED: the guest's join claim is not readable yet (storage replica lag).
      throw new SignalingError(signalingError(result?.code, reason), { code: result?.code ?? null, reason, status: response.status,
        transient: retryable || result?.code === 'NOT_JOINED' });
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** POST to the HTTP relay, retrying transient failures. Only retry idempotent requests. */
async function signalingRequest(url, data, { retries = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await signalingRequestOnce(url, data); }
    catch (error) {
      if (!error.transient || attempt >= retries) throw error;
      await delay(RETRY_BASE_MS * 2 ** attempt);
    }
  }
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

function signalingError(code, reason = '') {
  const base = ({ ROOM_FULL: 'That invite has already been used.', ROOM_EXPIRED: 'That invite is invalid or expired.', INVALID_MESSAGE: 'The signaling service rejected the connection.',
    NOT_JOINED: 'The invite has not been claimed yet.', SIGNALING_UNAVAILABLE: 'The signaling service is temporarily unavailable.' })[code] || 'Signaling failed.';
  return reason && code === 'INVALID_MESSAGE' ? `${base} (${reason})` : base;
}

export async function createSignalingInvite({ url = defaultSignalingUrl(), matchId, hostSeat, seat, score, offer, onStatus = () => {}, onGuestJoined = () => {} }) {
  let joinedReported = false;
  const reportJoined = () => {
    if (joinedReported) return;
    joinedReported = true;
    onStatus('Guest found. Connecting directly…');
    onGuestJoined();
  };
  if (isHttpSignalingUrl(url)) {
    const { code } = await signalingRequest(url, { action: 'create', matchId, hostSeat, seat, score, offer }, { retries: 1 });
    let closed = false;
    let timer;
    const answerPromise = new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const deadline = startedAt + INVITE_WAIT_MS;
      let failures = 0;
      let joined = false;
      const poll = async () => {
        if (closed) return reject(new Error('Invite cancelled'));
        if (Date.now() >= deadline) return reject(new SignalingError(signalingError('ROOM_EXPIRED'), { code: 'ROOM_EXPIRED' }));
        try {
          const result = await signalingRequest(url, { action: 'status', code });
          failures = 0;
          if (result.guestJoined) { joined = true; reportJoined(); }
          if (result.answer) return resolve(result);
        } catch (error) {
          // A single dropped request must not strand the host: keep polling
          // through transient errors and only give up on a persistent outage.
          if (!error.transient || ++failures > MAX_POLL_FAILURES) return reject(error);
        }
        if (closed) return reject(new Error('Invite cancelled'));
        const waiting = POLL_WAITING_MS.find(([until]) => Date.now() - startedAt < until)[1];
        timer = setTimeout(poll, failures ? Math.min(8_000, POLL_ERROR_BASE_MS * 2 ** failures) : joined ? POLL_JOINED_MS : waiting);
      };
      poll();
    });
    answerPromise.catch(() => {});
    return {
      code,
      waitForAnswer: async () => {
        const message = await answerPromise;
        closed = true;
        return { seat: message.seat, answer: message.answer };
      },
      close: () => {
        closed = true;
        clearTimeout(timer);
        signalingRequest(url, { action: 'close', code }).catch(() => {});
      }
    };
  }
  const socket = await openSocket(url);
  socket.send(JSON.stringify({ type: 'create', matchId, hostSeat, seat, score, offer }));
  const onSocketMessage = message => { if (message.type === 'guestJoined') reportJoined(); };
  let created;
  try { created = await receive(socket, ['created'], onSocketMessage); }
  catch (error) { socket.close(); throw error; }
  let answerPromise = receive(socket, ['answer'], onSocketMessage, INVITE_WAIT_MS);
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
  if (isHttpSignalingUrl(url)) {
    const message = await signalingRequest(url, { action: 'join', code: String(code || '').trim() });
    let submitted = false;
    return {
      ...message,
      submitAnswer: async answer => {
        if (submitted) return false;
        submitted = true;
        // Setting an answer is idempotent on the relay, so retry transient failures.
        await signalingRequest(url, { action: 'answer', code: String(code || '').trim(), answer }, { retries: 2 });
        return true;
      },
      close: () => {}
    };
  }
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
