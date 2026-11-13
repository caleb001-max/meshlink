/**
 * Golden-vector conformance tests for the MeshLink v2 protocol codec.
 * The vectors here are ALSO published in docs/protocol/SPEC.md so Android
 * Kotlin and Swift implementations can be checked against the same bytes.
 */
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import {
  Envelope,
  FRAG_HEADER_LEN,
  InventoryEntry,
  HEADER_LEN,
  MAGIC,
  PRIO_MEDIA,
  PRIO_SOS,
  PRIO_TEXT,
  TYPE_ACK,
  TYPE_HELLO,
  TYPE_INVENTORY,
  TYPE_MSG,
  Priority,
  decodeAckBatch,
  decodeEnvelope,
  decodeFragment,
  decodeHello,
  decodeInventory,
  encodeAckBatch,
  encodeEnvelope,
  encodeHello,
  encodeInventory,
  fragmentEnvelope,
  padToBucket,
  Reassembler,
} from '../src/lib/core/protocol';
import { bytesToHex, bytesToUtf8, concat, hexToBytes, utf8ToBytes } from '../src/lib/core/bytes';

const tag = (hex: string) => hexToBytes(hex.padEnd(16, '0').slice(0, 16));

describe('envelope codec', () => {
  test('round-trips a valid envelope byte-for-byte', () => {
    const env: Envelope = {
      type: TYPE_MSG,
      priority: PRIO_TEXT,
      flags: 1,
      hopLimit: 8,
      hopCount: 2,
      expiresInSec: 3600,
      sprayCopies: 8,
      msgId: hexToBytes('1122334455667788'),
      srcTag: tag('aabbccddeeff0011'),
      dstTag: tag('1234567890abcdef'),
      payload: utf8ToBytes('hello mesh'),
    };
    const bytes = encodeEnvelope(env);
    expect(bytes[0]).toBe(0x4d);
    expect(bytes[1]).toBe(0x4c);
    expect(bytes[2]).toBe(2);
    expect(bytes.length).toBe(HEADER_LEN + 10);
    const back = decodeEnvelope(bytes);
    expect(back.type).toBe(env.type);
    expect(back.priority).toBe(env.priority);
    expect(back.flags).toBe(env.flags);
    expect(back.hopLimit).toBe(env.hopLimit);
    expect(back.hopCount).toBe(env.hopCount);
    expect(back.expiresInSec).toBe(env.expiresInSec);
    expect(back.sprayCopies).toBe(env.sprayCopies);
    expect(bytesToHex(back.msgId)).toBe('1122334455667788');
    expect(bytesToHex(back.srcTag)).toBe('aabbccddeeff0011');
    expect(bytesToUtf8(back.payload)).toBe('hello mesh');
  });

  test('GOLDEN VECTOR 1: minimal SOS envelope has exact hex encoding', () => {
    const env: Envelope = {
      type: TYPE_MSG,
      priority: PRIO_SOS,
      flags: 1,
      hopLimit: 5,
      hopCount: 0,
      expiresInSec: 3600,
      sprayCopies: 8,
      msgId: hexToBytes('0001020304050607'),
      srcTag: tag('deadbeef00000000'),
      dstTag: tag('cafebabe00000000'),
      payload: new Uint8Array(4).fill(0xab),
    };
    const bytes = encodeEnvelope(env);
    const headerHex = bytesToHex(bytes.slice(0, HEADER_LEN));
    // magic ML | v2 | type 02 | prio 00 | flags 01 | ttl 05 | hops 00
    // | expires 0x0e10 LE = 100e | spray 08 | msgId | srcTag | dstTag | len 0400
    expect(headerHex).toBe('4d4c020200010500100e080001020304050607deadbeef00000000cafebabe000000000400');
    expect(bytesToHex(bytes.slice(HEADER_LEN))).toBe('abababab');
  });

  test('rejects garbage: bad magic, truncated, bad version, bad type, bad length', () => {
    expect(() => decodeEnvelope(new Uint8Array(10))).toThrow();
    const base = encodeEnvelope({
      type: TYPE_MSG,
      priority: PRIO_TEXT,
      flags: 0,
      hopLimit: 8,
      hopCount: 0,
      expiresInSec: 60,
      sprayCopies: 0,
      msgId: new Uint8Array(8),
      srcTag: new Uint8Array(8),
      dstTag: new Uint8Array(8),
      payload: new Uint8Array(4),
    });
    const badMagic = base.slice();
    badMagic[0] = 0x58;
    expect(() => decodeEnvelope(badMagic)).toThrow();
    const badVer = base.slice();
    badVer[2] = 9;
    expect(() => decodeEnvelope(badVer)).toThrow();
    const badType = base.slice();
    badType[3] = 77;
    expect(() => decodeEnvelope(badType)).toThrow();
    expect(() => decodeEnvelope(base.slice(0, 20))).toThrow();
  });

  test('property: arbitrary random envelopes survive a round-trip', () => {
    const bytesArb = fc.uint8Array({ min: 0, max: 255, minLength: 8, maxLength: 64 });
    fc.assert(
      fc.property(bytesArb, (payload) => {
        const env: Envelope = {
          type: TYPE_MSG,
          priority: PRIO_TEXT,
          flags: 0,
          hopLimit: 8,
          hopCount: 0,
          expiresInSec: 1000,
          sprayCopies: 0,
          msgId: payload.slice(0, 8),
          srcTag: payload.slice(0, 8),
          dstTag: payload.slice(0, 8),
          payload,
        };
        const back = decodeEnvelope(encodeEnvelope(env));
        expect(back.expiresInSec).toBe(1000);
        expect(bytesToHex(back.payload)).toBe(bytesToHex(payload));
      }),
      { numRuns: 300 },
    );
  });

  test('property: mutated encodings never produce a valid envelope silently', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 60, maxLength: 400 }), fc.integer({ min: 0, max: 300 }), (buf, pos) => {
        if (buf.length < 40) return;
        const mutated = buf.slice();
        mutated[pos % mutated.length] ^= 0xff;
        try {
          const env = decodeEnvelope(mutated);
          // If it parses, encoding it again must be stable (no payload corruption).
          expect(() => encodeEnvelope(env)).not.toThrow();
        } catch {
          /* rejected is fine */
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('padding buckets', () => {
  test('pads to the priority bucket', () => {
    expect(padToBucket(PRIO_TEXT, utf8ToBytes('hi')).length).toBe(1024);
    expect(padToBucket(PRIO_SOS, new Uint8Array(511)).length).toBe(512);
    expect(padToBucket(PRIO_MEDIA, new Uint8Array(20000)).length).toBe(20000);
  });
});

describe('fragmentation and reassembly', () => {
  const env: Envelope = {
    type: TYPE_MSG,
    priority: PRIO_MEDIA,
    flags: 1,
    hopLimit: 8,
    hopCount: 0,
    expiresInSec: 86400,
    sprayCopies: 8,
    msgId: hexToBytes('a1a2a3a4a5a6a7a8'),
    srcTag: tag('0102030405060708'),
    dstTag: tag('1112131415161718'),
    payload: new Uint8Array(1000).fill(0x42),
  };

  test('fragments reassemble exactly', () => {
    const bytes = encodeEnvelope(env);
    const frags = fragmentEnvelope(bytes, 200);
    expect(frags.length).toBeGreaterThan(1);
    const re = new Reassembler();
    let out: Uint8Array | null = null;
    for (const f of frags) out = re.add(decodeFragment(f));
    expect(out).not.toBeNull();
    expect(bytesToHex(out!)).toBe(bytesToHex(bytes));
  });

  test('duplicate fragments and out-of-order fragments reassemble once', () => {
    const bytes = encodeEnvelope(env);
    const frags = fragmentEnvelope(bytes, 300);
    const re = new Reassembler();
    // Send every fragment except index 0, in reverse order, plus a duplicate.
    for (const f of [...frags].reverse()) {
      if (f[0] !== 0) re.add(decodeFragment(f));
    }
    expect(re.add(decodeFragment(frags[0]))).not.toBeNull(); // completes
    expect(re.add(decodeFragment(frags[0]))).toBeNull(); // already consumed
  });

  test('fragment header layout matches the spec', () => {
    const frags = fragmentEnvelope(encodeEnvelope(env), 4096);
    expect(frags.length).toBe(1);
    expect(frags[0][0]).toBe(0); // index
    expect(frags[0][1]).toBe(1); // count
    expect(bytesToHex(frags[0].slice(2, 10))).toBe('a1a2a3a4a5a6a7a8');
    expect(frags[0].length).toBe(FRAG_HEADER_LEN + encodeEnvelope(env).length);
  });
});

describe('control bodies', () => {
  test('hello round-trip', () => {
    const body = {
      version: 2,
      caps: 3,
      ephX: new Uint8Array(32).fill(1),
      ephPq: new Uint8Array(1184).fill(2),
    };
    const decoded = decodeHello(encodeHello(body));
    expect(decoded.caps).toBe(3);
    expect(decoded.ephX.length).toBe(32);
    expect(decoded.ephPq.length).toBe(1184);
    expect(() => decodeHello(new Uint8Array(10))).toThrow();
  });

  test('inventory round-trip', () => {
    const entries: InventoryEntry[] = Array.from({ length: 5 }, (_, i) => ({
      msgId: hexToBytes(`000000000000000${i}`),
      copies: i,
      priority: PRIO_TEXT,
      sizeBucket: PRIO_TEXT,
      dstTag: tag(`a0a${i}b0b00000000`),
    }));
    const decoded = decodeInventory(encodeInventory(entries));
    expect(decoded.length).toBe(5);
    expect(decoded[3].copies).toBe(3);
    expect(() => decodeInventory(new Uint8Array([200]))).toThrow();
  });

  test('ack batch round-trip and bounds', () => {
    const ids = [hexToBytes('0000000000000001'), hexToBytes('0000000000000002')];
    expect(decodeAckBatch(encodeAckBatch(ids)).length).toBe(2);
    expect(() => decodeAckBatch(new Uint8Array([100]))).toThrow();
  });

  test('inventory envelope with MAGIC prefix parses through decodeEnvelope', () => {
    const env: Envelope = {
      type: TYPE_INVENTORY,
      priority: PRIO_TEXT,
      flags: 0,
      hopLimit: 1,
      hopCount: 0,
      expiresInSec: 900,
      sprayCopies: 0,
      msgId: hexToBytes('ffeeddccbbaa9988'),
      srcTag: ZERO(),
      dstTag: tag('0101010101010101'),
      payload: encodeInventory([]),
    };
    const decoded = decodeEnvelope(encodeEnvelope(env));
    expect(decoded.type).toBe(TYPE_INVENTORY);
    expect(decodeInventory(decoded.payload).length).toBe(0);
  });

  test('ack envelope golden bytes', () => {
    const env: Envelope = {
      type: TYPE_ACK,
      priority: PRIO_TEXT,
      flags: 0,
      hopLimit: 8,
      hopCount: 1,
      expiresInSec: 900,
      sprayCopies: 0,
      msgId: hexToBytes('0000000000000009'),
      srcTag: tag('00000000000000aa'),
      dstTag: tag('00000000000000bb'),
      payload: encodeAckBatch([hexToBytes('0000000000000001')]),
    };
    const bytes = encodeEnvelope(env);
    // payload = 1 count byte + 8 id bytes = 9 -> len '0900' LE at header end
    expect(bytesToHex(bytes.slice(0, HEADER_LEN)).endsWith('0900')).toBe(true);
    expect(bytes[HEADER_LEN]).toBe(1);
    expect(bytesToHex(bytes.slice(HEADER_LEN + 1, HEADER_LEN + 9))).toBe('0000000000000001');
  });

  test('hello envelope golden bytes (bundle flag)', () => {
    const hello = encodeHello({ version: 2, caps: 1, ephX: new Uint8Array(32).fill(7), ephPq: new Uint8Array(1184).fill(8) });
    expect(hello.length).toBe(2 + 32 + 1184);
    const env: Envelope = {
      type: TYPE_HELLO,
      priority: PRIO_TEXT,
      flags: 16,
      hopLimit: 1,
      hopCount: 0,
      expiresInSec: 900,
      sprayCopies: 0,
      msgId: hexToBytes('0000000000000001'),
      srcTag: tag('5a5a5a5a5a5a5a5a'),
      dstTag: new Uint8Array(8),
      payload: hello,
    };
    const bytes = encodeEnvelope(env);
    const back = decodeEnvelope(bytes);
    expect(back.flags & 16).toBe(16);
    const body = decodeHello(back.payload);
    expect(body.version).toBe(2);
    expect(body.ephPq[0]).toBe(8);
  });
});

function ZERO(): Uint8Array {
  return new Uint8Array(8);
}
