// Exercises the Vercel function against an in-memory Redis stand-in and checks
// both the invite flow and how many Redis commands each step costs.
const assert = require('node:assert/strict');

const store = new Map();
let commands = 0;
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
global.fetch = async (_url, { body }) => {
  commands++;
  const [op, ...args] = JSON.parse(body);
  let result = null;
  if (op === 'SET') {
    const [key, value, , , nx] = args;
    if (nx === 'NX' && store.has(key)) result = null; else { store.set(key, value); result = 'OK'; }
  } else if (op === 'GET') result = store.get(args[0]) ?? null;
  else if (op === 'MGET') result = args.map(key => store.get(key) ?? null);
  else if (op === 'DEL') { result = args.filter(key => store.delete(key)).length; }
  else throw new Error(`unexpected command ${op}`);
  return { ok: true, json: async () => ({ result }) };
};

const handler = require('../api/signaling.js');

async function call(message, { contentType = 'text/plain;charset=UTF-8' } = {}) {
  const raw = JSON.stringify(message);
  const req = { method: 'POST', url: '/api/signaling', headers: { 'content-type': contentType },
    body: contentType.startsWith('application/json') ? message : raw };
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { this.text = text; } };
  await handler(req, res);
  return { status: res.statusCode, body: res.text ? JSON.parse(res.text) : null, headers: res.headers };
}

(async () => {
  const offer = { type: 'offer', sdp: 'o' }, answer = { type: 'answer', sdp: 'a' };
  const created = await call({ action: 'create', matchId: 'match_identifier_1234', hostSeat: 0, seat: 1, score: 10, offer });
  assert.equal(created.status, 200);
  const { code } = created.body;

  commands = 0;
  const waiting = await call({ action: 'status', code });
  assert.deepEqual(waiting.body, { guestJoined: false });
  assert.equal(commands, 1, 'a waiting poll should cost one Redis command');

  const joined = await call({ action: 'join', code }, { contentType: 'application/json' }); // older clients
  assert.equal(joined.status, 200);
  assert.equal(joined.body.type, 'offer');
  assert.equal((await call({ action: 'join', code })).status, 409, 'an invite is single use');

  assert.deepEqual((await call({ action: 'status', code })).body, { guestJoined: true });

  commands = 0;
  assert.equal((await call({ action: 'answer', code, answer })).status, 200);
  assert.equal(commands, 2, 'answer = one MGET + one SET');

  const done = await call({ action: 'status', code });
  assert.deepEqual(done.body, { guestJoined: true, seat: 1, answer });
  assert.equal(store.size, 0, 'the room is removed once the answer is delivered');

  const bad = await call({ action: 'status', code: 'x' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.reason, /code must be/, 'a 400 names the failing check');

  // A 400 must say which field was wrong (JSON.stringify drops undefined fields).
  const noScore = await call({ action: 'create', matchId: 'match_identifier_1234', hostSeat: 0, seat: 1, score: undefined, offer });
  assert.equal(noScore.status, 400);
  assert.match(noScore.body.reason, /missing field\(s\): score/);
  const wrongType = await call({ action: 'create', matchId: 'match_identifier_1234', hostSeat: 0, seat: 1, score: 10, offer: answer });
  assert.match(wrongType.body.reason, /offer\.type must be "offer"/);

  // Unknown extra fields are ignored rather than rejected, and are never stored.
  const extra = await call({ action: 'create', matchId: 'match_identifier_1234', hostSeat: 0, seat: 2, score: 20, offer, v: 2, junk: true });
  assert.equal(extra.status, 200);
  const extraCode = extra.body.code;

  // Answering before the guest has joined is not a malformed request.
  const early = await call({ action: 'answer', code: extraCode, answer });
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'NOT_JOINED');
  const room = JSON.parse(store.get(`mana-surge:room:${extraCode}`));
  assert.deepEqual(Object.keys(room).sort(), ['hostSeat', 'matchId', 'offer', 'score', 'seat']);
  assert.equal((await call({ action: 'close', code: extraCode })).status, 200);
  const garbage = await handler({ method: 'POST', url: '/api/signaling', body: '{not json' }, { setHeader() {}, end() {} });
  console.log('api signaling ok');
})().catch(error => { console.error(error); process.exit(1); });
