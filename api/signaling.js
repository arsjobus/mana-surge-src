const crypto = require('node:crypto');

const ROOM_TTL_SECONDS = 10 * 60;
const MAX_SIGNAL_BYTES = 64 * 1024;
const MAX_SDP_CHARS = 48 * 1024;
const CODE_PATTERN = /^[A-Za-z0-9_-]{10,16}$/;
const MATCH_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Every rejection carries a machine-readable `code` (the client maps it to a
 * message) and a human-readable `reason` naming the exact check that failed, so a
 * 400 in the network tab or the lobby says *what* was wrong with the request.
 */
function send(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

function reject(res, status, code, reason) {
  return send(res, status, reason ? { code, reason } : { code });
}

function invalid(res, reason) {
  return reject(res, 400, 'INVALID_MESSAGE', reason);
}

/** Required fields must be present. Unknown extra fields are ignored, never stored. */
function missingFields(message, required) {
  const missing = required.filter(key => message[key] === undefined || message[key] === null);
  return missing.length ? `missing field(s): ${missing.join(', ')}` : null;
}

function descriptionProblem(value, type, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `${name} must be an object`;
  if (value.type !== type) return `${name}.type must be "${type}" (got ${JSON.stringify(value.type)})`;
  if (typeof value.sdp !== 'string' || value.sdp.length === 0) return `${name}.sdp must be a non-empty string`;
  if (value.sdp.length > MAX_SDP_CHARS) return `${name}.sdp is too large`;
  return null;
}

function seatProblem(value, name) {
  return Number.isInteger(value) && value >= 0 && value <= 2 ? null : `${name} must be 0, 1 or 2 (got ${JSON.stringify(value)})`;
}

function codeProblem(value) {
  return typeof value === 'string' && CODE_PATTERN.test(value) ? null : 'code must be 10-16 URL-safe characters';
}

function createProblem(message) {
  return missingFields(message, ['matchId', 'hostSeat', 'seat', 'score', 'offer']) ||
    (typeof message.matchId === 'string' && MATCH_ID_PATTERN.test(message.matchId) ? null : 'matchId must be 16-64 URL-safe characters') ||
    seatProblem(message.hostSeat, 'hostSeat') || seatProblem(message.seat, 'seat') ||
    (message.seat === message.hostSeat ? 'seat must differ from hostSeat' : null) ||
    (Number.isSafeInteger(message.score) && message.score >= 1 && message.score <= 100 ? null : `score must be an integer from 1 to 100 (got ${JSON.stringify(message.score)})`) ||
    descriptionProblem(message.offer, 'offer', 'offer');
}

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Signaling storage is not configured');
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command)
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error('Signaling storage request failed');
  return result.result;
}

/**
 * Accept the body however the platform delivered it: an already-parsed object
 * (application/json), a string (text/plain), a Buffer (unknown content type) or,
 * if no parser ran, the raw request stream.
 */
async function readBody(req) {
  let body = req.body;
  if ((body === undefined || body === null || body === '') && typeof req.on === 'function' && !req.readableEnded) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_SIGNAL_BYTES * 2) throw new RangeError('Request body is too large');
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') body = JSON.parse(body.replace(/^\uFEFF/, ''));
  return body;
}

function roomKey(code) { return `mana-surge:room:${code}`; }
function guestKey(code) { return `mana-surge:guest:${code}`; }
function answerKey(code) { return `mana-surge:answer:${code}`; }

module.exports = async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-max-age', '86400');
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/signaling') {
    return send(res, 200, { ok: true, service: 'mana-surge-signaling' });
  }
  if (req.method !== 'POST') return reject(res, 405, 'INVALID_MESSAGE', `${req.method} is not supported`);

  try {
    // Clients send text/plain (no CORS preflight); older clients send application/json.
    let message;
    try { message = await readBody(req); } catch { return invalid(res, 'body is not valid JSON'); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return invalid(res, 'body must be a JSON object');
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_SIGNAL_BYTES) return invalid(res, 'body is too large');

    if (message.action === 'create') {
      const problem = createProblem(message);
      if (problem) return invalid(res, problem);
      const room = JSON.stringify({ matchId: message.matchId, hostSeat: message.hostSeat,
        seat: message.seat, score: message.score, offer: { type: message.offer.type, sdp: message.offer.sdp } });
      let code;
      let stored;
      do {
        code = crypto.randomBytes(8).toString('base64url');
        stored = await redis(['SET', roomKey(code), room, 'EX', ROOM_TTL_SECONDS, 'NX']);
      } while (stored !== 'OK');
      return send(res, 200, { code });
    }

    if (message.action === 'join') {
      const problem = missingFields(message, ['code']) || codeProblem(message.code);
      if (problem) return invalid(res, problem);
      const roomValue = await redis(['GET', roomKey(message.code)]);
      if (!roomValue) return reject(res, 404, 'ROOM_EXPIRED');
      const claimed = await redis(['SET', guestKey(message.code), '1', 'EX', ROOM_TTL_SECONDS, 'NX']);
      if (claimed !== 'OK') return reject(res, 409, 'ROOM_FULL');
      return send(res, 200, { ...JSON.parse(roomValue), type: 'offer' });
    }

    if (message.action === 'status') {
      const problem = missingFields(message, ['code']) || codeProblem(message.code);
      if (problem) return invalid(res, problem);
      // One command per poll (this endpoint is polled for minutes per invite).
      const [roomValue, guest, answerValue] = await redis(['MGET', roomKey(message.code), guestKey(message.code), answerKey(message.code)]);
      if (!roomValue) return reject(res, 404, 'ROOM_EXPIRED');
      if (!answerValue) return send(res, 200, { guestJoined: Boolean(guest) });
      await redis(['DEL', roomKey(message.code), guestKey(message.code), answerKey(message.code)]);
      const room = JSON.parse(roomValue);
      return send(res, 200, { guestJoined: true, seat: room.seat, answer: JSON.parse(answerValue) });
    }

    if (message.action === 'answer') {
      const problem = missingFields(message, ['code', 'answer']) || codeProblem(message.code) ||
        descriptionProblem(message.answer, 'answer', 'answer');
      if (problem) return invalid(res, problem);
      const [roomValue, guest] = await redis(['MGET', roomKey(message.code), guestKey(message.code)]);
      if (!roomValue) return reject(res, 404, 'ROOM_EXPIRED');
      // Not a malformed request: the invite exists but the join claim is not visible yet.
      if (!guest) return reject(res, 409, 'NOT_JOINED', 'the invite has not been claimed by a guest');
      await redis(['SET', answerKey(message.code), JSON.stringify({ type: message.answer.type, sdp: message.answer.sdp }), 'EX', ROOM_TTL_SECONDS, 'NX']);
      return send(res, 200, { ok: true });
    }

    if (message.action === 'close') {
      const problem = missingFields(message, ['code']) || codeProblem(message.code);
      if (problem) return invalid(res, problem);
      await redis(['DEL', roomKey(message.code), guestKey(message.code), answerKey(message.code)]);
      return send(res, 200, { ok: true });
    }

    return invalid(res, `unknown action ${JSON.stringify(message.action)}`);
  } catch (error) {
    console.error('Signaling request failed:', error.message);
    return reject(res, 503, 'SIGNALING_UNAVAILABLE');
  }
};
