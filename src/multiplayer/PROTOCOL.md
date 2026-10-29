# Multiplayer session protocol (v1)

This document defines the first host-authoritative wire protocol. It carries player intent to the host; it does not let a guest submit game state. Transport and signaling are separate and are specified by later roadmap sections.

## Decisions represented on the wire

All troop references use positive integer `id` values, never object references or sprite data. Coordinates use integer axial `{ q, r }` values.

| Decision | Action payload | Host checks |
| --- | --- | --- |
| Choose a spawn tile | `{ type: 'spawn', tile: { q, r } }` | It is a currently offered empty neighboring tile for the active seat's spawner. A sole legal option may be applied automatically by the host. |
| Move a troop | `{ type: 'move', troopId, to: { q, r } }` | Owned by the active seat, unlocked, destination empty and adjacent, and legal in the current move phase. |
| Attack | `{ type: 'attack', attackerId, defenderId }` | Attacker belongs to active seat and is unlocked; defender is an adjacent opposing troop; current phase is combat. Host resolves combat. |
| Use the dagger | `{ type: 'sacrifice', troopIds: [id, id, id] }` | Dagger is available; IDs are distinct and all three troops belong to the active seat. Host resolves removal and mana gain. |
| Cancel dagger selection | `{ type: 'cancelSacrifice' }` | Host is waiting for a sacrifice choice for this seat; costs no action point. |
| Pass the optional action phase | `{ type: 'pass' }` | Host is waiting for a move or attack choice; ends that phase's remaining optional actions. |

The current UI gathers three troop clicks, but the wire action is atomic so incomplete selections are never accepted. Guests cannot advance phases, grant mana, resolve combat/randomness, declare victory, or choose CPU actions. Host seat setup uses a roster of `host`, `guest`, and `cpu` controllers; any seat not assigned to a guest defaults to CPU, so the host can keep unfilled seats running as CPUs.

## Envelope and message types

Every message is a plain JSON object with this envelope and a type-specific payload:

```json
{
  "v": 1,
  "matchId": "opaque-match-id",
  "senderSeat": 1,
  "seq": 4,
  "type": "actionRequest",
  "payload": { "type": "move", "troopId": 12, "to": { "q": 1, "r": -2 } }
}
```

`matchId` is a random per-match identifier of 16–64 ASCII characters from `[A-Za-z0-9_-]`. `senderSeat` is 0, 1, or 2; only initial `hello` uses `null`. `seq` is a positive safe integer, monotonic independently per direction and peer, beginning at 1. Accept only the next expected sequence; reject duplicates and gaps. A reconnect requires a fresh handshake, sequence space, and snapshot before actions resume.

V1 types and payloads:

- `hello`: guest to host, null seat, `{ supportedVersions: [1] }`.
- `seatAssignment`: host to guest, `{ seat, snapshot }`.
- `actionRequest`: guest to host; payload is one action in the table above.
- `actionAccepted`: host to guest, `{ action, stateVersion, event, snapshot }`. Host increments version once per accepted action; snapshot is mandatory in v1, including at phase boundaries. An attack event includes the host's resolved combat result (`attackerStats`, `defenderStats`, `attackerKills`, `defenderKills`, and casualty IDs); clients apply this event/snapshot and never roll or recalculate combat locally.
- `actionRejected`: host to guest, `{ requestSeq, code }`; codes: `NOT_YOUR_SEAT`, `NOT_YOUR_TURN`, `WRONG_PHASE`, `ILLEGAL_ACTION`, `STALE_STATE`, `RATE_LIMITED`. Rejection never mutates state or consumes an action point.
- `snapshot`: host to guest, `{ stateVersion, state, hash }`.
- `matchEnded`: host to guest, `{ winnerSeat }`; the host ends the session and guests display the host-declared winner. Guests cannot send this message.
- `heartbeat` and `heartbeatAck`: either direction, `{ timestamp }`; sender-local integer timestamp is informational only. Every peer sends a `heartbeat` every 15 seconds for the lifetime of the connection (including between matches) to keep NAT/firewall bindings open; receivers ignore it and need not reply.

### Rematches

Connections outlive a match. After `matchEnded`, the host's Play Again resets its game, creates a new match session (state version and request sequence start over; the per-peer message `seq` does not) and broadcasts `matchStarted` again. A guest that has already shown a result treats that `matchStarted` as a rematch: it resets its game, then repeats the `hello` / `seatAssignment` handshake to receive the host's snapshot. Guests that are no longer connected when the host starts the rematch are replaced by CPUs.
- `disconnect`: either direction, `{ reason }`; reason is one of `leave`, `connectionLost`, `hostEnded`. A guest sends `leave` when it chooses to leave; the host replaces that seat with a CPU immediately (no retry prompt) and keeps playing. A host sends `hostEnded` to every guest when it leaves; guests return to the main menu.
- `protocolError`: either direction, `{ code }`; code is `VERSION_MISMATCH`, `INVALID_MESSAGE`, or `MESSAGE_TOO_LARGE`, after which the peer may close the channel.

Unknown fields, message types, payload fields, or versions are rejected. No message contains executable content, HTML, arbitrary error strings, or user-provided display markup. A hello with no common supported version receives `protocolError: VERSION_MISMATCH`.

## Validation and limits

Validate parsing, envelope shape, exact version, match ID, expected sender seat for the channel, next sequence, payload shape, and phase/turn authorization before handling a message. Reject messages over 16 KiB UTF-8 encoded, more than 20 gameplay requests per peer in a rolling 10-second window, or more than 60 total messages per peer in that window. Enforce byte limits before parsing where the data channel exposes message length. Heartbeats never authorize actions.

The host rechecks active seat, phase, action points, legal moves/targets, ownership, locks, tile occupancy, current spawn options, troop reserve, dagger availability, and sacrifice ID uniqueness against authoritative state at application time. Guest actions are intent only: never accept guest mana, action points, combat outcomes, positions, winner, or version. Malformed input and rate limits are handled per peer without throwing into the game loop. Rejection must not mutate state.

## Shared snapshot boundary

A snapshot is a canonical data projection, not serialization of `GameState` or the scene. It contains phase (`start`, `move1`, `combat`, `move2`, `end`, or `gameOver`), active seat, win score, each seat's public name/color/CPU-or-human ownership/mana/action points/spawner coordinate, sorted tiles (`q`, `r`, `type`, `occupantId`), sorted troops (`id`, `owner`, `q`, `r`), `nextTroopId`, and `stateVersion`. Sort tiles by `q,r` and troops by `id` before hashing. Hash canonical JSON with SHA-256; hashes detect divergence but do not prove host honesty.

Exclude pending interaction promises/resolvers, selected sprites, Phaser objects, DOM/UI state, CPU behavior-tree state, AI weights, local connection state, signaling codes, and private browser data. Guests accept snapshots only from the host, replace the replicated shared model from a valid newer snapshot, and stop sending actions until synchronized. Host remains authoritative if a guest view diverges.

In v1 the host sends the accepted action/event and resulting snapshot in order for every action. A guest applies only the next version and verifies its hash; a version gap or hash mismatch requires a fresh snapshot before play resumes. Never replay a locally queued guest action after resynchronization; the player submits again against the current phase.

CPU decisions, including mistake-chance choices, run only on the host. The host serializes each selected CPU action through the same accepted-action/event path as a human action. Combat itself has no random roll: `resolveCombatOutcome` computes both sides' kills from the host's current stats in one simultaneous result, which is included in the attack event and resulting snapshot.

Game-specific validation and application live above transport. WebRTC delivers bounded protocol messages but does not decide whether an action is legal.

## Guest presentation

Snapshots carry state, not animation, so a guest derives the visuals by diffing the incoming snapshot against its current model, using the accepted `action` for context. Surviving troops tween to their new tile, new troops pop in with the spawn burst, removed troops play the destroy effect (thorns victims first move onto the thorns tile), attacks show the clash burst, and mana gains show the channel or sacrifice burst. The shared model is replaced immediately; presentation runs on an ordered queue so back-to-back host updates never overlap. The initial seat-assignment snapshot snaps to state without animation. The host also publishes a snapshot right after end-phase mana is awarded so guests see that effect when it happens.
