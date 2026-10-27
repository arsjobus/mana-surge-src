const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const WebSocket = require('ws');

function listen(socket) {
  return new Promise(resolve => socket.once('message', data => resolve(JSON.parse(data.toString()))));
}

function listenType(socket, type) {
  return new Promise(resolve => {
    const handler = data => {
      const message = JSON.parse(data.toString());
      if (message.type !== type) return;
      socket.off('message', handler);
      resolve(message);
    };
    socket.on('message', handler);
  });
}

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function main() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '../server/signaling.js')], {
    env: { ...process.env, SIGNALING_PORT: String(port), SIGNALING_HOST: '127.0.0.1' },
    stdio: 'ignore'
  });
  const sockets = [];
  try {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, 'signaling server should start');
    const url = `ws://127.0.0.1:${port}/signal`;
    const host = new WebSocket(url); sockets.push(host);
    await new Promise(resolve => host.once('open', resolve));
    host.send(JSON.stringify({ type: 'create', matchId: 'match_identifier_1234', hostSeat: 0, seat: 1, score: 10, offer: { type: 'offer', sdp: 'host-sdp' } }));
    const created = await listen(host);
    assert.equal(created.type, 'created');
    assert.match(created.code, /^[A-Za-z0-9_-]{10,16}$/);
    host.send(JSON.stringify({ type: 'create', matchId: 'match_identifier_1234', hostSeat: 0, seat: 2, score: 10, offer: { type: 'offer', sdp: 'second-host-sdp' } }));
    const secondInvite = await listen(host);
    assert.equal(secondInvite.type, 'created');
    assert.notEqual(secondInvite.code, created.code);

    const guest = new WebSocket(url); sockets.push(guest);
    await new Promise(resolve => guest.once('open', resolve));
    guest.send(JSON.stringify({ type: 'join', code: created.code }));
    const offer = await listen(guest);
    assert.deepEqual(offer, { type: 'offer', matchId: 'match_identifier_1234', seat: 1, hostSeat: 0, score: 10, offer: { type: 'offer', sdp: 'host-sdp' } });
    assert.deepEqual(await listen(host), { type: 'guestJoined', seat: 1 });
    const hostClosed = listenType(host, 'closed');
    guest.send(JSON.stringify({ type: 'answer', code: created.code, answer: { type: 'answer', sdp: 'guest-sdp' } }));
    assert.deepEqual(await listen(host), { type: 'answer', seat: 1, answer: { type: 'answer', sdp: 'guest-sdp' } });
    assert.equal((await hostClosed).type, 'closed');

    const duplicate = new WebSocket(url); sockets.push(duplicate);
    await new Promise(resolve => duplicate.once('open', resolve));
    duplicate.send(JSON.stringify({ type: 'join', code: created.code }));
    assert.deepEqual(await listen(duplicate), { type: 'error', code: 'ROOM_EXPIRED' });
    console.log('Signaling relay one-use invite flow passed.');
  } finally {
    for (const socket of sockets) socket.close();
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
