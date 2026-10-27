# Mana Surge

## Setup and Quick Start

Serve the repository root over HTTP so the browser can load ES modules, Phaser, and music:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>. ES modules require HTTP(S); opening `index.html` directly with `file://` will not work.

## Build for Itch.io

Run `npm run build:itch` to create `dist/mana-surge-itch.zip`. Upload that ZIP to an Itch.io project configured as an HTML game, with “This file will be played in the browser” enabled. The archive contains `index.html`, `assets/`, and `src/` at its root so the game can load its local Phaser build, styles, music, and ES modules.

The build script uses Python's standard library and does not require installing extra packages.

## Browser checks

Install the development dependency once with `npm install`. In one terminal, run `npm run serve`; in another, run `npm run cypress:run` for headless checks or `npm run cypress:open` to use the Cypress runner. The checks exercise start-screen settings, Phaser startup and HUD, help and credits, canvas/UI resizing, victory presentation, and restart behavior.

## Multiplayer prototype

The private multiplayer lobby currently supports manual WebRTC offer/answer exchange as connection and session-bootstrap groundwork. It does not yet support a playable multiplayer match; use the regular **Begin the Surge** flow for a complete game.

The lobby flow is:

1. The host selects a seat, sets other seats to CPU or **Open to guest**, and creates an invite for each open seat.
2. The host sends each invite code directly to its intended player.
3. Each guest pastes the invite, prepares an answer, confirms the displayed seat, and sends the answer code back to the host.
4. The host applies each answer and can start the current session bootstrap once the open seats connect.

Codes are exchanged manually; there is no matchmaking or signaling service. An invite code grants access to its seat, so share it only with the intended player. WebRTC encrypts data in transit, but the code does not verify a player's real-world identity. The host-authoritative design is intended for private casual matches and does not prevent a dishonest host from changing game state.

The transport uses browser WebRTC data channels and currently has no built-in STUN or TURN servers. A direct connection may fail behind some NATs or firewalls. STUN can improve peer discovery, while TURN requires an explicitly configured relay and routes traffic through that relay operator. Cross-network connectivity and browser compatibility have not yet been manually verified; do not assume every network can connect.
