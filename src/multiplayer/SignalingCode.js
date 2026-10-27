const MAX_CODE_CHARS = 64 * 1024;
const CODE_PREFIX = 'mana1.';

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function exportSignalingCode(description) {
  if (!description || !['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string' || description.sdp.length > 48 * 1024) {
    throw new TypeError('Invalid signaling description');
  }
  const code = `${CODE_PREFIX}${toBase64Url(JSON.stringify({ v: 1, type: description.type, sdp: description.sdp }))}`;
  if (code.length > MAX_CODE_CHARS) throw new RangeError('Signaling code is too large');
  return code;
}

export function importSignalingCode(code, expectedType) {
  try {
    if (typeof code !== 'string' || code.length > MAX_CODE_CHARS || !code.startsWith(CODE_PREFIX)) return null;
    const value = JSON.parse(fromBase64Url(code.slice(CODE_PREFIX.length)));
    if (!value || Object.keys(value).length !== 3 || value.v !== 1 || !['offer', 'answer'].includes(value.type) || (expectedType && value.type !== expectedType) || typeof value.sdp !== 'string' || value.sdp.length > 48 * 1024) return null;
    return { type: value.type, sdp: value.sdp };
  } catch {
    return null;
  }
}
