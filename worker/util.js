/* Small helpers shared by the Worker: encoding, signing, cookies, responses. */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(input) {
  const bytes = typeof input === 'string' ? enc.encode(input) : new Uint8Array(input);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToString(s) {
  const padded = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return dec.decode(bytes);
}

export function randomToken(bytes) {
  const b = new Uint8Array(bytes || 16);
  crypto.getRandomValues(b);
  return b64url(b);
}

export function randomCode(len) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = new Uint8Array(len || 8);
  crypto.getRandomValues(b);
  let out = '';
  for (const x of b) out += alphabet[x % alphabet.length];
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function sign(secret, message) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(message)));
  return b64url(sig);
}

/* Constant time for equal-length strings; length is not a secret here. */
export function timingEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/* value.signature, where value is base64url JSON */
export async function pack(secret, payload) {
  const body = b64url(JSON.stringify(payload));
  return body + '.' + (await sign(secret, body));
}

export async function unpack(secret, token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const want = await sign(secret, body);
  if (!timingEqual(sig, want)) return null;
  try {
    return JSON.parse(b64urlToString(body));
  } catch (e) {
    return null;
  }
}

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function cookie(name, value, opts) {
  const o = opts || {};
  const bits = [name + '=' + value, 'Path=' + (o.path || '/'), 'HttpOnly',
    'SameSite=' + (o.sameSite || 'Lax')];
  if (o.secure !== false) bits.push('Secure');
  if (typeof o.maxAge === 'number') bits.push('Max-Age=' + Math.floor(o.maxAge));
  return bits.join('; ');
}

export function json(body, status, headers) {
  const h = new Headers(headers || {});
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  h.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(body), { status: status || 200, headers: h });
}

export function errorJson(status, message) {
  return json({ ok: false, error: String(message || 'error') }, status);
}

export function nowIso() {
  return new Date().toISOString();
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}
