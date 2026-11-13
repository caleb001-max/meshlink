/**
 * MeshLink crypto — identity keys, prekey bundles, asynchronous session
 * establishment and the Double Ratchet.
 *
 * Design (full rationale in docs/DECISIONS.md ADR-004 and
 * docs/security/THREAT_MODEL.md):
 *
 *  - Identity: Ed25519 signing key + X25519 key-agreement key per device.
 *    Both are created offline; long-term private keys are held by the platform
 *    secure store (Keystore/Keychain) in the app layer, never hard-coded.
 *  - Sessions: Signal-style asynchronous X3DH against a recipient prekey
 *    bundle, followed by the Double Ratchet (forward secrecy + post-
 *    compromise security). Because a store-and-forward mesh has no live
 *    handshake, sessions start from a prekey bundle the recipient published
 *    earlier — never an interactive handshake.
 *  - Post-quantum hybrid: every session establishment encapsulates an
 *    ML-KEM-768 shared secret (FIPS 203) alongside the X25519 shared secrets,
 *    so recorded ciphertext stays safe against a future quantum attacker.
 *    Pure primitives come from the audited @noble family (MIT), pinned.
 *  - Metadata: relays never learn sender or recipient identity keys. Sender
 *    identity and message authentication live INSIDE the end-to-end encrypted
 *    payload (Ed25519 signature over the payload), verified after decryption.
 *
 * No cryptographic primitive is invented here: Ed25519/X25519 (RFC 8032/7748),
 * HKDF (RFC 5869), HMAC-SHA256 (RFC 2104), ChaCha20-Poly1305 (RFC 8439),
 * ML-KEM-768 (FIPS 203) and the X3DH/Double Ratchet constructions follow the
 * published Signal specification, adapted where noted.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519';
import { ml_kem768 } from '@noble/post-quantum/ml-kem';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hmac as hmacFn } from '@noble/hashes/hmac';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 as sha256Hash } from '@noble/hashes/sha2';
import { sha512 as sha512Hash } from '@noble/hashes/sha2';
import {
  bytesEqual,
  bytesToB64,
  bytesToHex,
  b64ToBytes,
  concat,
  ctEqual,
  hexToBytes,
  randomBytes,
  readU32le,
  u32le,
} from './bytes';

export const KEM_CT_LEN = 1088; // ML-KEM-768 ciphertext
export const KEM_PK_LEN = 1184; // ML-KEM-768 public key
export const KEM_SK_LEN = 2400; // ML-KEM-768 secret key
export const X25519_LEN = 32;
export const ED25519_SEED_LEN = 32;
export const ED25519_PUB_LEN = 32;
export const SIG_LEN = 64;

const X3DH_INFO = 'MeshLink-X3DH-v2';
const RK_INFO = 'MeshLink-Ratchet-v2';
const PAIR_INFO = 'MeshLink-Pairwise-v2';
const TAG_INFO = 'MeshLink-Tag-v2';
const CIRCLE_INFO = 'MeshLink-Circle-v2';
const SAFETY_INFO = 'MeshLink-Safety-v1';
const SPK_CONTEXT = 'MeshLink-SPK-v2';
const MAX_SKIP = 256; // bounded skipped-message-key memory per session

function assertLen(b: Uint8Array, n: number, what: string): void {
  if (b.length !== n) throw new Error(`${what} must be ${n} bytes, got ${b.length}`);
}

/** HKDF-SHA256 with the app-level defaults baked in. */
function hkdfSha256(ikm: Uint8Array, salt: Uint8Array | undefined, info: Uint8Array | undefined, length: number): Uint8Array {
  return hkdf(sha256Hash, ikm, salt, info, length);
}

// ------------------------------------------------------------------ identity

export interface Identity {
  /** Ed25519 signing seed (32 bytes). */
  signSeed: Uint8Array;
  signPub: Uint8Array;
  /** X25519 key-agreement secret (32 bytes). */
  dhPriv: Uint8Array;
  dhPub: Uint8Array;
}

export function newIdentity(): Identity {
  const sign = ed25519.keygen();
  const dh = x25519.keygen();
  return {
    signSeed: sign.secretKey,
    signPub: sign.publicKey,
    dhPriv: dh.secretKey,
    dhPub: dh.publicKey,
  };
}

export function identityToStorable(id: Identity): { signSeed: string; signPub: string; dhPriv: string; dhPub: string } {
  return {
    signSeed: bytesToHex(id.signSeed),
    signPub: bytesToHex(id.signPub),
    dhPriv: bytesToHex(id.dhPriv),
    dhPub: bytesToHex(id.dhPub),
  };
}

export function identityFromStorable(s: { signSeed: string; signPub: string; dhPriv: string; dhPub: string }): Identity {
  return {
    signSeed: hexToBytes(s.signSeed),
    signPub: hexToBytes(s.signPub),
    dhPriv: hexToBytes(s.dhPriv),
    dhPub: hexToBytes(s.dhPub),
  };
}

export function signBytes(signSeed: Uint8Array, msg: Uint8Array): Uint8Array {
  return ed25519.sign(msg, signSeed);
}

export function verifyBytes(signPub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, msg, signPub);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- prekey bundle

/** Durable bundle a paired contact publishes (Signal-style). */
export interface PrekeyBundle {
  kind: 'paired';
  dhPub: Uint8Array; // recipient X25519 identity DH public
  spk: Uint8Array; // signed prekey public
  spkSig: Uint8Array; // Ed25519 signature over SPK_CONTEXT || spk
  opk: Uint8Array | null; // one-time prekey public (optional)
  pqPk: Uint8Array; // ML-KEM-768 public key
}

/** Ephemeral bundle embedded in HELLO beacons for stranger contact. */
export interface HelloBundle {
  kind: 'hello';
  ephX: Uint8Array; // ephemeral X25519 public
  ephPq: Uint8Array; // ephemeral ML-KEM-768 public
}

export type Bundle = PrekeyBundle | HelloBundle;

/** Stable 8-byte identifier of a bundle so a session-init header can name it. */
export function bundleId(b: Bundle): Uint8Array {
  const material = b.kind === 'paired' ? concat(b.dhPub, b.spk, b.pqPk) : concat(b.ephX, b.ephPq);
  return sha256Hash(material).slice(0, 8);
}

export interface SignedPrekeySecrets {
  spkPriv: Uint8Array;
  opkPriv: Uint8Array | null;
  pqSk: Uint8Array;
}

export function makePrekeyBundle(identity: Identity): { bundle: PrekeyBundle; secrets: SignedPrekeySecrets } {
  const spk = x25519.keygen();
  const opk = x25519.keygen();
  const pq = ml_kem768.keygen();
  const bundle: PrekeyBundle = {
    kind: 'paired',
    dhPub: identity.dhPub,
    spk: spk.publicKey,
    spkSig: signBytes(identity.signSeed, concat(utf8(SPK_CONTEXT), spk.publicKey)),
    opk: opk.publicKey,
    pqPk: pq.publicKey,
  };
  return { bundle, secrets: { spkPriv: spk.secretKey, opkPriv: opk.secretKey, pqSk: pq.secretKey } };
}

export function verifyPrekeyBundle(bundle: PrekeyBundle, signPub: Uint8Array): boolean {
  if (bundle.dhPub.length !== X25519_LEN || bundle.spk.length !== X25519_LEN) return false;
  if (bundle.pqPk.length !== KEM_PK_LEN) return false;
  return verifyBytes(signPub, concat(utf8(SPK_CONTEXT), bundle.spk), bundle.spkSig);
}

export function makeHelloBundle(): { bundle: HelloBundle; secrets: { ephXPriv: Uint8Array; ephPqSk: Uint8Array } } {
  const eph = x25519.keygen();
  const pq = ml_kem768.keygen();
  return {
    bundle: { kind: 'hello', ephX: eph.publicKey, ephPq: pq.publicKey },
    secrets: { ephXPriv: eph.secretKey, ephPqSk: pq.secretKey },
  };
}

// ------------------------------------------------------------------ X3DH

/** Fields carried in a session-init message header (all public). */
export interface SessionInitHeader {
  bundleId: Uint8Array; // 8B
  dhA1: Uint8Array; // 32B public used for DH1 (identity DH or ephemeral)
  ekA: Uint8Array; // 32B ephemeral X25519 public
  /** OPK public used by the sender (32B, zeros when no OPK). */
  opkHint: Uint8Array;
  kemCt: Uint8Array; // 1088B ML-KEM ciphertext
}

export interface SessionInit {
  header: SessionInitHeader;
  sharedSecret: Uint8Array;
  /** For the initiator: which chain the recipient ratchets from. */
  recipientDhPub: Uint8Array; // DHr the recipient starts its ratchet against
}

/** Domain-separation prefix, Signal-style: 32 bytes of 0xFF then the label. */
const F = (() => {
  const f = new Uint8Array(32).fill(0xff);
  return concat(f, utf8('MeshLink'));
})();

const ZERO32 = new Uint8Array(32);

/** Sender side. `identity` signs nothing here; it only supplies DH1 for paired bundles. */
export function x3dhInitiate(identity: Identity | null, bundle: Bundle): SessionInit {
  const ek = x25519.keygen();
  const dhA1 = x25519.keygen();
  let ikm: Uint8Array;
  let recipientDhPub: Uint8Array;
  let opkHint: Uint8Array;
  if (bundle.kind === 'paired') {
    if (!identity) throw new Error('paired bundles require an identity');
    assertLen(bundle.spk, X25519_LEN, 'spk');
    const dh1 = x25519.getSharedSecret(identity.dhPriv, bundle.spk);
    const dh2 = x25519.getSharedSecret(ek.secretKey, bundle.dhPub);
    const dh3 = x25519.getSharedSecret(ek.secretKey, bundle.spk);
    const dh4 = bundle.opk ? x25519.getSharedSecret(ek.secretKey, bundle.opk) : new Uint8Array(0);
    const enc = ml_kem768.encapsulate(bundle.pqPk);
    ikm = concat(F, dh1, dh2, dh3, dh4, enc.sharedSecret);
    recipientDhPub = bundle.spk;
    opkHint = bundle.opk ?? ZERO32;
    var kemCt = enc.cipherText;
  } else {
    assertLen(bundle.ephX, X25519_LEN, 'ephX');
    const dh1 = x25519.getSharedSecret(dhA1.secretKey, bundle.ephX);
    const dh2 = x25519.getSharedSecret(ek.secretKey, bundle.ephX);
    const enc = ml_kem768.encapsulate(bundle.ephPq);
    ikm = concat(F, dh1, dh2, enc.sharedSecret);
    recipientDhPub = bundle.ephX;
    opkHint = ZERO32;
    kemCt = enc.cipherText;
  }
  const sk = hkdfSha256(ikm, new Uint8Array(32), utf8(X3DH_INFO), 32);
  return {
    header: { bundleId: bundleId(bundle), dhA1: dhA1.publicKey, ekA: ek.publicKey, opkHint, kemCt },
    sharedSecret: sk,
    recipientDhPub,
  };
}

export interface BundleSecrets {
  kind: 'paired' | 'hello';
  spkPriv?: Uint8Array;
  opkPriv?: Uint8Array | null;
  pqSk?: Uint8Array;
  ephXPriv?: Uint8Array;
  ephPqSk?: Uint8Array;
  identityDhPriv?: Uint8Array;
}

/**
 * Receiver side. The caller locates its bundle secrets by header.bundleId and
 * passes them in. Throws if the bundle is unknown (wrong/expired prekey).
 */
export function x3dhReceive(secrets: BundleSecrets, header: SessionInitHeader): { sharedSecret: Uint8Array; senderDhPub: Uint8Array } {
  assertLen(header.bundleId, 8, 'bundleId');
  assertLen(header.dhA1, X25519_LEN, 'dhA1');
  assertLen(header.ekA, X25519_LEN, 'ekA');
  assertLen(header.opkHint, X25519_LEN, 'opkHint');
  assertLen(header.kemCt, KEM_CT_LEN, 'kemCt');
  let ikm: Uint8Array;
  let senderDhPub: Uint8Array;
  if (secrets.kind === 'paired') {
    if (!secrets.spkPriv || !secrets.pqSk || !secrets.identityDhPriv) throw new Error('missing paired secrets');
    const dh1 = x25519.getSharedSecret(secrets.spkPriv, header.dhA1);
    const dh2 = x25519.getSharedSecret(secrets.identityDhPriv, header.ekA);
    const dh3 = x25519.getSharedSecret(secrets.spkPriv, header.ekA);
    const dh4 = !bytesEqAll(header.opkHint, ZERO32) && secrets.opkPriv ? x25519.getSharedSecret(secrets.opkPriv, header.ekA) : new Uint8Array(0);
    const ss = ml_kem768.decapsulate(header.kemCt, secrets.pqSk);
    ikm = concat(F, dh1, dh2, dh3, dh4, ss);
    senderDhPub = header.dhA1;
  } else {
    if (!secrets.ephXPriv || !secrets.ephPqSk) throw new Error('missing hello secrets');
    const dh1 = x25519.getSharedSecret(secrets.ephXPriv, header.dhA1);
    const dh2 = x25519.getSharedSecret(secrets.ephXPriv, header.ekA);
    const ss = ml_kem768.decapsulate(header.kemCt, secrets.ephPqSk);
    ikm = concat(F, dh1, dh2, ss);
    senderDhPub = header.ekA;
  }
  return { sharedSecret: hkdfSha256(ikm, new Uint8Array(32), utf8(X3DH_INFO), 32), senderDhPub };
}

function bytesEqAll(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ------------------------------------------------------------ Double Ratchet

function kdfRk(rk: Uint8Array, dhOut: Uint8Array): [Uint8Array, Uint8Array] {
  const okm = hkdfSha256(dhOut, rk, utf8(RK_INFO), 64);
  return [okm.slice(0, 32), okm.slice(32, 64)];
}

function kdfCk(ck: Uint8Array): [Uint8Array, Uint8Array] {
  const mk = hmacFn(sha256Hash, ck, new Uint8Array([0x01]));
  const next = hmacFn(sha256Hash, ck, new Uint8Array([0x02]));
  return [mk, next];
}

export interface RatchetState {
  dhPriv: Uint8Array;
  dhPub: Uint8Array;
  dhRemote: Uint8Array | null;
  rk: Uint8Array;
  cks: Uint8Array | null;
  ckr: Uint8Array | null;
  ns: number;
  nr: number;
  pn: number;
  /** hex "dhRemote||n" -> mk base64 */
  skipped: Record<string, string>;
}

export interface RatchetHeader {
  dh: Uint8Array; // sender's current ratchet public key
  pn: number;
  n: number;
}

export function encodeRatchetHeader(h: RatchetHeader): Uint8Array {
  return concat(h.dh, u32le(h.pn), u32le(h.n));
}

export function decodeRatchetHeader(buf: Uint8Array): RatchetHeader {
  if (buf.length !== 32 + 4 + 4) throw new Error('bad ratchet header');
  return { dh: buf.slice(0, 32), pn: readU32le(buf, 32), n: readU32le(buf, 36) };
}

export class DoubleRatchet {
  constructor(public state: RatchetState) {}

  /** Initiator side after X3DH. */
  static initAsSender(sharedSecret: Uint8Array, recipientDhPub: Uint8Array): DoubleRatchet {
    const dh = x25519.keygen();
    const [rk, cks] = kdfRk(sharedSecret, x25519.getSharedSecret(dh.secretKey, recipientDhPub));
    return new DoubleRatchet({
      dhPriv: dh.secretKey,
      dhPub: dh.publicKey,
      dhRemote: recipientDhPub,
      rk,
      cks,
      ckr: null,
      ns: 0,
      nr: 0,
      pn: 0,
      skipped: {},
    });
  }

  /** Receiver side: holds SK until the first header arrives (lazy ratchet). */
  static initAsReceiver(sharedSecret: Uint8Array, ownBundleKeyPair: { priv: Uint8Array; pub: Uint8Array }): DoubleRatchet {
    return new DoubleRatchet({
      dhPriv: ownBundleKeyPair.priv,
      dhPub: ownBundleKeyPair.pub,
      dhRemote: null,
      rk: sharedSecret,
      cks: null,
      ckr: null,
      ns: 0,
      nr: 0,
      pn: 0,
      skipped: {},
    });
  }

  serialize(): string {
    return JSON.stringify({
      dhPriv: bytesToHex(this.state.dhPriv),
      dhPub: bytesToHex(this.state.dhPub),
      dhRemote: this.state.dhRemote ? bytesToHex(this.state.dhRemote) : null,
      rk: bytesToB64(this.state.rk),
      cks: this.state.cks ? bytesToB64(this.state.cks) : null,
      ckr: this.state.ckr ? bytesToB64(this.state.ckr) : null,
      ns: this.state.ns,
      nr: this.state.nr,
      pn: this.state.pn,
      skipped: this.state.skipped,
    });
  }

  static deserialize(json: string): DoubleRatchet {
    const s = JSON.parse(json) as {
      dhPriv: string;
      dhPub: string;
      dhRemote: string | null;
      rk: string;
      cks: string | null;
      ckr: string | null;
      ns: number;
      nr: number;
      pn: number;
      skipped: Record<string, string>;
    };
    return new DoubleRatchet({
      dhPriv: hexToBytes(s.dhPriv),
      dhPub: hexToBytes(s.dhPub),
      dhRemote: s.dhRemote ? hexToBytes(s.dhRemote) : null,
      rk: b64ToBytes(s.rk),
      cks: s.cks ? b64ToBytes(s.cks) : null,
      ckr: s.ckr ? b64ToBytes(s.ckr) : null,
      ns: s.ns,
      nr: s.nr,
      pn: s.pn,
      skipped: s.skipped,
    });
  }

  /** Returns header || ciphertext. Throws if the send chain is exhausted. */
  encrypt(plaintext: Uint8Array, ad: Uint8Array): Uint8Array {
    if (!this.state.cks) throw new Error('send chain not ready');
    const [mk, next] = kdfCk(this.state.cks);
    this.state.cks = next;
    const header = encodeRatchetHeader({ dh: this.state.dhPub, pn: this.state.pn, n: this.state.ns });
    this.state.ns += 1;
    const nonce = new Uint8Array(12).fill(0);
    nonce.set(u32le(this.state.ns >>> 0), 0);
    nonce.set(u32le(1), 8);
    const ct = chacha20poly1305(mk, nonce, concat(ad, header)).encrypt(plaintext);
    return concat(header, ct);
  }

  /** Consumes header || ciphertext produced by encrypt(). */
  decrypt(wire: Uint8Array, ad: Uint8Array): Uint8Array {
    const header = decodeRatchetHeader(wire.slice(0, 40));
    const ct = wire.slice(40);
    const skKey = bytesToHex(header.dh) + '|' + header.n;
    const skippedMk = this.state.skipped[skKey];
    if (skippedMk) {
      delete this.state.skipped[skKey];
      return this.aeadOpen(skippedMk, ct, ad, header, header.n);
    }
    if (header.dh.length !== 32) throw new Error('bad header dh');
    if (!this.state.dhRemote || !bytesEqual(header.dh, this.state.dhRemote)) {
      this.skipKeys(header.pn);
      this.dhRatchet(header);
    }
    if (!this.state.ckr) throw new Error('receive chain not ready');
    this.skipKeys(header.n);
    const [mk, next] = kdfCk(this.state.ckr);
    this.state.ckr = next;
    this.state.nr += 1;
    return this.aeadOpen(bytesToB64(mk), ct, ad, header, header.n - 1);
  }

  private aeadOpen(mkB64: string, ct: Uint8Array, ad: Uint8Array, header: RatchetHeader, counter: number): Uint8Array {
    const nonce = new Uint8Array(12).fill(0);
    nonce.set(u32le(counter >>> 0), 0);
    nonce.set(u32le(1), 8);
    return chacha20poly1305(b64ToBytes(mkB64), nonce, concat(ad, encodeRatchetHeader(header))).decrypt(ct);
  }

  private skipKeys(until: number): void {
    if (!this.state.ckr) return;
    if (this.state.nr + MAX_SKIP < until) throw new Error('too many skipped messages');
    while (this.state.nr < until) {
      const [mk, next] = kdfCk(this.state.ckr);
      this.state.ckr = next;
      const key = bytesToHex(this.state.dhRemote!) + '|' + this.state.nr;
      this.state.skipped[key] = bytesToB64(mk);
      this.state.nr += 1;
    }
    // Bounded memory: drop oldest skipped keys beyond the cap.
    const keys = Object.keys(this.state.skipped);
    if (keys.length > MAX_SKIP) {
      for (const k of keys.slice(0, keys.length - MAX_SKIP)) delete this.state.skipped[k];
    }
  }

  private dhRatchet(header: RatchetHeader): void {
    this.state.pn = this.state.ns;
    this.state.ns = 0;
    this.state.nr = 0;
    this.state.dhRemote = header.dh;
    if (!this.state.ckr) {
      // First-ever receive: derive from own bundle key against sender's key.
      const [rk, ckr] = kdfRk(this.state.rk, x25519.getSharedSecret(this.state.dhPriv, header.dh));
      this.state.rk = rk;
      this.state.ckr = ckr;
    } else {
      const [rk, ckr] = kdfRk(this.state.rk, x25519.getSharedSecret(this.state.dhPriv, header.dh));
      this.state.rk = rk;
      this.state.ckr = ckr;
    }
    const dh = x25519.keygen();
    this.state.dhPriv = dh.secretKey;
    this.state.dhPub = dh.publicKey;
    const [rk2, cks] = kdfRk(this.state.rk, x25519.getSharedSecret(dh.secretKey, header.dh));
    this.state.rk = rk2;
    this.state.cks = cks;
  }
}

// ------------------------------------------------------------ session wire IO

/**
 * Encrypts a payload under an established (or newly initiated) session.
 * `ad` is envelope-level associated data that must NOT change in transit
 * (type, priority, msgId, tags — NOT hopCount/expires which relays adjust).
 * Returns { wire, sessionInit } where sessionInit is null after the first message.
 */
export function sessionEncrypt(
  ratchet: DoubleRatchet,
  plaintext: Uint8Array,
  ad: Uint8Array,
  initHeader: SessionInitHeader | null,
): { wire: Uint8Array; usedInit: boolean } {
  const body = ratchet.encrypt(plaintext, ad);
  if (initHeader) {
    const h = encodeSessionInitHeader(initHeader);
    return { wire: concat(u32le(1), h, body), usedInit: true };
  }
  return { wire: concat(u32le(0), body), usedInit: false };
}

export function encodeSessionInitHeader(h: SessionInitHeader): Uint8Array {
  assertLen(h.bundleId, 8, 'bundleId');
  assertLen(h.dhA1, X25519_LEN, 'dhA1');
  assertLen(h.ekA, X25519_LEN, 'ekA');
  assertLen(h.opkHint, X25519_LEN, 'opkHint');
  assertLen(h.kemCt, KEM_CT_LEN, 'kemCt');
  return concat(h.bundleId, h.dhA1, h.ekA, h.opkHint, h.kemCt);
}

export function decodeSessionInitHeader(buf: Uint8Array): SessionInitHeader {
  if (buf.length !== 8 + 32 + 32 + 32 + KEM_CT_LEN) throw new Error('bad session-init header');
  return {
    bundleId: buf.slice(0, 8),
    dhA1: buf.slice(8, 40),
    ekA: buf.slice(40, 72),
    opkHint: buf.slice(72, 104),
    kemCt: buf.slice(104, 104 + KEM_CT_LEN),
  };
}

export function decodeSessionWire(wire: Uint8Array): { isInit: boolean; init: SessionInitHeader | null; body: Uint8Array } {
  if (wire.length < 4) throw new Error('bad session wire');
  const isInit = readU32le(wire, 0) === 1;
  if (isInit) {
    const headerLen = 8 + 32 + 32 + 32 + KEM_CT_LEN;
    const init = decodeSessionInitHeader(wire.slice(4, 4 + headerLen));
    return { isInit, init, body: wire.slice(4 + headerLen) };
  }
  return { isInit: false, init: null, body: wire.slice(4) };
}

// --------------------------------------------------- pairwise secrets and tags

/** EPOCH_SECS: pseudonymous routing tags rotate on this cadence. */
export const EPOCH_SECS = 600;

export function currentEpoch(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / EPOCH_SECS);
}

export function pairwiseSecret(identity: Identity, contactDhPub: Uint8Array): Uint8Array {
  const dh = x25519.getSharedSecret(identity.dhPriv, contactDhPub);
  return hkdfSha256(dh, new Uint8Array(32), utf8(PAIR_INFO), 32);
}

/**
 * Pseudonymous per-epoch routing tag shared by exactly two devices. Both
 * sides derive the same tag, so each maps tag -> contact privately. Relays
 * see only an opaque value that changes every EPOCH_SECS.
 * Skew tolerance: the caller should try epochs [e-1, e, e+1].
 */
export function epochTag(pairwise: Uint8Array, epoch: number): Uint8Array {
  return hmacFn(sha256Hash, pairwise, concat(utf8(TAG_INFO), u32le(epoch >>> 0))).slice(0, 8);
}

export function tagsForNow(pairwise: Uint8Array, nowMs = Date.now()): Uint8Array[] {
  const e = currentEpoch(nowMs);
  return [epochTag(pairwise, e - 1), epochTag(pairwise, e), epochTag(pairwise, e + 1)];
}

/** Trust-circle control MAC: relays verify membership without learning who. */
export function circleMac(circleKey: Uint8Array, epoch: number, body: Uint8Array): Uint8Array {
  const key = hkdfSha256(circleKey, u32le(epoch >>> 0), utf8(CIRCLE_INFO), 32);
  return hmacFn(sha256Hash, key, body).slice(0, 8);
}

export function verifyCircleMac(circleKeys: Uint8Array[], epoch: number, body: Uint8Array, mac: Uint8Array): boolean {
  for (const k of circleKeys) {
    if (ctEqual(circleMac(k, epoch, body), mac)) return true;
  }
  return false;
}

/** Human-verifiable safety number (30 digits, 6 groups of 5). */
export function safetyNumber(a: Uint8Array, b: Uint8Array): string {
  assertLen(a, ED25519_PUB_LEN, 'identity A');
  assertLen(b, ED25519_PUB_LEN, 'identity B');
  const [lo, hi] = lexicographicallyLess(a, b) ? [a, b] : [b, a];
  const digest = sha512Hash(concat(utf8(SAFETY_INFO), lo, hi));
  const groups: string[] = [];
  for (let i = 0; i < 6; i++) {
    const v = readU32le(digest, i * 4) % 100000;
    groups.push(String(v).padStart(5, '0'));
  }
  return groups.join(' ');
}

function lexicographicallyLess(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

// ----------------------------------------------------------------- AEAD glue

export function aeadEncrypt(key: Uint8Array, plaintext: Uint8Array, ad: Uint8Array, nonce: Uint8Array): Uint8Array {
  return chacha20poly1305(key, nonce, ad).encrypt(plaintext);
}

export function aeadDecrypt(key: Uint8Array, ct: Uint8Array, ad: Uint8Array, nonce: Uint8Array): Uint8Array {
  return chacha20poly1305(key, nonce, ad).decrypt(ct);
}

/** Deterministic subkeys from any high-entropy seed material. */
export function deriveKey(master: Uint8Array, info: string, len = 32): Uint8Array {
  return hkdfSha256(master, new Uint8Array(32), utf8(info), len);
}

export function sha256Bytes(...parts: Uint8Array[]): Uint8Array {
  return sha256Hash(concat(...parts));
}

export function sha512Bytes(...parts: Uint8Array[]): Uint8Array {
  return sha512Hash(concat(...parts));
}

export { bytesEqual, bytesToB64, bytesToHex, b64ToBytes, hexToBytes, randomBytes };

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
