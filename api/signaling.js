const crypto = require('node:crypto');

const ROOM_TTL_SECONDS = 10 * 60;
const MAX_SIGNAL_BYTES = 64 * 1024;

function send(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function validDescription(value, type) {
  return value && value.type === type && typeof value.sdp === 'string' && value.sdp.length > 0 && value.sdp.length <= 48 * 1024;
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

function parseBody(req) {
  const body = req.body;
  if (typeof body === 'string') return JSON.parse(body);
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8'));
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
  if (req.method !== 'POST') return send(res, 405, { code: 'INVALID_MESSAGE' });

  try {
    // Clients send text/plain (no CORS preflight); older clients send application/json.
    let message;
    try { message = parseBody(req); } catch { return send(res, 400, { code: 'INVALID_MESSAGE' }); }
    if (!message || typeof message !== 'object' || Buffer.byteLength(JSON.stringify(message)) > MAX_SIGNAL_BYTES) {
      return send(res, 400, { code: 'INVALID_MESSAGE' });
    }

    if (message.action === 'create') {
      if (!exactKeys(message, ['action', 'matchId', 'hostSeat', 'seat', 'score', 'offer']) ||
        typeof message.matchId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(message.matchId) ||
        !Number.isInteger(message.seat) || message.seat < 0 || message.seat > 2 ||
        !Number.isInteger(message.hostSeat) || message.hostSeat < 0 || message.hostSeat > 2 || message.seat === message.hostSeat ||
        !Number.isSafeInteger(message.score) || message.score < 1 || message.score > 100 ||
        !validDescription(message.offer, 'offer')) return send(res, 400, { code: 'INVALID_MESSAGE' });

      let code;
      let stored;
      do {
        code = crypto.randomBytes(8).toString('base64url');
        stored = await redis(['SET', roomKey(code), JSON.stringify({ matchId: message.matchId, hostSeat: message.hostSeat,
          seat: message.seat, score: message.score, offer: message.offer }), 'EX', ROOM_TTL_SECONDS, 'NX']);
      } while (stored !== 'OK');
      return send(res, 200, { code });
    }

    if (message.action === 'join') {
      if (!exactKeys(message, ['action', 'code']) || typeof message.code !== 'string' || !/^[A-Za-z0-9_-]{10,16}$/.test(message.code)) {
        return send(res, 400, { code: 'INVALID_MESSAGE' });
      }
      const roomValue = await redis(['GET', roomKey(message.code)]);
      if (!roomValue) return send(res, 404, { code: 'ROOM_EXPIRED' });
      const claimed = await redis(['SET', guestKey(message.code), '1', 'EX', ROOM_TTL_SECONDS, 'NX']);
      if (claimed !== 'OK') return send(res, 409, { code: 'ROOM_FULL' });
      return send(res, 200, { ...JSON.parse(roomValue), type: 'offer' });
    }

    if (message.action === 'status') {
      if (!exactKeys(message, ['action', 'code']) || typeof message.code !== 'string' || !/^[A-Za-z0-9_-]{10,16}$/.test(message.code)) {
        return send(res, 400, { code: 'INVALID_MESSAGE' });
      }
      // One command per poll (this endpoint is polled for minutes per invite).
      const [roomValue, guest, answerValue] = await redis(['MGET', roomKey(message.code), guestKey(message.code), answerKey(message.code)]);
      if (!roomValue) return send(res, 404, { code: 'ROOM_EXPIRED' });
      if (!answerValue) return send(res, 200, { guestJoined: Boolean(guest) });
      await redis(['DEL', roomKey(message.code), guestKey(message.code), answerKey(message.code)]);
      const room = JSON.parse(roomValue);
      return send(res, 200, { guestJoined: true, seat: room.seat, answer: JSON.parse(answerValue) });
    }

    if (message.action === 'answer') {
      if (!exactKeys(message, ['action', 'code', 'answer']) || typeof message.code !== 'string' ||
        !/^[A-Za-z0-9_-]{10,16}$/.test(message.code) || !validDescription(message.answer, 'answer')) {
        return send(res, 400, { code: 'INVALID_MESSAGE' });
      }
      const [roomValue, guest] = await redis(['MGET', roomKey(message.code), guestKey(message.code)]);
      if (!roomValue) return send(res, 404, { code: 'ROOM_EXPIRED' });
      if (!guest) return send(res, 409, { code: 'INVALID_MESSAGE' });
      await redis(['SET', answerKey(message.code), JSON.stringify(message.answer), 'EX', ROOM_TTL_SECONDS, 'NX']);
      return send(res, 200, { ok: true });
    }

    if (message.action === 'close') {
      if (!exactKeys(message, ['action', 'code']) || typeof message.code !== 'string' || !/^[A-Za-z0-9_-]{10,16}$/.test(message.code)) {
        return send(res, 400, { code: 'INVALID_MESSAGE' });
      }
      await redis(['DEL', roomKey(message.code), guestKey(message.code), answerKey(message.code)]);
      return send(res, 200, { ok: true });
    }

    return send(res, 400, { code: 'INVALID_MESSAGE' });
  } catch (error) {
    console.error('Signaling request failed:', error.message);
    return send(res, 503, { code: 'SIGNALING_UNAVAILABLE' });
  }
};
