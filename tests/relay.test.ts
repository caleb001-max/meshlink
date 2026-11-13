/**
 * Unit tests for the relay engine: dedup, store-and-forward queue,
 * spray-and-wait accounting, rate limiting, suppression and relay policy.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_SPRAY_COPIES,
  PRIO_BULK,
  PRIO_SOS,
  PRIO_TEXT,
  TYPE_MSG,
  type Envelope,
  ageEnvelope,
  encodeEnvelope,
} from '../src/lib/core/protocol';
import {
  DEFAULT_POLICY,
  DedupSet,
  OutboundQueue,
  RateLimiter,
  SuppressionState,
  copiesForDestination,
  relayDecision,
  type RelayPolicy,
} from '../src/lib/core/relay';
import { bytesToHex, hexToBytes } from '../src/lib/core/bytes';

let nextId = 1;
function mkEnv(overrides: Partial<Envelope> = {}): Envelope {
  const id = nextId++;
  return {
    type: TYPE_MSG,
    priority: PRIO_TEXT,
    flags: 0,
    hopLimit: 8,
    hopCount: 0,
    expiresInSec: 3600,
    sprayCopies: DEFAULT_SPRAY_COPIES,
    msgId: hexToBytes(id.toString(16).padStart(16, '0')),
    srcTag: hexToBytes('a1a1a1a1a1a1a1a1'),
    dstTag: hexToBytes('0000000000000000'),
    payload: new Uint8Array(32).fill(7),
    ...overrides,
  };
}

function policy(overrides: Partial<RelayPolicy> = {}): RelayPolicy {
  return { ...DEFAULT_POLICY, relayEnabled: true, ...overrides };
}

describe('DedupSet', () => {
  test('detects duplicates and is bounded', () => {
    const d = new DedupSet(4);
    const a = hexToBytes('0000000000000001');
    const b = hexToBytes('0000000000000002');
    expect(d.checkAndAdd(a)).toBe(true);
    expect(d.checkAndAdd(a)).toBe(false);
    expect(d.has(a)).toBe(true);
    // Overfill: capacity 4, evicts oldest quarter each overflow.
    for (let i = 3; i <= 12; i++) d.checkAndAdd(hexToBytes(i.toString(16).padStart(16, '0')));
    expect(d.size).toBeLessThanOrEqual(4);
    expect(d.has(a)).toBe(false); // oldest evicted
  });
});

describe('OutboundQueue', () => {
  test('rejects duplicates and already-expired envelopes', () => {
    const q = new OutboundQueue(policy());
    const first = mkEnv();
    expect(q.push(first)).toBe(true);
    expect(q.push(mkEnv({ msgId: first.msgId }))).toBe(false);
    expect(q.push(mkEnv({ expiresInSec: 0 }))).toBe(false);
    expect(q.size).toBe(1);
  });

  test('tracks encoded byte totals', () => {
    const q = new OutboundQueue(policy());
    const env = mkEnv();
    q.push(env);
    expect(q.totalBytes).toBe(encodeEnvelope(env).length);
  });

  test('expires items by elapsed local time and reports them', () => {
    const onEvict = vi.fn();
    const q = new OutboundQueue(policy(), { onEvict });
    const env = mkEnv({ expiresInSec: 2 });
    const t0 = 1000;
    expect(q.push(env, t0)).toBe(true);
    // Nothing expired yet.
    expect(q.expireExpired(t0 + 1000).length).toBe(0);
    const expired = q.expireExpired(t0 + 3000);
    expect(expired.length).toBe(1);
    expect(expired[0].env.expiresInSec).toBe(0);
    expect(onEvict).toHaveBeenCalledWith(bytesToHex(env.msgId), 'expired');
    expect(q.size).toBe(0);
  });

  test('aging is charged against remaining life, not re-measured from zero', () => {
    const q = new OutboundQueue(policy());
    const env = mkEnv({ expiresInSec: 10 });
    const t0 = 0;
    q.push(env, t0);
    q.expireExpired(t0 + 1000); // 1s consumed
    const item = q.get(env.msgId)!;
    expect(item.env.expiresInSec).toBe(9);
  });

  test('quota eviction protects SOS and drops lowest priority first', () => {
    const onEvict = vi.fn();
    const oneEnvBytes = encodeEnvelope(mkEnv()).length;
    const q = new OutboundQueue(policy({ maxQueueBytes: oneEnvBytes * 2 + 10 }), { onEvict });
    const sos = mkEnv({ priority: PRIO_SOS, msgId: hexToBytes('1000000000000001') });
    const bulk1 = mkEnv({ priority: PRIO_BULK, msgId: hexToBytes('1000000000000002') });
    const text = mkEnv({ priority: PRIO_TEXT, msgId: hexToBytes('1000000000000003') });
    q.push(sos);
    q.push(bulk1);
    q.push(text); // pushes bytes over quota -> eviction must remove BULK first
    expect(q.get(bulk1.msgId)).toBeNull();
    expect(q.get(sos.msgId)).not.toBeNull();
    expect(q.get(text.msgId)).not.toBeNull();
  });

  test('markForMe + consumeCopy drops a delivered item', () => {
    const onEvict = vi.fn();
    const q = new OutboundQueue(policy(), { onEvict });
    const env = mkEnv({ sprayCopies: 1 });
    q.push(env);
    expect(q.consumeCopy(env.msgId)).toBe(false); // copies 1 -> 0, but not forMe yet
    q.markForMe(env.msgId);
    expect(q.consumeCopy(env.msgId)).toBe(false);
    expect(onEvict).toHaveBeenCalledWith(bytesToHex(env.msgId), 'delivered');
    expect(q.size).toBe(0);
  });

  test('spray copies halve across relay hops', () => {
    const q = new OutboundQueue(policy());
    const env = mkEnv({ sprayCopies: 8 });
    q.push(env);
    const item = q.get(env.msgId)!;
    expect(item.copies).toBe(8);
    expect(q.consumeCopy(env.msgId)).toBe(true);
    expect(item.copies).toBe(7);
  });

  test('missingFor returns only items the peer lacks', () => {
    const q = new OutboundQueue(policy());
    const have = mkEnv({ msgId: hexToBytes('2000000000000001') });
    const miss = mkEnv({ msgId: hexToBytes('2000000000000002') });
    q.push(have);
    q.push(miss);
    const missing = q.missingFor([
      { msgId: have.msgId, copies: 1, priority: PRIO_TEXT, sizeBucket: PRIO_TEXT, dstTag: have.dstTag },
    ]);
    expect(missing.length).toBe(1);
    expect(missing[0].env.msgId).toEqual(miss.msgId);
  });

  test('buildInventory sorts SOS first and skips forMe items', () => {
    const q = new OutboundQueue(policy());
    const sos = mkEnv({ priority: PRIO_SOS, msgId: hexToBytes('3000000000000001') });
    const bulk = mkEnv({ priority: PRIO_BULK, msgId: hexToBytes('3000000000000002') });
    const mine = mkEnv({ msgId: hexToBytes('3000000000000003') });
    q.push(bulk);
    q.push(sos);
    q.push(mine);
    q.markForMe(mine.msgId);
    const inv = q.buildInventory();
    expect(inv.length).toBe(2);
    expect(inv[0].priority).toBe(PRIO_SOS);
    expect(bytesToHex(inv[0].msgId)).toBe(bytesToHex(sos.msgId));
    expect(bytesToHex(inv[1].msgId)).toBe(bytesToHex(bulk.msgId));
  });

  test('overPerPeer caps per originating sender (Sybil defense)', () => {
    const q = new OutboundQueue(policy({ maxPerPeer: 2 }));
    const src = hexToBytes('bbbbbbbbbbbbbbbb');
    const other = hexToBytes('cccccccccccccccc');
    q.push(mkEnv({ srcTag: src, msgId: hexToBytes('4000000000000001') }));
    q.push(mkEnv({ srcTag: src, msgId: hexToBytes('4000000000000002') }));
    expect(q.overPerPeer(mkEnv({ srcTag: src }))).toBe(true);
    expect(q.overPerPeer(mkEnv({ srcTag: other }))).toBe(false);
  });
});

describe('spray accounting', () => {
  test('copiesForDestination splits and floors', () => {
    const q = new OutboundQueue(policy());
    const env = mkEnv({ sprayCopies: 8 });
    q.push(env);
    const item = q.get(env.msgId)!;
    expect(copiesForDestination(item, 3)).toBe(2);
    expect(copiesForDestination(item, 1)).toBe(8);
    expect(copiesForDestination(item, 2)).toBe(4);
  });
});

describe('RateLimiter', () => {
  test('token bucket allows burst then throttles, refills over time', () => {
    const rl = new RateLimiter(1, 3); // 1 token/sec, burst 3
    const t0 = 10_000;
    expect(rl.allow('peer1', t0)).toBe(true);
    expect(rl.allow('peer1', t0)).toBe(true);
    expect(rl.allow('peer1', t0)).toBe(true);
    expect(rl.allow('peer1', t0)).toBe(false);
    expect(rl.allow('peer2', t0)).toBe(true); // independent bucket
    expect(rl.allow('peer1', t0 + 999)).toBe(false); // <1 token refilled
    expect(rl.allow('peer1', t0 + 1000)).toBe(true);
  });
});

describe('SuppressionState', () => {
  test('holds a random jitter, then relays below the observation threshold', () => {
    const s = new SuppressionState();
    const id = hexToBytes('5000000000000001');
    const t0 = 50_000;
    s.startJitter(id, 400, t0);
    expect(s.shouldRelay(id, 2, t0 + 10)).toBe(false); // still jittering
    expect(s.shouldRelay(id, 2, t0 + 5000)).toBe(true); // jitter passed, 0 relays observed
  });

  test('counter suppression: too many observed relays blocks forwarding', () => {
    const s = new SuppressionState();
    const id = hexToBytes('5000000000000002');
    const t0 = 50_000;
    s.startJitter(id, 0, t0);
    s.observeRelay(id);
    s.observeRelay(id);
    expect(s.shouldRelay(id, 2, t0 + 5000)).toBe(false);
    expect(s.shouldRelay(hexToBytes('5000000000000003'), 2, t0 + 5000)).toBe(true);
  });
});

describe('relayDecision', () => {
  const base = {
    isForMe: false,
    circleAuthOk: true,
    link: { linkId: 'l1', peerTag: null, wifi: true, charging: false },
    rateOk: true,
  };

  test('accepts a relayable envelope when enabled', () => {
    const d = relayDecision(policy(), mkEnv(), base);
    expect(d.relay).toBe(true);
    expect(d.reason).toBe('ok');
  });

  test('rejects: for-me, hop-limit, expired, opt-out', () => {
    expect(relayDecision(policy(), mkEnv(), { ...base, isForMe: true }).reason).toBe('for-me');
    expect(relayDecision(policy(), mkEnv({ hopCount: 8, hopLimit: 8 }), base).reason).toBe('hop-limit');
    expect(relayDecision(policy(), mkEnv({ expiresInSec: 0 }), base).reason).toBe('expired');
    const off = relayDecision(policy({ relayEnabled: false }), mkEnv(), base);
    expect(off.relay).toBe(false);
    expect(off.reason).toBe('opt-out');
  });

  test('link constraints: charging-only and wifi-only', () => {
    const p = policy({ relayOnlyCharging: true, relayOnlyWifi: true });
    expect(relayDecision(p, mkEnv(), { ...base, link: { ...base.link, charging: false } }).reason).toBe('not-charging');
    expect(relayDecision(p, mkEnv(), { ...base, link: { ...base.link, charging: true, wifi: false } }).reason).toBe('not-wifi');
    expect(relayDecision(p, mkEnv(), { ...base, link: { ...base.link, charging: true, wifi: true } }).relay).toBe(true);
  });

  test('trust-circle gating and battery saver (SOS exempt)', () => {
    const p = policy({ relayOnlyTrusted: true, batteryLevel: 0.05, batterySaverThreshold: 0.15 });
    expect(relayDecision(p, mkEnv(), { ...base, circleAuthOk: false }).reason).toBe('untrusted');
    expect(relayDecision(p, mkEnv(), base).reason).toBe('battery-saver'); // non-SOS throttled
    expect(relayDecision(p, mkEnv({ priority: PRIO_SOS }), base).relay).toBe(true); // SOS passes
  });

  test('rate limit is the final gate', () => {
    expect(relayDecision(policy(), mkEnv(), { ...base, rateOk: false }).reason).toBe('rate-limit');
  });

  test('ageEnvelope moves hopCount and consumes remaining life', () => {
    const env = mkEnv({ expiresInSec: 100, hopCount: 2 });
    ageEnvelope(env, 5);
    expect(env.hopCount).toBe(3);
    expect(env.expiresInSec).toBe(95);
  });
});
