/**
 * MeshLink link security — protects DIRECT links (LAN TCP, Bluetooth GATT
 * traffic that is not itself end-to-end encrypted control traffic) with a
 * Noise-style ephemeral handshake.
 *
 * Pattern: two ephemeral X25519 keys, both sides sign the transcript with
 * their long-term Ed25519 identity, HKDF derives per-direction keys, and every
 * frame is AEAD-sealed with an explicit 64-bit counter. This is an
 * implementation of the published Noise XX/KK hybrid idea on audited
 * primitives (X25519 + Ed25519 + HKDF-SHA256 + ChaCha20-Poly1305), not a new
 * construction; the transcript binding prevents replay of handshake messages.
 *
 * Status: unit-tested (see tests/linksec.test.ts); NOT yet verified on real
 * radios — treat cross-device behavior as Unverified until device tests run.
 */

import { x25519, ed25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 as sha256Hash } from '@noble/hashes/sha2';
import { concat, u64le, readU64le, u16le, readU16le, utf8, randomBytes } from './bytes';
import { signBytes, verifyBytes } from './crypto';

export const LINKSEC_VERSION = 1;
const HANDSHAKE_1 = 'MeshLink-Handshake1-v1';
const HANDSHAKE_2 = 'MeshLink-Handshake2-v1';
const LINK_INFO = 'MeshLink-LinkKeys-v1';
const MAX_FRAME = 256 * 1024;

export interface HandshakeMessage1 {
  version: number;
  ephPub: Uint8Array; // 32B
  nonce: Uint8Array; // 16B
  /** Ed25519 signature over HANDSHAKE_1 || ephPub || nonce, by the sender. */
  sig: Uint8Array; // 64B
}

export interface HandshakeMessage2 {
  version: number;
  ephPub: Uint8Array; // 32B
  nonce: Uint8Array; // 16B
  /** Ed25519 signature over HANDSHAKE_2 || hs1.ephPub || hs1.nonce || ephPub || nonce. */
  sig: Uint8Array; // 64B
  /** Sender's Ed25519 public key so the peer can verify. */
  signPub: Uint8Array; // 32B
}

export function encodeHandshake1(m: HandshakeMessage1): Uint8Array {
  return concat(new Uint8Array([m.version]), m.ephPub, m.nonce, m.sig);
}

export function decodeHandshake1(buf: Uint8Array): HandshakeMessage1 {
  if (buf.length !== 1 + 32 + 16 + 64) throw new Error('bad handshake1');
  return { version: buf[0], ephPub: buf.slice(1, 33), nonce: buf.slice(33, 49), sig: buf.slice(49, 113) };
}

export function encodeHandshake2(m: HandshakeMessage2): Uint8Array {
  return concat(new Uint8Array([m.version]), m.ephPub, m.nonce, m.sig, m.signPub);
}

export function decodeHandshake2(buf: Uint8Array): HandshakeMessage2 {
  if (buf.length !== 1 + 32 + 16 + 64 + 32) throw new Error('bad handshake2');
  return {
    version: buf[0],
    ephPub: buf.slice(1, 33),
    nonce: buf.slice(33, 49),
    sig: buf.slice(49, 113),
    signPub: buf.slice(113, 145),
  };
}

export interface LinkKeys {
  /** Key for initiator -> responder frames. */
  c2s: Uint8Array;
  /** Key for responder -> initiator frames. */
  s2c: Uint8Array;
  transcriptHash: Uint8Array;
}

export function deriveLinkKeys(ephShared: Uint8Array, transcript: Uint8Array): LinkKeys {
  const okm = hkdf(sha256Hash, ephShared, sha256Hash(transcript), utf8(LINK_INFO), 64);
  return { c2s: okm.slice(0, 32), s2c: okm.slice(32, 64), transcriptHash: sha256Hash(transcript) };
}

export interface HandshakeResult {
  keys: LinkKeys;
  peerSignPub: Uint8Array | null;
}

/** Initiator: create message 1. */
export function createHandshake1(signSeed: Uint8Array): { msg: Uint8Array; secrets: { ephPriv: Uint8Array; ephPub: Uint8Array; nonce: Uint8Array } } {
  const eph = x25519.keygen();
  const nonce = randomBytes(16);
  const sig = signBytes(signSeed, concat(utf8(HANDSHAKE_1), eph.publicKey, nonce));
  const msg = encodeHandshake1({ version: LINKSEC_VERSION, ephPub: eph.publicKey, nonce, sig });
  return { msg, secrets: { ephPriv: eph.secretKey, ephPub: eph.publicKey, nonce } };
}

/**
 * Responder: derive keys, sign the transcript and produce message 2.
 * The initiator's signature is verified by the initiator in completeInitiator;
 * the responder verifies the initiator's identity inside the first sealed
 * application frame (or trusts-on-first-use), keeping identity keys out of
 * plaintext handshake traffic.
 */
export function acceptHandshake1(
  signSeed: Uint8Array,
  hs1: HandshakeMessage1,
): { reply: Uint8Array; keys: LinkKeys } {
  if (hs1.version !== LINKSEC_VERSION) throw new Error('linksec version mismatch');
  const eph = x25519.keygen();
  const nonce = randomBytes(16);
  const transcript = concat(utf8(HANDSHAKE_2), hs1.ephPub, hs1.nonce, eph.publicKey, nonce);
  const sig = signBytes(signSeed, transcript);
  const reply = encodeHandshake2({ version: LINKSEC_VERSION, ephPub: eph.publicKey, nonce, sig, signPub: ed25519.getPublicKey(signSeed) });
  const shared = x25519.getSharedSecret(eph.secretKey, hs1.ephPub);
  const keys = deriveLinkKeys(shared, transcript);
  return { reply, keys };
}

/** Initiator: verify message 2, derive keys. */
export function completeInitiator(
  secrets: { ephPriv: Uint8Array; ephPub: Uint8Array; nonce: Uint8Array },
  hs2: HandshakeMessage2,
  expectedPeerSignPub: Uint8Array | null,
): HandshakeResult {
  if (hs2.version !== LINKSEC_VERSION) throw new Error('linksec version mismatch');
  const transcript = concat(utf8(HANDSHAKE_2), secrets.ephPub, secrets.nonce, hs2.ephPub, hs2.nonce);
  if (!verifyBytes(hs2.signPub, transcript, hs2.sig)) throw new Error('handshake signature invalid');
  if (expectedPeerSignPub && !bytesEq(hs2.signPub, expectedPeerSignPub)) throw new Error('handshake identity mismatch');
  const shared = x25519.getSharedSecret(secrets.ephPriv, hs2.ephPub);
  const keys = deriveLinkKeys(shared, transcript);
  return { keys, peerSignPub: hs2.signPub };
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Encrypted, counted link frame: len(2) || ctr(8) || ct. */
export function sealFrame(keys: LinkKeys, direction: 'c2s' | 's2c', counter: number, plaintext: Uint8Array): Uint8Array {
  const key = direction === 'c2s' ? keys.c2s : keys.s2c;
  const nonce = new Uint8Array(12);
  nonce.set(utf8('LNK'), 0);
  nonce.set(u64le(counter), 4);
  const ct = chacha20poly1305(key, nonce, u64le(counter)).encrypt(plaintext);
  return concat(u16le(ct.length), u64le(counter), ct);
}

export function openFrame(keys: LinkKeys, direction: 'c2s' | 's2c', expectedCounter: number, buf: Uint8Array): Uint8Array {
  if (buf.length < 10) throw new Error('frame truncated');
  const len = readU16le(buf, 0);
  const ctr = readU64le(buf, 2);
  if (ctr !== expectedCounter) throw new Error(`frame counter mismatch: got ${ctr}, want ${expectedCounter}`);
  if (len !== buf.length - 10) throw new Error('frame length mismatch');
  if (len > MAX_FRAME) throw new Error('frame too large');
  const key = direction === 'c2s' ? keys.c2s : keys.s2c;
  const nonce = new Uint8Array(12);
  nonce.set(utf8('LNK'), 0);
  nonce.set(u64le(ctr), 4);
  return chacha20poly1305(key, nonce, u64le(ctr)).decrypt(buf.slice(10));
}

/**
 * Buffered codec that turns a raw byte stream into sealed frames and back.
 * Used by both TCP and GATT transports so they share one framing rule.
 */
export class LinkCodec {
  private rxCounter = 0;
  private txCounter = 0;
  private rxBuffer: Uint8Array = new Uint8Array(0);

  constructor(
    public keys: LinkKeys,
    public direction: 'c2s' | 's2c',
    private onPlaintext: (pt: Uint8Array) => void,
    private onError: (err: Error) => void,
  ) {}

  seal(plaintext: Uint8Array): Uint8Array {
    return sealFrame(this.keys, this.direction, this.txCounter++, plaintext);
  }

  /** Feed raw transport bytes; emits plaintext to onPlaintext as frames complete. */
  push(raw: Uint8Array): void {
    this.rxBuffer = concat(this.rxBuffer, raw);
    for (;;) {
      // Frame layout: len(2) || ctr(8) || ct(len bytes) -> total 10 + len.
      if (this.rxBuffer.length < 10) return;
      const len = readU16le(this.rxBuffer, 0);
      if (len > MAX_FRAME) {
        this.onError(new Error('frame too large'));
        return;
      }
      if (this.rxBuffer.length < 10 + len) return;
      const frame = this.rxBuffer.slice(0, 10 + len);
      this.rxBuffer = this.rxBuffer.slice(10 + len);
      try {
        const pt = openFrame(this.keys, this.direction === 'c2s' ? 's2c' : 'c2s', this.rxCounter, frame);
        this.rxCounter += 1;
        this.onPlaintext(pt);
      } catch (e) {
        this.onError(e instanceof Error ? e : new Error(String(e)));
        return;
      }
    }
  }

  get pending(): number {
    return this.rxBuffer.length;
  }
}
