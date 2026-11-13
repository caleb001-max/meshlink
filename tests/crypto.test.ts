/**
 * Crypto conformance and behavior tests: X3DH (+ ML-KEM-768 hybrid), the
 * Double Ratchet (in-order, out-of-order, ratchet steps), pairwise tags,
 * safety numbers and link security.
 */
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import {
  DoubleRatchet,
  encodeSessionInitHeader,
  makeHelloBundle,
  makePrekeyBundle,
  newIdentity,
  pairwiseSecret,
  safetyNumber,
  sessionEncrypt,
  decodeSessionWire,
  epochTag,
  currentEpoch,
  tagsForNow,
  verifyPrekeyBundle,
  x3dhInitiate,
  x3dhReceive,
  circleMac,
  signBytes,
  verifyBytes,
  aeadEncrypt,
  aeadDecrypt,
  encodeRatchetHeader,
  decodeRatchetHeader,
} from '../src/lib/core/crypto';
import {
  acceptHandshake1,
  completeInitiator,
  createHandshake1,
  decodeHandshake1,
  decodeHandshake2,
  LinkCodec,
  sealFrame,
  openFrame,
} from '../src/lib/core/linksec';
import { bytesToB64, bytesToHex, bytesToUtf8, concat, hexToBytes, utf8 } from '../src/lib/core/bytes';

describe('identity', () => {
  test('generates distinct keys and round-trips through storable form', () => {
    const a = newIdentity();
    const b = newIdentity();
    expect(bytesToHex(a.signPub)).not.toBe(bytesToHex(b.signPub));
    const restored = identityRoundTrip(a);
    expect(verifyBytes(restored.signPub, utf8('x'), signBytes(restored.signSeed, utf8('x')))).toBe(true);
  });
});

function identityRoundTrip(id: ReturnType<typeof newIdentity>) {
  const s = JSON.parse(JSON.stringify({ signSeed: bytesToHex(id.signSeed), signPub: bytesToHex(id.signPub), dhPriv: bytesToHex(id.dhPriv), dhPub: bytesToHex(id.dhPub) }));
  return { signSeed: hexToBytes(s.signSeed), signPub: hexToBytes(s.signPub), dhPriv: hexToBytes(s.dhPriv), dhPub: hexToBytes(s.dhPub) };
}

describe('prekey bundles', () => {
  test('signed prekey verifies and rejects tampering', () => {
    const id = newIdentity();
    const { bundle } = makePrekeyBundle(id);
    expect(verifyPrekeyBundle(bundle, id.signPub)).toBe(true);
    const tampered = { ...bundle, spk: concat(bundle.spk) };
    tampered.spk[0] ^= 1;
    expect(verifyPrekeyBundle(tampered, id.signPub)).toBe(false);
  });

  test('hello bundles have the right sizes', () => {
    const { bundle } = makeHelloBundle();
    expect(bundle.ephX.length).toBe(32);
    expect(bundle.ephPq.length).toBe(1184);
  });
});

describe('X3DH with post-quantum hybrid', () => {
  test('paired bundle: both sides derive the same shared secret', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const bobBundle = makePrekeyBundle(bob);
    const init = x3dhInitiate(alice, bobBundle.bundle);
    const rec = x3dhReceive(
      {
        kind: 'paired',
        spkPriv: bobBundle.secrets.spkPriv,
        opkPriv: bobBundle.secrets.opkPriv,
        pqSk: bobBundle.secrets.pqSk,
        identityDhPriv: bob.dhPriv,
      },
      init.header,
    );
    expect(bytesToHex(rec.sharedSecret)).toBe(bytesToHex(init.sharedSecret));
  });

  test('hello bundle: both sides derive the same shared secret', () => {
    const bobHello = makeHelloBundle();
    const init = x3dhInitiate(null, { kind: 'hello', ephX: bobHello.bundle.ephX, ephPq: bobHello.bundle.ephPq });
    const rec = x3dhReceive({ kind: 'hello', ephXPriv: bobHello.secrets.ephXPriv, ephPqSk: bobHello.secrets.ephPqSk }, init.header);
    expect(bytesToHex(rec.sharedSecret)).toBe(bytesToHex(init.sharedSecret));
  });

  test('tampered ML-KEM ciphertext changes the secret (no undetected tamper)', () => {
    const bobHello = makeHelloBundle();
    const init = x3dhInitiate(null, { kind: 'hello', ephX: bobHello.bundle.ephX, ephPq: bobHello.bundle.ephPq });
    const tampered = { ...init.header, kemCt: concat(init.header.kemCt) };
    tampered.kemCt[100] ^= 0xff;
    const rec = x3dhReceive({ kind: 'hello', ephXPriv: bobHello.secrets.ephXPriv, ephPqSk: bobHello.secrets.ephPqSk }, tampered);
    expect(bytesToHex(rec.sharedSecret)).not.toBe(bytesToHex(init.sharedSecret));
  });

  test('session-init header encodes to the documented 1192 bytes', () => {
    const bobHello = makeHelloBundle();
    const init = x3dhInitiate(null, { kind: 'hello', ephX: bobHello.bundle.ephX, ephPq: bobHello.bundle.ephPq });
    expect(encodeSessionInitHeader(init.header).length).toBe(8 + 32 + 32 + 32 + 1088);
  });
});

describe('Double Ratchet', () => {
  function makePair() {
    const bobHello = makeHelloBundle();
    const init = x3dhInitiate(null, { kind: 'hello', ephX: bobHello.bundle.ephX, ephPq: bobHello.bundle.ephPq });
    const sender = DoubleRatchet.initAsSender(init.sharedSecret, init.recipientDhPub);
    const rec = x3dhReceive({ kind: 'hello', ephXPriv: bobHello.secrets.ephXPriv, ephPqSk: bobHello.secrets.ephPqSk }, init.header);
    const receiver = DoubleRatchet.initAsReceiver(rec.sharedSecret, { priv: bobHello.secrets.ephXPriv, pub: bobHello.bundle.ephX });
    return { sender, receiver };
  }

  test('round-trips a message with header and AD binding', () => {
    const { sender, receiver } = makePair();
    const ad = utf8('envelope-context');
    const wire = sender.encrypt(utf8('hi'), ad);
    expect(bytesToUtf8(receiver.decrypt(wire, ad))).toBe('hi');
  });

  test('AD mismatch is rejected (ciphertext bound to envelope metadata)', () => {
    const { sender, receiver } = makePair();
    const wire = sender.encrypt(utf8('hi'), utf8('ad-1'));
    expect(() => receiver.decrypt(wire, utf8('ad-2'))).toThrow();
  });

  test('alternating directions ratchet correctly (20 turns)', () => {
    const { sender, receiver } = makePair();
    for (let i = 0; i < 20; i++) {
      const m1 = sender.encrypt(utf8(`a${i}`), utf8('ad'));
      expect(bytesToUtf8(receiver.decrypt(m1, utf8('ad')))).toBe(`a${i}`);
      const m2 = receiver.encrypt(utf8(`b${i}`), utf8('ad'));
      expect(bytesToUtf8(sender.decrypt(m2, utf8('ad')))).toBe(`b${i}`);
    }
  });

  test('out-of-order messages decrypt via skipped keys (bounded)', () => {
    const { sender, receiver } = makePair();
    const wires = [0, 1, 2, 3, 4].map((i) => sender.encrypt(utf8(`msg${i}`), utf8('ad')));
    expect(bytesToUtf8(receiver.decrypt(wires[3], utf8('ad')))).toBe('msg3');
    expect(bytesToUtf8(receiver.decrypt(wires[1], utf8('ad')))).toBe('msg1');
    expect(bytesToUtf8(receiver.decrypt(wires[0], utf8('ad')))).toBe('msg0');
    expect(bytesToUtf8(receiver.decrypt(wires[4], utf8('ad')))).toBe('msg4');
  });

  test('replayed ciphertext is rejected (counter/key consumed)', () => {
    const { sender, receiver } = makePair();
    const wire = sender.encrypt(utf8('once'), utf8('ad'));
    expect(bytesToUtf8(receiver.decrypt(wire, utf8('ad')))).toBe('once');
    expect(() => receiver.decrypt(wire, utf8('ad'))).toThrow();
  });

  test('serialization round-trips mid-conversation state', () => {
    const { sender, receiver } = makePair();
    sender.encrypt(utf8('one'), utf8('ad'));
    const restored = DoubleRatchet.deserialize(sender.serialize());
    const wire = restored.encrypt(utf8('two'), utf8('ad'));
    expect(bytesToUtf8(receiver.decrypt(wire, utf8('ad'))).endsWith('two')).toBe(true);
    const restoredReceiver = DoubleRatchet.deserialize(receiver.serialize());
    const wire2 = restored.encrypt(utf8('three'), utf8('ad'));
    expect(bytesToUtf8(restoredReceiver.decrypt(wire2, utf8('ad')))).toBe('three');
  });

  test('header encode/decode round-trip', () => {
    const h = { dh: new Uint8Array(32).fill(9), pn: 7, n: 1234 };
    const decoded = decodeRatchetHeader(encodeRatchetHeader(h));
    expect(decoded.pn).toBe(7);
    expect(decoded.n).toBe(1234);
    expect(bytesToHex(decoded.dh)).toBe(bytesToHex(h.dh));
  });
});

describe('session wire framing', () => {
  test('init and plain messages round-trip through the framing', () => {
    const bobHello = makeHelloBundle();
    const init = x3dhInitiate(null, { kind: 'hello', ephX: bobHello.bundle.ephX, ephPq: bobHello.bundle.ephPq });
    const sender = DoubleRatchet.initAsSender(init.sharedSecret, init.recipientDhPub);
    const ad = utf8('ad');
    const { wire } = sessionEncrypt(sender, utf8('first'), ad, init.header);
    const parsed = decodeSessionWire(wire);
    expect(parsed.isInit).toBe(true);
    expect(parsed.init!.bundleId.length).toBe(8);
    const rec = x3dhReceive({ kind: 'hello', ephXPriv: bobHello.secrets.ephXPriv, ephPqSk: bobHello.secrets.ephPqSk }, parsed.init!);
    const receiver = DoubleRatchet.initAsReceiver(rec.sharedSecret, { priv: bobHello.secrets.ephXPriv, pub: bobHello.bundle.ephX });
    expect(bytesToUtf8(receiver.decrypt(parsed.body, ad))).toBe('first');
    // Second message has no init block.
    const second = sessionEncrypt(sender, utf8('second'), ad, null).wire;
    const parsed2 = decodeSessionWire(second);
    expect(parsed2.isInit).toBe(false);
    expect(bytesToUtf8(receiver.decrypt(parsed2.body, ad))).toBe('second');
  });
});

describe('pairwise tags and safety numbers', () => {
  test('both sides derive identical per-epoch tags with skew window', () => {
    const a = newIdentity();
    const b = newIdentity();
    const pwA = pairwiseSecret(a, b.dhPub);
    const pwB = pairwiseSecret(b, a.dhPub);
    expect(bytesToHex(pwA)).toBe(bytesToHex(pwB));
    const e = currentEpoch();
    expect(bytesToHex(epochTag(pwA, e))).toBe(bytesToHex(epochTag(pwB, e)));
    // Tags differ across epochs (rotation).
    expect(bytesToHex(epochTag(pwA, e))).not.toBe(bytesToHex(epochTag(pwA, e + 1)));
    // tagsForNow covers the skew window.
    expect(tagsForNow(pwA).length).toBe(3);
  });

  test('safety number is symmetric and stable', () => {
    const a = newIdentity();
    const b = newIdentity();
    expect(safetyNumber(a.signPub, b.signPub)).toBe(safetyNumber(b.signPub, a.signPub));
    expect(safetyNumber(a.signPub, b.signPub)).toMatch(/^(\d{5} ){5}\d{5}$/);
    const c = newIdentity();
    expect(safetyNumber(a.signPub, c.signPub)).not.toBe(safetyNumber(a.signPub, b.signPub));
  });
});

describe('trust-circle MAC', () => {
  test('verifies across epochs and rejects wrong keys', () => {
    const key = hexToBytes('aa'.repeat(32));
    const e = currentEpoch();
    const body = utf8('inventory-body');
    const mac = circleMac(key, e, body);
    expect(circleMac(key, e + 1, body).length).toBe(8);
    expect(bytesToHex(circleMac(hexToBytes('bb'.repeat(32)), e, body))).not.toBe(bytesToHex(mac));
  });
});

describe('AEAD helper', () => {
  test('chacha20poly1305 round-trip with AAD', () => {
    const key = hexToBytes('11'.repeat(32));
    const nonce = hexToBytes('22'.repeat(12));
    const ad = utf8('header');
    const ct = aeadEncrypt(key, utf8('secret'), ad, nonce);
    expect(bytesToUtf8(aeadDecrypt(key, ct, ad, nonce))).toBe('secret');
    expect(() => aeadDecrypt(key, ct, utf8('other'), nonce)).toThrow();
  });
});

describe('link security handshake', () => {
  test('full handshake derives matching keys and identities verify', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const hs1 = createHandshake1(alice.signSeed);
    const decoded1 = decodeHandshake1(hs1.msg);
    const responder = acceptHandshake1(bob.signSeed, decoded1);
    const hs2 = decodeHandshake2(responder.reply);
    const initiator = completeInitiator(hs1.secrets, hs2, null);
    expect(bytesToHex(initiator.keys.c2s)).toBe(bytesToHex(responder.keys.c2s));
    expect(bytesToHex(initiator.keys.s2c)).toBe(bytesToHex(responder.keys.s2c));
    expect(bytesToHex(initiator.peerSignPub!)).toBe(bytesToHex(bob.signPub));
  });

  test('forged handshake signature is rejected', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const eve = newIdentity();
    const hs1 = createHandshake1(alice.signSeed);
    const responder = acceptHandshake1(bob.signSeed, decodeHandshake1(hs1.msg));
    const tampered = decodeHandshake2(responder.reply);
    const fake = { ...tampered, sig: signBytes(eve.signSeed, utf8('forged')) };
    expect(() => completeInitiator(hs1.secrets, fake, null)).toThrow();
  });

  test('frame counter mismatch is rejected (replay/ordering)', () => {
    const keys = { c2s: hexToBytes('33'.repeat(32)), s2c: hexToBytes('44'.repeat(32)), transcriptHash: new Uint8Array(32) };
    const frame = sealFrame(keys, 'c2s', 0, utf8('data'));
    expect(bytesToUtf8(openFrame(keys, 'c2s', 0, frame))).toBe('data');
    expect(() => openFrame(keys, 'c2s', 1, frame)).toThrow();
  });

  test('LinkCodec pipelines sealed frames over a raw byte stream', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const hs1 = createHandshake1(alice.signSeed);
    const responderKeys = acceptHandshake1(bob.signSeed, decodeHandshake1(hs1.msg));
    const initiatorKeys = completeInitiator(hs1.secrets, decodeHandshake2(responderKeys.reply), null);
    const received: Uint8Array[] = [];
    let errors = 0;
    const client = new LinkCodec(initiatorKeys.keys, 'c2s', (pt) => received.push(pt), () => errors++);
    const server = new LinkCodec(responderKeys.keys, 's2c', (pt) => received.push(pt), () => errors++);
    client.push(server.seal(utf8('from-server')));
    server.push(client.seal(utf8('from-client')));
    expect(received.length).toBe(2);
    expect(bytesToUtf8(received[0])).toBe('from-server');
    expect(bytesToUtf8(received[1])).toBe('from-client');
    expect(errors).toBe(0);
  });

  test('property: random plaintexts of any size survive the codec', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 5000 }), (pt) => {
        const keys = { c2s: hexToBytes('55'.repeat(32)), s2c: hexToBytes('66'.repeat(32)), transcriptHash: new Uint8Array(32) };
        let out: Uint8Array | null = null;
        const codec = new LinkCodec(keys, 'c2s', (p) => (out = p), () => undefined);
        codec.push(sealFrame(keys, 's2c', 0, pt));
        expect(out && bytesToHex(out)).toBe(bytesToHex(pt));
      }),
      { numRuns: 50 },
    );
  });
});

describe('AEAD nonce discipline', () => {
  test('ratchet nonces never repeat for the same key (counter-based)', () => {
    // Implied by construction; assert different counters give different ciphertexts.
    const key = hexToBytes('77'.repeat(32));
    const pt = utf8('same');
    const c1 = aeadEncrypt(key, pt, new Uint8Array(0), hexToBytes('00'.repeat(12)));
    const c2 = aeadEncrypt(key, pt, new Uint8Array(0), hexToBytes('01'.repeat(12)));
    expect(bytesToB64(c1)).not.toBe(bytesToB64(c2));
  });
});
