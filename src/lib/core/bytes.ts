/**
 * MeshLink core — byte-level helpers.
 *
 * Pure TypeScript, no React Native or Node dependencies, so the same code runs
 * in the Expo app (Metro), in vitest and in Node tools (relay node, simulator).
 */

const HEX = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? '0' + hex : hex;
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToB64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

export function b64ToBytes(s: string): Uint8Array {
  const t = s.replace(/[^A-Za-z0-9+/]/g, '');
  const rem = t.length % 4;
  if (rem === 1) throw new Error('bad base64');
  const outLen = rem === 0 ? (t.length / 4) * 3 : ((t.length - rem) / 4) * 3 + (rem - 1);
  const out = new Uint8Array(outLen);
  let p = 0;
  for (let i = 0; i < t.length; i += 4) {
    const e0 = B64.indexOf(t[i]);
    const e1 = i + 1 < t.length ? B64.indexOf(t[i + 1]) : 0;
    const e2 = i + 2 < t.length ? B64.indexOf(t[i + 2]) : 0;
    const e3 = i + 3 < t.length ? B64.indexOf(t[i + 3]) : 0;
    const n = (e0 << 18) | (e1 << 12) | (e2 << 6) | e3;
    if (p < out.length) out[p++] = (n >> 16) & 255;
    if (p < out.length) out[p++] = (n >> 8) & 255;
    if (p < out.length) out[p++] = n & 255;
  }
  return out;
}

export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Alias kept for readability at call sites that deal in protocol strings. */
export const utf8 = utf8ToBytes;

export function bytesToUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Constant-time equality (for MAC verification). */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Cryptographically secure random bytes. Available in RN (react-native-get-random-values), browsers and Node 19+. */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** Uniform random integer in [min, max) — for jitter, never for keys. */
export function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * Math.max(0, max - min));
}

// ------------------------------------------------------------------ varints

/** Unsigned LEB128 varint. */
export function encodeVarint(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return new Uint8Array(out);
}

/** Returns [value, nextOffset]. Throws on overflow past 53 bits. */
export function decodeVarint(buf: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    if (i >= buf.length) throw new Error('varint truncated');
    const b = buf[i++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 42) throw new Error('varint too long');
  }
  return [result, i];
}

export function u16le(n: number): Uint8Array {
  const out = new Uint8Array(2);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  return out;
}

export function readU16le(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8);
}

export function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

export function readU32le(buf: Uint8Array, offset: number): number {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | buf[offset + 3] * 0x1000000) >>> 0;
}

/** 64-bit little-endian counter as 8 bytes (safe range: < 2^53). */
export function u64le(n: number): Uint8Array {
  const lo = n % 0x100000000;
  const hi = Math.floor(n / 0x100000000);
  const out = new Uint8Array(8);
  out[0] = lo & 0xff;
  out[1] = (lo >>> 8) & 0xff;
  out[2] = (lo >>> 16) & 0xff;
  out[3] = (lo >>> 24) & 0xff;
  out[4] = hi & 0xff;
  out[5] = (hi >>> 8) & 0xff;
  out[6] = (hi >>> 16) & 0xff;
  out[7] = (hi >>> 24) & 0xff;
  return out;
}

export function readU64le(buf: Uint8Array, offset: number): number {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | buf[offset + 3] * 0x1000000) + (buf[offset + 4] | (buf[offset + 5] << 8) | (buf[offset + 6] << 16) | buf[offset + 7] * 0x1000000) * 0x100000000;
}
