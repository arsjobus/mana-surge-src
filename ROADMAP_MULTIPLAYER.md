# Mana Surge Multiplayer Roadmap

## Goal

Add online matches for up to three human players using the existing three game seats. One player hosts the match and is also a player; the host is authoritative for game state and turn resolution. Preserve the current solo game, CPU opponents, rules, and local browser launch flow.

This roadmap targets casual private matches. A host-authoritative peer-to-peer game prevents ordinary clients from directly writing authoritative state, but it cannot prevent a malicious host from changing the game or guarantee competitive anti-cheat. No account system, matchmaking, public lobby directory, or server-side persistence is in scope for the initial version.

## Is serverless multiplayer possible?

Yes, with practical limits. Use browser WebRTC data channels for game messages. WebRTC does not define how peers find each other or exchange connection setup data, so a no-central-server launch flow must exchange offers, answers, and ICE candidates out of band. The first version can provide copy/paste connection codes (and optionally QR codes) between the host and each joining player. The host can form a small star topology with one direct connection per guest; this suits three seats and keeps game traffic simple.

Direct connectivity is not guaranteed across every NAT, firewall, or browser network. STUN can help peers discover usable routes, but some network combinations require a TURN relay. TURN carries traffic through a server, so it is not strictly serverless. The app should report connection failure clearly and document this tradeoff. Manual signaling avoids operating a signaling service, but is less convenient than a room-code lobby.

WebRTC encrypts data in transit, but encryption does not authenticate a real-world identity. A private invite code is a connection secret, not proof of who joined. Treat all remote messages as untrusted, validate them, limit message size/rate, and never execute remote-provided code or HTML. Keep host authority and validation in the game layer rather than trusting a guest's claimed state.

## Current architecture and multiplayer boundary

The game is native browser ES modules with Phaser supplied by a local script. Rules and turn orchestration live in `src/systems/`, mutable match data in `src/state/GameState.js`, scene assembly in `src/GameRuntime.js`, and browser UI in `src/ui/`. `GameState` already creates three seats and `TurnSystem.js` cycles among them. Currently only one seat is human-controlled; the other two use the CPU.

Add networking as a separate transport/session layer. Keep WebRTC objects, connection state, and signaling payloads out of `GameState`. Keep the rules engine deterministic where practical and make the host's accepted actions the source of truth. Do not replicate Phaser sprites or DOM state.

## Architecture decisions

- **Seat count:** Keep three total seats, with the host occupying one seat. The other seats can be guests or CPUs, so host-plus-two guests fills the match. This matches the existing board and victory logic.
- **Authority:** The host owns the authoritative `GameState`, validates guest actions against the current phase, active seat, legal choices, and game rules, then broadcasts accepted actions and resulting state/version information. Guest clients render the host-approved match and only submit actions for their assigned seat.
- **Topology:** Host-star for up to two guests. A guest connects only to the host; guests do not send gameplay messages directly to each other.
- **Transport:** WebRTC `RTCDataChannel` for gameplay messages. Add a small transport interface so turn/rule code can operate without depending directly on WebRTC.
- **Initial signaling:** Manual exchange of bounded, versioned connection descriptions and ICE candidates. Do not require a signaling backend or lobby service for this milestone.
- **NAT traversal:** Support configurable STUN servers, with no baked-in dependency on an undocumented public service. Explain that STUN does not guarantee connectivity and TURN requires a relay service. Leave TURN configuration as an optional future deployment setting.
- **Fallback:** Solo play remains available. Do not silently turn a disconnected guest into a CPU or change seat ownership; expose an explicit host action to replace a disconnected guest with a CPU or end the match.
- **Scope boundary:** No voice/video, spectators, chat, matchmaking, ranked play, persistent accounts, or save/resume in the initial release.

## Step-by-step checklist

### 1. Define the session protocol and rules boundary

- [x] Inventory every human decision requested during spawn, movement, combat, dagger/sacrifice, skip, and phase progression; identify the smallest action messages needed to represent each choice.
- [x] Define a versioned JSON message envelope with match ID, sender seat, monotonically increasing sequence number, message type, and bounded payload.
- [x] Define host-to-guest and guest-to-host messages, including hello/seat assignment, action request, accepted action/state update, rejection, heartbeat, disconnect, and protocol-version mismatch.
- [x] Specify validation for sender seat, current phase, turn ownership, legal moves/targets, payload shape, message size, and replayed/out-of-order sequence numbers.
- [x] Decide how guests stay synchronized: begin with host-approved action/state snapshots at phase or action boundaries; add hashes/checkpoints to detect divergence.
- [x] Keep private host/guest display state separate from shared match state. Do not include pending promise resolvers, Phaser objects, DOM nodes, or AI internals in network snapshots.

Protocol details and action inventory: [`src/multiplayer/PROTOCOL.md`](src/multiplayer/PROTOCOL.md).

### 2. Refactor human input into transportable actions

- [x] Refactor `ui/BoardInput.js` and turn-system choice points so local input produces typed action intents rather than resolving shared pending callbacks directly.
- [x] Add a local action adapter that preserves existing solo behavior without changing game rules or controls.
- [x] Add host validation and action application functions that can be called without DOM or Phaser dependencies where practical.
- [x] Ensure CPU-controlled seats still work in solo games and can be selected by the host for unfilled seats in multiplayer.
- [x] Confirm simultaneous combat and any random choices are resolved by the host and represented in the shared result, so clients do not independently resolve them.

Implementation: `src/multiplayer/ActionSystem.js` defines serializable intents, keeps local pending input private to an adapter, and validates actions against seat ownership and legal board choices. `src/multiplayer/SeatConfig.js` builds a three-seat host/guest/CPU roster, defaulting unfilled guest seats to CPU. `src/systems/CombatSystem.js` resolves both combat casualties together; protocol v1 requires the host to include this outcome with the accepted attack event and snapshot. CPU mistake-chance choices run on the host and are serialized as ordinary accepted actions.

### 3. Add a WebRTC transport module

- [x] Add `src/multiplayer/` modules for the WebRTC peer connection, data channel, message codec/validation, session coordinator, and signaling-code import/export.
- [x] Create one host-to-guest data channel per guest, with ordered reliable delivery for game actions.
- [x] Apply strict payload size and message-rate limits, validate all parsed messages, and handle malformed input without crashing or mutating the match.
- [x] Add connection lifecycle handling for connecting, connected, disconnected, failed, and closed states, plus explicit retry/leave paths.
- [x] Ensure cleanup closes data channels, peer connections, listeners, timers, and any pending UI choices on restart or leaving a match.
- [x] Keep signaling data short-lived and avoid storing it in local storage or logging it by default.

Implementation: `MessageCodec.js` validates v1 envelopes and action payloads with a 16 KiB message limit. `SignalingCode.js` imports/exports bounded, versioned SDP codes. `WebRtcPeer.js` provides one ordered reliable data channel, lifecycle callbacks, inbound sequence/rate limits, and cleanup; callers supply ICE server configuration (none is silently baked in). `SessionCoordinator.js` manages host-star peer routing, handshake compatibility, and explicit peer teardown. Recreate a peer to retry; call `close()` to leave. Signaling codes remain caller-owned and are never persisted or logged by these modules.

### 4. Add host and guest lobby flows

- [ ] Add a multiplayer choice on the start screen while preserving solo setup and settings.
- [ ] Let the host select their seat/color, win score, and whether unfilled seats are CPU-controlled or open to guests.
- [ ] Let the host create a join offer/code for each open guest seat and show connection status and assigned seat.
- [ ] Let a guest paste/import the host offer, return an answer code, and confirm the assigned seat before joining the match.
- [ ] Support cancellation, invalid/expired code feedback, duplicate seat rejection, browser refresh/leave behavior, and a clear start-match action once the host is ready.
- [ ] Make clear in the UI that invite codes grant access to a seat and should only be shared with intended players.

Progress: `src/multiplayer/LobbyUI.js` adds the host/guest lobby, seat and CPU/open-seat controls, per-open-seat offer generation, answer import, guest seat confirmation, cancellation, connection feedback, and copy/paste codes. The lobby keeps match signaling in memory and closes peers when cancelled or closed. The Start/Join controls currently stop at a lobby-ready handoff; authoritative match startup is the next section. Manual browser-to-browser validation remains outstanding.

### 5. Integrate host-authoritative match flow

- [x] Add a multiplayer session mode to `GameState` or a distinct session model without coupling it to WebRTC internals.
- [ ] Update `TurnSystem.js` so host CPU turns run locally, host human choices are applied locally through the same validation path, and guest turns wait for validated guest actions.
- [ ] Broadcast host-approved updates in deterministic order; guests apply only updates from the host and show waiting/turn ownership status.
- [ ] Prevent a guest from acting for another seat or sending actions outside its active turn; return a safe rejection and keep the match synchronized.
- [x] Handle host disconnect as match termination for this version; show a clear result and offer solo restart. Do not implement host migration unless a later roadmap explicitly covers it.
- [ ] If a guest disconnects, pause at a safe decision boundary and let the host retry, replace that seat with CPU, or end the match.

Progress: `GameState` now reserves game-layer session/version fields, and `src/multiplayer/MatchSession.js` adds a transport-independent host/guest session model with active-seat/phase tracking, guest action authorization, ordered version acceptance, Phaser-free canonical snapshot projection, and distinct host/guest disconnect outcomes. Turn-loop action routing, snapshot application/rendering, and lobby-to-session startup are not yet connected; do not treat multiplayer matches as playable until those items and verification below are complete.

Turn-system integration has begun: `TurnSystem.js` now reports spawn, move I, combat, move II, and end-phase decision boundaries through an optional callback. `GameRuntime.js` forwards those boundaries to an attached `GameState.session`. The lobby now hands off into Phaser, constructs the host/guest `SessionCoordinator` and `MatchSession`, starts the guest protocol handshake, and sends the initial host seat assignment after hello. The host waits for all open guest seats to have a connected data channel before starting. This remains a connection/session bootstrap only; action transport, snapshot application/rendering, gameplay disconnect handling, and ending/restarting a network match remain outstanding.

`MatchSession` now also exposes a callback-based host action request pipeline with seat/turn/phase/sequence authorization, game-rule validation, host-owned application, rejection, and accepted-update publication. Guest update acceptance checks strictly increasing versions and the snapshot's phase/active-seat/version fields; action request sequences are tracked per guest. These are session primitives only: the Phaser turn loop does not yet call this pipeline, snapshots are not yet applied to/rendered by the guest, and disconnect recovery is not connected to in-match controls. Do not treat multiplayer matches as playable yet.

Snapshot flow is now connected to the Phaser runtime. The host publishes a canonical snapshot at each decision boundary, and guests accept seat assignment, ordered action updates, and current-version snapshots only after validating the board, troop, player, and version fields; accepted snapshots rebuild the guest's game entities and HUD. Guests no longer advance an independent CPU/local turn loop. Guest action submission and host-side request-to-turn integration are still outstanding, so this is synchronization groundwork and not yet a playable match.

The guest host-disconnect path is now connected to a match-ended modal: it stops the session, cancels pending local input, and uses the existing Restart control to return to the solo setup on reload. Host migration remains out of scope. Other multiplayer gameplay and guest disconnect handling remain outstanding.

**Turn integration slice completed: guest moves in Move Phase I.** When the host turn loop is waiting for a guest's Move Phase I choice, it accepts only a move or pass request for that guest seat, validates the intent against the host's current board, and submits the validated intent through the existing turn loop. The host applies the move and publishes an incremented `actionAccepted` snapshot; the guest waits for and applies that snapshot before requesting another move. Focused session coverage exercises the authorized request, host update, and guest snapshot acceptance. This does not complete the turn-system checklist item: spawn, Move Phase II, combat, dagger/sacrifice, CPU action publication, and complete match progression still need integration. The next implementation slice is guest spawning in the host's authoritative Start Phase, followed by Move Phase II and combat using the same request/validate/apply/broadcast pattern.

**Turn integration slice completed: guest spawning in Start Phase.** A guest can choose among its currently open spawn tiles and send the tile as an intent. The host accepts it only while that seat owns the active Start Phase spawn choice, checks it against the host's current spawn options, and applies it through the existing turn loop. The host publishes an accepted snapshot after every spawn, including automatic and CPU spawns, so the guest never creates authoritative troops locally. Move Phase II, combat, dagger/sacrifice, CPU action publication, disconnect recovery, and full match progression remain outstanding. The next integration slice is Move Phase II, then combat.

**Turn integration slice completed: guest moves and passes in Move Phase II.** The guest turn runner now starts for either move phase, requests moves and passes through the same input wait as Move Phase I, and waits for each host-approved snapshot before continuing. The host accepts those requests only while that guest owns the active Move Phase II decision, validates moves against the authoritative board, applies them through the existing turn loop, and broadcasts accepted snapshots. Focused Cypress coverage exercises Move Phase II authorization and ordered snapshot acceptance. Combat and dagger/sacrifice integration remain outstanding; the next slice is guest combat actions.

**Turn integration slice completed: guest combat attacks and passes.** During a guest-owned Combat Phase, the host now accepts only attack or pass intents while its turn loop is waiting for that seat, validates the attacker and defender against the authoritative board, and lets the existing host combat resolver determine simultaneous casualties. Accepted attacks and passes publish ordered host snapshots; the guest starts its combat input loop only after an authoritative snapshot marks its seat active. Focused Cypress coverage verifies the authorized combat request and host-resolved event/snapshot synchronization. Dagger/sacrifice actions, CPU action publication, guest disconnect recovery, and complete match progression remain outstanding; the next slice is dagger/sacrifice.

### 6. Build coverage and perform manual verification

- [x] Add unit or browser tests for protocol validation, host action authorization, sequence handling, and guest rejection paths.
- [x] Extend Cypress coverage for solo regression, host setup, guest seat assignment, and multiplayer UI states using a deterministic fake transport where appropriate.
- [ ] Manually test two- and three-browser sessions on the same machine/network, including legal and illegal actions, victory, restart/leave, and disconnects.
- [ ] Manually test a connection between separate networks and document whether STUN-only succeeds; do not claim universal reachability based only on local-network tests.
- [ ] Check browser consoles for errors and verify cleanup after leaving or restarting a session.
- [ ] Document setup, connection-code exchange, supported browser requirements, privacy implications, and TURN limitations in `README.md` after implementation.

Coverage: `cypress/e2e/multiplayer.cy.js` checks protocol envelope round trips and malformed/mismatched input, host seat and turn authorization, replay rejection, wrong-phase actions, and game-rule rejection. The full Cypress suite passes. These tests cover session primitives; they do not establish that a complete multiplayer match is playable.

Additional Cypress coverage: `multiplayer.cy.js` checks host seat selection, CPU/open guest seat configuration, lobby cancellation, malformed invite feedback, and deterministic guest seat assignment. Complete multiplayer flow coverage remains outstanding.

The multiplayer Cypress coverage now also exercises the guest handshake and host seat-assignment message through an in-memory fake transport. The full suite passes (15 tests across completion, gameplay, and multiplayer specs); this verifies protocol/session handoff behavior without claiming a live WebRTC match is playable.

Additional focused Cypress coverage exercises the Move Phase I action request and host-approved snapshot acceptance at the session boundary. Browser-to-browser turn integration and full-match coverage remain outstanding.

## Completion criteria

- [ ] Existing solo games, CPU behavior, turn rules, and restart flow continue to work.
- [ ] One host and up to two guests can play a complete match in the existing three seats, with optional CPU seats.
- [ ] Guests can only submit actions for their assigned seat and only when authorized by the host's current match state.
- [ ] The host is the sole source of truth for action order, game rules, combat results, and victory.
- [ ] Unsupported, malformed, stale, or oversized network messages are rejected safely and do not corrupt state.
- [ ] Connection failure, player departure, and host departure have visible, predictable outcomes.
- [x] A no-central-server flow is documented with manual signaling; connectivity caveats and optional TURN relay requirements are stated accurately. See the multiplayer prototype section in `README.md`; it also states that playable matches are not implemented yet.
- [x] No identity, privacy, anti-cheat, or cross-network reliability guarantees are claimed beyond what the design provides.

## Notes and future options

- WebRTC signaling is deliberately out of scope for the initial transport milestone. If manual offer/answer exchange proves too cumbersome, a later optional signaling service can exchange setup messages without becoming the game-state authority.
- A TURN relay can improve reachability but routes data through an operator's infrastructure and has bandwidth/cost implications. Offer it as an explicit deployment option, not as a hidden requirement.
- Host authority is appropriate for friendly matches, but a dishonest host can falsify results. Competitive play would need a trusted server or a substantially different verification model.
- Keep networking feature flags and solo startup isolated so the current game remains usable when WebRTC is unavailable or unsupported.
