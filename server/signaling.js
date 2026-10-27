const crypto = require('node:crypto');
const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.SIGNALING_PORT || 8787);
const MAX_SIGNAL_BYTES = 64 * 1024;
const ROOM_TTL_MS = 10 * 60 * 1000;
const MAX_ROOMS = 1000;
const rooms = new Map();
const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, service: 'mana-surge-signaling' }));
    return;
  }
  response.writeHead(404);
  response.end();
});
const wss = new WebSocketServer({ server, path: '/signal', maxPayload: MAX_SIGNAL_BYTES });

function send(socket, value) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function removeRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.timer);
  rooms.delete(code);
  room.host?.rooms?.delete(code);
  room.guest?.rooms?.delete(code);
  if (room.host?.readyState === WebSocket.OPEN) send(room.host, { type: 'closed' });
  if (room.guest?.readyState === WebSocket.OPEN) send(room.guest, { type: 'closed' });
}

wss.on('connection', socket => {
  socket.on('message', raw => {
    let message;
    try {
      if (raw.byteLength > MAX_SIGNAL_BYTES) throw new Error('too large');
      message = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: 'error', code: 'INVALID_MESSAGE' });
      socket.close(1008);
      return;
    }

    if (message?.type === 'create') {
      if (!exactKeys(message, ['type', 'matchId', 'hostSeat', 'seat', 'score', 'offer']) || socket.role === 'guest' ||
        (socket.rooms?.size || 0) >= 2 || rooms.size >= MAX_ROOMS || typeof message.matchId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(message.matchId) ||
        !Number.isInteger(message.seat) || message.seat < 0 || message.seat > 2 ||
        !Number.isInteger(message.hostSeat) || message.hostSeat < 0 || message.hostSeat > 2 || message.seat === message.hostSeat ||
        !Number.isSafeInteger(message.score) || message.score < 1 || message.score > 100 ||
        !validDescription(message.offer, 'offer')) {
        send(socket, { type: 'error', code: 'INVALID_MESSAGE' });
        return;
      }
      let code;
      do { code = crypto.randomBytes(8).toString('base64url'); } while (rooms.has(code));
      const room = { code, host: socket, guest: null, matchId: message.matchId, seat: message.seat,
        hostSeat: message.hostSeat, score: message.score, offer: message.offer, timer: null };
      room.timer = setTimeout(() => removeRoom(code), ROOM_TTL_MS);
      room.timer.unref?.();
      rooms.set(code, room);
      socket.rooms ||= new Set();
      socket.rooms.add(code);
      socket.role = 'host';
      send(socket, { type: 'created', code });
      return;
    }

    const room = rooms.get(message?.code);
    if (message?.type === 'join') {
      if (!exactKeys(message, ['type', 'code']) || typeof message.code !== 'string' || !/^[A-Za-z0-9_-]{10,16}$/.test(message.code)) {
        send(socket, { type: 'error', code: 'INVALID_MESSAGE' });
        return;
      }
      if (!room || room.guest || socket.role || socket === room.host) {
        send(socket, { type: 'error', code: room ? 'ROOM_FULL' : 'ROOM_EXPIRED' });
        return;
      }
      room.guest = socket;
      socket.rooms = new Set([room.code]);
      socket.role = 'guest';
      send(socket, { type: 'offer', matchId: room.matchId, seat: room.seat, hostSeat: room.hostSeat,
        score: room.score, offer: room.offer });
      send(room.host, { type: 'guestJoined', seat: room.seat });
      return;
    }

    if (message?.type === 'answer' && exactKeys(message, ['type', 'code', 'answer']) && room?.guest === socket && validDescription(message.answer, 'answer')) {
      send(room.host, { type: 'answer', seat: room.seat, answer: message.answer });
      removeRoom(room.code);
      return;
    }
    send(socket, { type: 'error', code: 'INVALID_MESSAGE' });
  });

  socket.on('close', () => {
    for (const code of [...(socket.rooms || [])]) {
      const room = rooms.get(code);
      if (room && (room.host === socket || room.guest === socket)) removeRoom(room.code);
    }
  });
  socket.on('error', () => {});
});

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function validDescription(value, type) {
  return value && value.type === type && typeof value.sdp === 'string' && value.sdp.length > 0 && value.sdp.length <= 48 * 1024;
}

server.listen(PORT, process.env.SIGNALING_HOST || '127.0.0.1', () => {
  console.log(`Mana Surge signaling listening on ${PORT}`);
});

function shutdown() {
  for (const code of rooms.keys()) removeRoom(code);
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
