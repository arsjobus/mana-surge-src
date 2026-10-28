# Mana Surge

## Setup and Quick Start

Serve the repository root over HTTP so the browser can load ES modules, Phaser, and music:

```sh
python3 -m http.server 8000
```

For multiplayer, also run the short-lived signaling relay in a second terminal:

```sh
npm install
npm run signaling
```

Then open <http://localhost:8000>. ES modules require HTTP(S); opening `index.html` directly with `file://` will not work.

## Build for Itch.io

Run `npm run build:itch` to create `dist/mana-surge-itch.zip`. Upload that ZIP to an Itch.io project configured as an HTML game, with “This file will be played in the browser” enabled. The archive contains `index.html`, `assets/`, and `src/` at its root so the game can load its local Phaser build, styles, music, and ES modules.

The build script uses Python's standard library and does not require installing extra packages.

## Browser checks

Install dependencies once with `npm install`. Run `npm run serve` for the game and `npm run signaling` for the invite relay. Run `npm run cypress:run` for headless checks or `npm run cypress:open` to use the Cypress runner. Run `npm run test:signaling` to check relay invite creation, automatic answer forwarding, and one-use room cleanup.

## Multiplayer

Private multiplayer matches support one host and up to two guests, with any remaining seats controlled by the CPU. The host owns the authoritative game state and resolves all actions and victory; guests submit choices for their assigned seats and apply the host's approved updates.

To start a match, serve the game over HTTP(S) and run the signaling service (`npm run signaling`) on a reachable host. Open **Multiplayer** from the start screen and follow the lobby controls:

1. The host chooses a seat and sets each other seat to **CPU** or **Open to guest**. Create a separate invite for each open seat.
2. Send each short invite code directly to its intended player. An invite grants access to that seat, so keep it private.
3. Each guest enters the invite, confirms the assigned seat, and joins. The signaling service automatically returns the WebRTC answer to the host.
4. The host starts the match after all invited seats connect; gameplay updates come from the host.

The signaling service only brokers short-lived WebRTC setup descriptions. It does not carry gameplay traffic or store match state. Rooms expire after ten minutes and are removed after the answer is relayed. Locally, `server/signaling.js` uses WebSockets and in-memory rooms. On Vercel, `api/signaling.js` uses short HTTP requests and Upstash Redis so separate serverless function instances can share invites; connect an Upstash Redis database to the Vercel project so `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are available. The deployed game uses `/api/signaling` automatically, while `localhost` continues to use the local WebSocket relay. Set `globalThis.MANA_SURGE_SIGNALING_URL` before loading the game to override the default endpoint. There is no matchmaking, room directory, or persistent lobby. If a guest disconnects, the host can create a fresh invite for that seat, replace the guest with a CPU, or end the match. If the host disconnects, the match ends; guests can restart into solo setup. A victory declared by the host is shown to all connected guests.

The game requires a modern browser with ES module and WebRTC `RTCPeerConnection`/data-channel support, plus the signaling service for initial invite exchange. Use HTTP(S); `localhost` is suitable for local testing, while remote deployments should use HTTPS/WSS. Clipboard access may depend on browser permissions, and invite codes can always be selected and copied from the lobby field.

The lobby does not configure STUN or TURN servers. Direct connections can fail behind some NATs and firewalls, and same-network success does not establish cross-network reachability. STUN may improve peer discovery; TURN can relay traffic but requires an explicitly operated service and sends traffic through that relay operator. The current lobby does not expose ICE server configuration, so deployments needing TURN require a code/configuration change.

WebRTC encrypts data in transit, but invite codes do not establish real-world identity. The host-authoritative design is intended for private casual matches: guests cannot directly write the host's state, but a dishonest host can falsify the match. The game does not use accounts or a matchmaking backend. Do not share invite codes publicly.
