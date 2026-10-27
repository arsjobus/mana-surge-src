export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_MESSAGES_PER_WINDOW = 60;
export const MAX_ACTIONS_PER_WINDOW = 20;
export const RATE_WINDOW_MS = 10_000;

const MESSAGE_TYPES = new Set([
  'hello', 'seatAssignment', 'actionRequest', 'actionAccepted', 'actionRejected',
  'snapshot', 'heartbeat', 'heartbeatAck', 'disconnect', 'protocolError'
]);
const MATCH_ID = /^[A-Za-z0-9_-]{16,64}$/;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validCoord(value) {
  return exactKeys(value, ['q', 'r']) && Number.isSafeInteger(value.q) && Number.isSafeInteger(value.r);
}

export function isValidActionPayload(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
  switch (action.type) {
    case 'spawn': return exactKeys(action, ['type', 'tile']) && validCoord(action.tile);
    case 'move': return exactKeys(action, ['type', 'troopId', 'to']) && Number.isSafeInteger(action.troopId) && action.troopId > 0 && validCoord(action.to);
    case 'attack': return exactKeys(action, ['type', 'attackerId', 'defenderId']) && Number.isSafeInteger(action.attackerId) && action.attackerId > 0 && Number.isSafeInteger(action.defenderId) && action.defenderId > 0;
    case 'sacrifice': return exactKeys(action, ['type', 'troopIds']) && Array.isArray(action.troopIds) && action.troopIds.length === 3 && action.troopIds.every(id => Number.isSafeInteger(id) && id > 0) && new Set(action.troopIds).size === 3;
    case 'cancelSacrifice': case 'pass': return exactKeys(action, ['type']);
    default: return false;
  }
}

function validPayload(type, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  switch (type) {
    case 'hello': return exactKeys(payload, ['supportedVersions']) && Array.isArray(payload.supportedVersions) && payload.supportedVersions.length > 0 && payload.supportedVersions.every(v => Number.isSafeInteger(v) && v > 0);
    case 'seatAssignment': return exactKeys(payload, ['seat', 'snapshot']) && Number.isInteger(payload.seat) && payload.seat >= 0 && payload.seat <= 2 && !!payload.snapshot && typeof payload.snapshot === 'object';
    case 'actionRequest': return isValidActionPayload(payload);
    case 'actionAccepted': return exactKeys(payload, ['action', 'stateVersion', 'event', 'snapshot']) && isValidActionPayload(payload.action) && Number.isSafeInteger(payload.stateVersion) && payload.stateVersion > 0 && !!payload.event && typeof payload.event === 'object' && !!payload.snapshot && typeof payload.snapshot === 'object';
    case 'actionRejected': return exactKeys(payload, ['requestSeq', 'code']) && Number.isSafeInteger(payload.requestSeq) && payload.requestSeq > 0 && ['NOT_YOUR_SEAT', 'NOT_YOUR_TURN', 'WRONG_PHASE', 'ILLEGAL_ACTION', 'STALE_STATE', 'RATE_LIMITED'].includes(payload.code);
    case 'snapshot': return exactKeys(payload, ['stateVersion', 'state', 'hash']) && Number.isSafeInteger(payload.stateVersion) && payload.stateVersion >= 0 && !!payload.state && typeof payload.state === 'object' && typeof payload.hash === 'string' && payload.hash.length <= 128;
    case 'heartbeat': case 'heartbeatAck': return exactKeys(payload, ['timestamp']) && Number.isSafeInteger(payload.timestamp);
    case 'disconnect': return exactKeys(payload, ['reason']) && ['leave', 'connectionLost', 'hostEnded'].includes(payload.reason);
    case 'protocolError': return exactKeys(payload, ['code']) && ['VERSION_MISMATCH', 'INVALID_MESSAGE', 'MESSAGE_TOO_LARGE'].includes(payload.code);
    default: return false;
  }
}

export function encodeMessage(message) {
  if (!validateMessage(message)) throw new TypeError('Invalid multiplayer message');
  const encoded = JSON.stringify(message);
  if (new TextEncoder().encode(encoded).byteLength > MAX_MESSAGE_BYTES) throw new RangeError('Multiplayer message is too large');
  return encoded;
}

export function decodeMessage(data, { matchId, senderSeat } = {}) {
  try {
    if (typeof data !== 'string' || new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES) return null;
    const message = JSON.parse(data);
    if (!validateMessage(message) || (matchId && message.matchId !== matchId) ||
      (senderSeat !== undefined && message.type !== 'hello' && message.senderSeat !== senderSeat)) return null;
    return message;
  } catch {
    return null;
  }
}

export function validateMessage(message) {
  if (!exactKeys(message, ['v', 'matchId', 'senderSeat', 'seq', 'type', 'payload'])) return false;
  if (message.v !== PROTOCOL_VERSION || !MATCH_ID.test(message.matchId) || !MESSAGE_TYPES.has(message.type)) return false;
  if (message.type === 'hello' ? message.senderSeat !== null : !Number.isInteger(message.senderSeat) || message.senderSeat < 0 || message.senderSeat > 2) return false;
  return Number.isSafeInteger(message.seq) && message.seq > 0 && validPayload(message.type, message.payload);
}
