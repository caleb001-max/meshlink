// Base64 + UTF-8 helpers that work in React Native without btoa/atob/Buffer.

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
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(Math.floor((t.length * 3) / 4) - pad);
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

export function strToBytes(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      c = (c - 0xd800) * 0x400 + (s.charCodeAt(++i) - 0xdc00) + 0x10000;
    }
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 63),
        0x80 | ((c >> 6) & 63),
        0x80 | (c & 63),
      );
  }
  return new Uint8Array(bytes);
}

export function bytesToStr(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i++];
    let cp: number;
    if (c < 0x80) cp = c;
    else if ((c & 0xe0) === 0xc0) cp = ((c & 31) << 6) | (b[i++] & 63);
    else if ((c & 0xf0) === 0xe0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    else
      cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

const HEX = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
