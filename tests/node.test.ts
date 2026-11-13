/**
 * End-to-end node tests over an in-memory virtual transport: two nodes with
 * secured links, covering paired messaging, stranger discovery, relay chains,
 * restart recovery and the security-relevant paths.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MeshNode, type MeshNodeOptions } from '../src/lib/core/node';
import { MemoryStore, type MessageRecord } from '../src/lib/core/store';
import { newIdentity } from '../src/lib/core/crypto';
import { hexToBytes } from '../src/lib/core/bytes';
import { PRIO_SOS } from '../src/lib/core/protocol';

const BASE = 1_700_000_000_000;

interface Rig {
  node: MeshNode;
  store: MemoryStore;
  identity: ReturnType<typeof newIdentity>;
}

function makeNode(name: string, clock: { value: number }, relay = false): Rig {
  const identity = newIdentity();
  const store = new MemoryStore();
  const opts: MeshNodeOptions = {
    identity,
    store,
    displayName: name,
    policy: relay ? { relayEnabled: true } : {},
    now: () => clock.value,
    helloIntervalMs: 3_600_000,
  };
  return { node: new MeshNode(opts), store, identity };
}

function wire(a: Rig, b: Rig, idA: string, idB: string): void {
  b.node.registerLink(idB, 'test', (bytes) => void a.node.ingest(idA, bytes), false);
  a.node.registerLink(idA, 'test', (bytes) => void b.node.ingest(idB, bytes), true);
}

const settle = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(probe: () => T | null | undefined | false, what: string, timeoutMs = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${what}`);
    await settle(10);
  }
}

const liveNodes: MeshNode[] = [];
function track(rig: Rig): Rig {
  liveNodes.push(rig.node);
  return rig;
}

afterEach(() => {
  for (const n of liveNodes) n.stop();
  liveNodes.length = 0;
});

describe('MeshNode paired contacts', () => {
  test('QR pairing -> session-init -> delivery -> ACK -> reply', async () => {
    const clock = { value: BASE };
    const A = track(makeNode('alice', clock));
    const B = track(makeNode('bob', clock));
    await A.node.start();
    await B.node.start();

    const bobId = await A.node.pairFromQr(JSON.parse(B.node.qrPayload()));
    const aliceId = await B.node.pairFromQr(JSON.parse(A.node.qrPayload()));
    expect(bobId).toBe(B.identity ? bytesHex(B.identity.signPub) : '');
    // Safety numbers must match on both sides (same two identities).
    const aliceContact = await A.store.getContact(bobId);
    const bobContact = await B.store.getContact(aliceId);
    expect(aliceContact!.safetyNumber).toBe(bobContact!.safetyNumber);

    wire(A, B, 'l-a', 'l-b');
    await settle();
    await settle();

    const delivered = vi.fn();
    A.node.events.onDeliveryChanged = delivered;
    const mid = await A.node.sendMessage(bobId, 'text', 'hello bob');
    await settle();
    await B.node.gossip();
    await settle();

    // Recipient sees the message with sender attribution.
    const atB = await waitFor(
      async () => (await B.store.getMessage(mid))?.status === 'delivered' ? await B.store.getMessage(mid) : null,
      'message delivered at B',
    );
    expect(atB!.body).toBe('hello bob');
    expect(atB!.direction).toBe('in');
    expect(atB!.contactId).toBe(aliceId);

    // Sender's copy flips queued -> delivered via the ACK; the delivery event
    // fires on the sender's node.
    const atA = await waitFor(async () => {
      const m = await A.store.getMessage(mid);
      return m?.status === 'delivered' ? m : null;
    }, 'ACK at A');
    expect(atA!.body).toBe('hello bob');
    expect(delivered).toHaveBeenCalledWith(mid, 'delivered');

    // Reply uses the established ratchet (no new session-init).
    const replyId = await B.node.sendMessage(aliceId, 'text', 'hi alice');
    await settle();
    await A.node.gossip();
    await settle();
    const replyAtA = await waitFor(async () => {
      const m = await A.store.getMessage(replyId);
      return m?.body === 'hi alice' ? m : null;
    }, 'reply at A');
    expect(replyAtA!.status).toBe('delivered');
  });

  test('alternating messages keep ratcheting (20 turns both ways)', async () => {
    const clock = { value: BASE };
    const A = track(makeNode('alice', clock));
    const B = track(makeNode('bob', clock));
    await A.node.start();
    await B.node.start();
    const bobId = await A.node.pairFromQr(JSON.parse(B.node.qrPayload()));
    const aliceId = await B.node.pairFromQr(JSON.parse(A.node.qrPayload()));
    wire(A, B, 'l-a', 'l-b');
    await settle();
    await settle();

    for (let i = 0; i < 20; i++) {
      const m1 = await A.node.sendMessage(bobId, 'text', `a${i}`);
      await settle();
      await B.node.gossip();
      await settle();
      await waitFor(async () => await B.store.getMessage(m1), `B got a${i}`);
      expect((await B.store.getMessage(m1))!.body).toBe(`a${i}`);

      const m2 = await B.node.sendMessage(aliceId, 'text', `b${i}`);
      await settle();
      await A.node.gossip();
      await settle();
      await waitFor(async () => await A.store.getMessage(m2), `A got b${i}`);
      expect((await A.store.getMessage(m2))!.body).toBe(`b${i}`);
    }
  });

  test('SOS messages are flagged and raise the onSos event', async () => {
    const clock = { value: BASE };
    const A = track(makeNode('alice', clock));
    const B = track(makeNode('bob', clock));
    await A.node.start();
    await B.node.start();
    const bobId = await A.node.pairFromQr(JSON.parse(B.node.qrPayload()));
    await B.node.pairFromQr(JSON.parse(A.node.qrPayload()));
    wire(A, B, 'l-a', 'l-b');
    await settle();
    await settle();
    const sosSeen = vi.fn();
    B.node.events.onSos = sosSeen;
    const mid = await A.node.sendMessage(bobId, 'sos', 'need help', { sos: true });
    await settle();
    await B.node.gossip();
    await settle();
    const atB = await waitFor(async () => await B.store.getMessage(mid), 'sos at B');
    expect(atB!.kind).toBe('sos');
    expect(atB!.priority).toBe(PRIO_SOS);
    expect(sosSeen).toHaveBeenCalled();
  });

  test('messages from a blocked contact are never accepted', async () => {
    const clock = { value: BASE };
    const A = track(makeNode('alice', clock));
    const B = track(makeNode('bob', clock));
    await A.node.start();
    await B.node.start();
    const bobId = await A.node.pairFromQr(JSON.parse(B.node.qrPayload()));
    const aliceId = await B.node.pairFromQr(JSON.parse(A.node.qrPayload()));
    await B.node.setBlocked(aliceId, true);
    wire(A, B, 'l-a', 'l-b');
    await settle();
    await settle();
    await A.node.sendMessage(bobId, 'text', 'should be dropped');
    await settle();
    await B.node.gossip();
    await settle();
    await settle();
    const all = await B.store.listMessages(aliceId);
    expect(all.length).toBe(0);
  });
});

describe('MeshNode stranger conversations', () => {
  test('HELLO discovery -> message request -> conversation-tag reply -> ACK', async () => {
    const clock = { value: BASE };
    const A = track(makeNode('alice', clock));
    const B = track(makeNode('bob', clock));
    await A.node.start();
    await B.node.start();
    wire(A, B, 'l-a', 'l-b');
    await settle();
    await settle();

    // A learned B's HELLO tag on link establishment; B advertises it.
    const peerPrefix = A.node.snapshot().links[0].peerTag!;
    const bHelloTag = B.node.ownHelloTags().find((t) => t.startsWith(peerPrefix));
    expect(bHelloTag).toBeTruthy();
    const bHelloTagHex = bHelloTag as string;

    const requests: MessageRecord[] = [];
    B.node.events.onMessageRequest = (m) => requests.push(m);

    const mid = await A.node.sendMessage(null, 'text', 'psst stranger', { dstHelloTag: hexToBytes(bHelloTagHex) });
    await settle();
    await B.node.gossip();
    await settle();

    const atB = await waitFor(async () => {
      const m = await B.store.getMessage(mid);
      return m?.status === 'request' ? m : null;
    }, 'stranger message at B');
    expect(atB!.body).toBe('psst stranger');
    expect(requests.length).toBe(1);
    // Sender identity arrives inside the E2E payload; the contact is created
    // with the display name and is NOT auto-trusted.
    const aliceId = atB!.contactId;
    const contactAtB = await B.store.getContact(aliceId);
    expect(contactAtB!.name).toBe('alice');
    expect(contactAtB!.trusted).toBe(false);

    // B replies over the same ratchet, addressed to A's conversation tag.
    const replyId = await B.node.sendMessage(aliceId, 'text', 'who dis');
    await settle();
    await A.node.gossip();
    await settle();
    const replyAtA = await waitFor(async () => {
      const m = await A.store.getMessage(replyId);
      return m?.body === 'who dis' ? m : null;
    }, 'stranger reply at A');
    expect(replyAtA!.status).toBe('request');

    // A's ACK (addressed to the conversation tag) confirms B's reply.
    await A.node.gossip();
    await settle();
    await B.node.gossip();
    await settle();
    const acked = await waitFor(async () => {
      const m = await B.store.getMessage(replyId);
      return m?.status === 'delivered' ? m : null;
    }, 'reply ACK at B');
    expect(acked!.status).toBe('delivered');
    // A's own first message is confirmed delivered too.
    const firstAtA = await A.store.getMessage(mid);
    expect(firstAtA!.status).toBe('delivered');
  });
});

describe('MeshNode relay chain', () => {
  test('store-carry-forward over a 3-hop line with ACK round-trip', async () => {
    const clock = { value: BASE };
    const A = track(makeNode('alice', clock, true));
    const B = track(makeNode('bob', clock, true));
    const C = track(makeNode('carol', clock, true));
    const D = track(makeNode('dave', clock, true));
    await A.node.start();
    await B.node.start();
    await C.node.start();
    await D.node.start();

    // Phase 1: everyone meets (fully connected) so HELLO bundles spread.
    wire(A, B, 'a-b', 'b-a');
    wire(A, C, 'a-c', 'c-a');
    wire(A, D, 'a-d', 'd-a');
    wire(B, C, 'b-c', 'c-b');
    wire(B, D, 'b-d', 'd-b');
    wire(C, D, 'c-d', 'd-c');
    await settle();
    await settle();
    // Phase 2: mobility narrows the topology to a line A-B-C-D.
    A.node.unregisterLink('a-c');
    A.node.unregisterLink('a-d');
    B.node.unregisterLink('b-d');
    C.node.unregisterLink('c-a');
    D.node.unregisterLink('d-a');
    D.node.unregisterLink('d-b');
    await settle();

    // A knows D's hello bundle from phase 1 even though they are no longer
    // adjacent: this is the store-and-forward premise.
    const dHelloTag = A.node.peerHelloTags().find((t) => D.node.ownsHelloTag(t));
    expect(dHelloTag).toBeTruthy();

    const mid = await A.node.sendMessage(null, 'text', 'relay me', { dstHelloTag: hexToBytes(dHelloTag!) });
    // Grind the mesh: advance the clock past suppression jitter and gossip.
    for (let round = 0; round < 12; round++) {
      clock.value += 600;
      await A.node.gossip();
      await B.node.gossip();
      await C.node.gossip();
      await D.node.gossip();
      await settle();
      const done = await D.store.getMessage(mid);
      if (done) break;
    }
    const atD = await D.store.getMessage(mid);
    expect(atD!.body).toBe('relay me');
    expect(atD!.contactId).toBe(bytesHex(A.identity.signPub));

    // ACK walks back D -> C -> B -> A.
    for (let round = 0; round < 8; round++) {
      clock.value += 600;
      await D.node.gossip();
      await C.node.gossip();
      await B.node.gossip();
      await A.node.gossip();
      await settle();
      const m = await A.store.getMessage(mid);
      if (m?.status === 'delivered') break;
    }
    expect((await A.store.getMessage(mid))!.status).toBe('delivered');
  });
});

describe('MeshNode restart recovery', () => {
  test('queued message survives a full restart from the same store', async () => {
    const clock = { value: BASE };
    const storeA = new MemoryStore();
    const storeB = new MemoryStore();
    const identityA = newIdentity();
    const identityB = newIdentity();
    const optsA = (): MeshNodeOptions => ({ identity: identityA, store: storeA, displayName: 'alice', now: () => clock.value, helloIntervalMs: 3_600_000 });
    const optsB = (): MeshNodeOptions => ({ identity: identityB, store: storeB, displayName: 'bob', now: () => clock.value, helloIntervalMs: 3_600_000 });
    const A = track({ node: new MeshNode(optsA()), store: storeA, identity: identityA });
    const B = track({ node: new MeshNode(optsB()), store: storeB, identity: identityB });
    await A.node.start();
    await B.node.start();
    const bobId = await A.node.pairFromQr(JSON.parse(B.node.qrPayload()));
    await B.node.pairFromQr(JSON.parse(A.node.qrPayload()));

    // No links yet: the message must sit in the queue.
    const mid = await A.node.sendMessage(bobId, 'text', 'offline msg');
    expect((await A.store.getMessage(mid))!.status).toBe('queued');

    // Both nodes restart from the same persistent stores.
    A.node.stop();
    B.node.stop();
    liveNodes.length = 0;
    const A2 = track({ node: new MeshNode(optsA()), store: storeA, identity: identityA });
    const B2 = track({ node: new MeshNode(optsB()), store: storeB, identity: identityB });
    await A2.node.start();
    await B2.node.start();
    wire(A2, B2, 'l-a', 'l-b');
    await settle();
    await settle();

    await A2.node.gossip();
    await settle();
    await B2.node.gossip();
    await settle();
    await waitFor(async () => (await B2.store.getMessage(mid))?.status === 'delivered', 'msg after restart');
    expect((await B2.store.getMessage(mid))!.body).toBe('offline msg');
    expect((await A2.store.getMessage(mid))!.status).toBe('delivered');

    // The restored ratchet keeps working for a second message.
    const mid2 = await A2.node.sendMessage(bobId, 'text', 'second after restart');
    await settle();
    await B2.node.gossip();
    await settle();
    await waitFor(async () => (await B2.store.getMessage(mid2))?.body === 'second after restart', 'second msg');
  });
});

// ------------------------------------------------------------------ helpers

function bytesHex(b: Uint8Array): string {
  let out = '';
  for (const x of b) out += x.toString(16).padStart(2, '0');
  return out;
}
