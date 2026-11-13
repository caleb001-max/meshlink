/**
 * MeshNode — the complete MeshLink node: identity, contacts, asynchronous
 * sessions, gossip routing, relay policy, message requests and diagnostics.
 *
 * The node is transport-agnostic: platform adapters (LAN TCP, BLE GATT, the
 * simulator's virtual radio) register links and deliver raw bytes; the node
 * handles link security, the protocol envelope, routing and storage. It is
 * driven by an injectable clock so the discrete-event simulator runs the exact
 * production code at any speed.
 *
 * Session continuity rules (store-and-forward, no live handshakes):
 *  - Paired contacts talk over per-epoch rotating pairwise tags; sessions are
 *    established from the published prekey bundle (QR) and then ratchet.
 *  - Strangers talk using the ephemeral prekey bundle carried in a HELLO; the
 *    initiator mints a stable "conversation tag" that serves as the return
 *    address until both sides have exchanged identities inside E2E messages,
 *    after which both switch to pairwise tags.
 *  - Undecryptable or unacknowledged mail is retried with a fresh session and
 *    bounded attempts; failures surface in the UI, never as fake delivery.
 */

import {
  DEFAULT_EXPIRES_SEC,
  DEFAULT_HOP_LIMIT,
  DEFAULT_SPRAY_COPIES,
  EPHEMERAL_EXPIRES_SEC,
  FLAG_E2E,
  FLAG_HAS_BUNDLE,
  FLAG_PQ_HYBRID,
  FLAG_SESSION_INIT,
  PRIO_SOS,
  PRIO_TEXT,
  SOS_EXPIRES_SEC,
  SOS_HOP_LIMIT,
  TYPE_ACK,
  TYPE_HELLO,
  TYPE_INVENTORY,
  TYPE_MSG,
  TYPE_REQUEST,
  decodeAckBatch,
  decodeEnvelope,
  decodeHello,
  decodeInventory,
  decodeRequestBatch,
  encodeAckBatch,
  encodeEnvelope,
  encodeHello,
  encodeInventory,
  encodeRequestBatch,
  ageEnvelope,
  fragmentEnvelope,
  padToBucket,
  Envelope,
  InventoryEntry,
  Priority,
  Reassembler,
  decodeFragment,
} from './protocol';
import {
  BundleSecrets,
  DoubleRatchet,
  PrekeyBundle,
  SessionInitHeader,
  bundleId as bundleIdOf,
  currentEpoch,
  decodeSessionWire,
  epochTag,
  makeHelloBundle,
  makePrekeyBundle,
  pairwiseSecret,
  safetyNumber,
  sessionEncrypt,
  sha256Bytes,
  signBytes,
  tagsForNow,
  verifyBytes,
  verifyPrekeyBundle,
  x3dhInitiate,
  x3dhReceive,
  circleMac,
  Identity,
} from './crypto';
import { x25519 } from '@noble/curves/ed25519';
import {
  DEFAULT_POLICY,
  DedupSet,
  OutboundQueue,
  QueueItem,
  RateLimiter,
  RelayPolicy,
  SuppressionState,
  relayDecision,
  copiesForDestination,
} from './relay';
import {
  ContactRecord,
  MessageKind,
  MessageRecord,
  MessageStatus,
  OwnBundleRecord,
  Store,
  queueRecordFromEnvelope,
  envelopeFromRecord,
} from './store';
import {
  acceptHandshake1,
  completeInitiator,
  createHandshake1,
  decodeHandshake1,
  decodeHandshake2,
  LinkCodec,
} from './linksec';
import { bytesEqual, bytesToHex, bytesToB64, b64ToBytes, concat, hexToBytes, randomBytes, u32le, utf8 } from './bytes';

const FRAME_SEALED = 0x01;
const FRAME_HS1 = 0x02;
const FRAME_HS2 = 0x03;

const ZERO32 = new Uint8Array(32);
const ZERO8 = new Uint8Array(8);

export interface LinkSend {
  (bytes: Uint8Array): void;
}

export interface LinkInfo {
  id: string;
  transport: string;
  secured: boolean;
  peerTag: string | null;
  establishedAt: number;
}

interface Link {
  id: string;
  transport: string;
  send: LinkSend;
  isInitiator: boolean;
  secured: boolean;
  codec: LinkCodec | null;
  peerTag: Uint8Array | null;
  hs1?: { ephPriv: Uint8Array; ephPub: Uint8Array; nonce: Uint8Array };
  establishedAt: number;
}

interface SessionEntry {
  ratchet: DoubleRatchet;
  contactId: string | null;
  /** Stable tag for stranger conversations (initiator side). */
  conversationTag?: Uint8Array;
  createdAt: number;
}

/** Our published prekey material (persisted via store.kv; app may SecureStore it). */
interface OwnPrekeys {
  spkPriv: string;
  spkPub: string;
  spkSig: string;
  pqSk: string;
  pqPk: string;
  dhPub: string;
  opks: { priv: string; pub: string }[];
}

export interface NodeEvents {
  onMessagesChanged?: () => void;
  onContactsChanged?: () => void;
  onLinksChanged?: () => void;
  onMessageRequest?: (msg: MessageRecord) => void;
  onDeliveryChanged?: (msgId: string, status: MessageStatus) => void;
  onSecurityWarning?: (what: string, contactId: string | null) => void;
  onSos?: (msg: MessageRecord) => void;
}

export interface MeshNodeOptions {
  identity: Identity;
  store: Store;
  displayName: string;
  policy?: Partial<RelayPolicy>;
  circleKeys?: Uint8Array[];
  now?: () => number;
  helloIntervalMs?: number;
  /** Simulator/testing: do not start the real 15s interval; the host drives tick()/gossip(). */
  noTimers?: boolean;
  /** Max simultaneously held HELLO addresses (dense/churn scenarios may raise this). */
  helloTagCapacity?: number;
}

export interface NodeSnapshot {
  started: boolean;
  links: LinkInfo[];
  queueSize: number;
  queueBytes: number;
  dedupSize: number;
  contacts: number;
  epoch: number;
  relayEnabled: boolean;
  displayName: string;
}

/** E2E payload; `sig` is an Ed25519 signature over the canonical fields. */
interface E2EPayload {
  k: MessageKind;
  b: string;
  m?: string | null;
  t?: string | null;
  n?: string;
  s: string; // sender Ed25519 identity pub (hex)
  d?: string; // sender identity X25519 pub (hex), once known
  ts: number;
  sig: string;
}

function payloadSigningBytes(p: Omit<E2EPayload, 'sig'>): Uint8Array {
  return utf8(JSON.stringify({ k: p.k, b: p.b, m: p.m ?? null, t: p.t ?? null, n: p.n, s: p.s, d: p.d, ts: p.ts }));
}

function makeSignedPayload(identity: Identity, fields: Omit<E2EPayload, 'sig' | 's' | 'ts' | 'd'> & { ts: number; d?: string }): E2EPayload {
  const withSender: Omit<E2EPayload, 'sig'> = {
    ...fields,
    s: bytesToHex(identity.signPub),
    d: bytesToHex(identity.dhPub),
  };
  const sig = signBytes(identity.signSeed, payloadSigningBytes(withSender));
  return { ...withSender, sig: bytesToHex(sig) };
}

export class MeshNode {
  readonly identity: Identity;
  readonly store: Store;
  policy: RelayPolicy;
  displayName: string;
  events: NodeEvents = {};

  private links = new Map<string, Link>();
  private sessions = new Map<string, SessionEntry>();
  private queue: OutboundQueue;
  private dedup = new DedupSet();
  private suppression = new SuppressionState();
  private incomingRate = new RateLimiter(0.5, 30);
  private reassembler = new Reassembler();
  private helloTags = new Map<string, { bundleId: string; secrets: { ephXPriv: Uint8Array; ephPqSk: Uint8Array; ephX: Uint8Array; ephPq: Uint8Array }; createdAt: number }>();
  private peerHelloBundles = new Map<string, { ephX: Uint8Array; ephPq: Uint8Array; at: number }>();
  private pendingAcks = new Map<string, { ids: string[]; srcTag: Uint8Array }>();
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private helloIntervalMs: number;
  private helloTagCapacity: number;
  private lastHelloAt = 0;
  private nowFn: () => number;
  private circleKeys: Uint8Array[];
  private started = false;
  private noTimers: boolean;
  private contactCache = new Map<string, ContactRecord>();
  private prekeys: OwnPrekeys | null = null;
  private retried = new Set<string>();
  /** conversation-tag hex -> real contact id, learned at session promotion. */
  private convTagToContact = new Map<string, string>();

  constructor(opts: MeshNodeOptions) {
    this.identity = opts.identity;
    this.store = opts.store;
    this.displayName = opts.displayName;
    this.policy = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
    this.circleKeys = opts.circleKeys ?? [];
    this.nowFn = opts.now ?? (() => Date.now());
    this.helloIntervalMs = opts.helloIntervalMs ?? 10 * 60 * 1000;
    this.helloTagCapacity = opts.helloTagCapacity ?? 64;
    this.noTimers = opts.noTimers ?? false;
    this.queue = new OutboundQueue(this.policy, {});
  }

  private now(): number {
    return this.nowFn();
  }

  get identityId(): string {
    return bytesToHex(this.identity.signPub);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.ensurePrekeys();
    await this.loadContacts();
    await this.restoreSessions();
    await this.restoreQueue();
    if (!this.noTimers) this.helloTimer = setInterval(() => this.tick(), 15_000);
    await this.broadcastHello();
  }

  stop(): void {
    if (this.helloTimer) clearInterval(this.helloTimer);
    this.helloTimer = null;
    this.started = false;
    for (const id of [...this.links.keys()]) this.links.delete(id);
    this.events.onLinksChanged?.();
  }

  // ------------------------------------------------------------ prekeys

  private async ensurePrekeys(): Promise<void> {
    const raw = await this.store.kvGet('ml.prekeys');
    if (raw) {
      try {
        this.prekeys = JSON.parse(raw) as OwnPrekeys;
        return;
      } catch {
        /* regenerate */
      }
    }
    const { bundle, secrets } = makePrekeyBundle(this.identity);
    const opks = Array.from({ length: 20 }, () => {
      const k = x25519.keygen();
      return { priv: bytesToHex(k.secretKey), pub: bytesToHex(k.publicKey) };
    });
    this.prekeys = {
      spkPriv: bytesToHex(secrets.spkPriv),
      spkPub: bytesToHex(bundle.spk),
      spkSig: bytesToHex(bundle.spkSig),
      pqSk: bytesToHex(secrets.pqSk),
      pqPk: bytesToHex(bundle.pqPk),
      dhPub: bytesToHex(this.identity.dhPub),
      opks,
    };
    await this.store.kvSet('ml.prekeys', JSON.stringify(this.prekeys));
  }

  /** The bundle this node publishes to contacts (QR / profile messages). */
  publishedBundle(): { signPub: string; dhPub: string; name: string; spk: string; spkSig: string; opk: string | null; pqPk: string } {
    if (!this.prekeys) throw new Error('node not started');
    return {
      signPub: bytesToHex(this.identity.signPub),
      dhPub: bytesToHex(this.identity.dhPub),
      name: this.displayName,
      spk: this.prekeys.spkPub,
      spkSig: this.prekeys.spkSig,
      opk: this.prekeys.opks[0]?.pub ?? null,
      pqPk: this.prekeys.pqPk,
    };
  }

  private consumeOpk(pub: Uint8Array): Uint8Array | null {
    if (!this.prekeys) return null;
    const idx = this.prekeys.opks.findIndex((o) => bytesEqual(hexToBytes(o.pub), pub));
    if (idx < 0) return null;
    const [used] = this.prekeys.opks.splice(idx, 1);
    void this.store.kvSet('ml.prekeys', JSON.stringify(this.prekeys));
    return hexToBytes(used.priv);
  }

  // ------------------------------------------------------------ links

  registerLink(id: string, transport: string, send: LinkSend, isInitiator: boolean): void {
    this.links.set(id, {
      id,
      transport,
      send,
      isInitiator,
      secured: false,
      codec: null,
      peerTag: null,
      establishedAt: this.now(),
    });
    if (isInitiator) {
      const { msg, secrets } = createHandshake1(this.identity.signSeed);
      const link = this.links.get(id)!;
      link.hs1 = secrets;
      send(concat(new Uint8Array([FRAME_HS1]), msg));
    }
    this.events.onLinksChanged?.();
  }

  unregisterLink(id: string): void {
    this.links.delete(id);
    this.events.onLinksChanged?.();
  }

  /** Entry point for transport adapters: raw bytes from a link. */
  async ingest(linkId: string, raw: Uint8Array): Promise<void> {
    const link = this.links.get(linkId);
    if (!link) return;
    const t = raw[0];
    if (t === FRAME_HS1) {
      if (link.isInitiator) return;
      try {
        const hs1 = decodeHandshake1(raw.slice(1));
        const { reply, keys } = acceptHandshake1(this.identity.signSeed, hs1);
        link.codec = new LinkCodec(keys, 's2c', (pt) => void this.handleSealed(linkId, pt), () => this.links.delete(linkId));
        link.secured = true;
        link.send(concat(new Uint8Array([FRAME_HS2]), reply));
        await this.sendHelloOnLink(link);
        this.events.onLinksChanged?.();
      } catch {
        this.links.delete(linkId);
      }
      return;
    }
    if (t === FRAME_HS2) {
      if (!link.isInitiator || !link.hs1) return;
      try {
        const hs2 = decodeHandshake2(raw.slice(1));
        const { keys } = completeInitiator(link.hs1, hs2, null);
        link.codec = new LinkCodec(keys, 'c2s', (pt) => void this.handleSealed(linkId, pt), () => this.links.delete(linkId));
        link.secured = true;
        await this.sendHelloOnLink(link);
        this.events.onLinksChanged?.();
      } catch {
        this.links.delete(linkId);
      }
      return;
    }
    if (t === FRAME_SEALED && link.codec) {
      link.codec.push(raw.slice(1));
    }
  }

  private async handleSealed(linkId: string, plaintext: Uint8Array): Promise<void> {
    if (plaintext.length >= 2 && plaintext[0] === 0x4d && plaintext[1] === 0x4c) {
      await this.handleEnvelopeBytes(linkId, plaintext);
      return;
    }
    try {
      const frag = decodeFragment(plaintext);
      const complete = this.reassembler.add(frag);
      if (complete) await this.handleEnvelopeBytes(linkId, complete);
    } catch {
      /* junk fragment */
    }
  }

  private sendOnLink(link: Link, envelopeBytes: Uint8Array): void {
    if (!link.codec) return;
    const mtu = link.transport === 'ble' ? 420 : 16384;
    for (const frag of fragmentEnvelope(envelopeBytes, mtu)) {
      link.send(concat(new Uint8Array([FRAME_SEALED]), link.codec.seal(frag)));
    }
  }

  private sendToLinkId(linkId: string, env: Envelope): void {
    const link = this.links.get(linkId);
    if (link && link.secured) this.sendOnLink(link, encodeEnvelope(env));
  }

  private securedLinks(): Link[] {
    return [...this.links.values()].filter((l) => l.secured);
  }

  // ------------------------------------------------------------ discovery

  private async sendHelloOnLink(link: Link): Promise<void> {
    await this.broadcastHello([link]);
  }

  async broadcastHello(links?: Link[]): Promise<void> {
    const bundle = makeHelloBundle();
    const bundleId = bytesToHex(bundleIdOf(bundle.bundle));
    const tag = randomBytes(8);
    this.helloTags.set(bytesToHex(tag), {
      bundleId,
      secrets: { ephXPriv: bundle.secrets.ephXPriv, ephPqSk: bundle.secrets.ephPqSk, ephX: bundle.bundle.ephX, ephPq: bundle.bundle.ephPq },
      createdAt: this.now(),
    });
    const record: OwnBundleRecord = {
      bundleId,
      kind: 'hello',
      ephXPriv: bytesToHex(bundle.secrets.ephXPriv),
      ephPqSk: bytesToHex(bundle.secrets.ephPqSk),
      createdAt: this.now(),
    };
    await this.store.putOwnBundle(record);
    this.lastHelloAt = this.now();
    const env: Envelope = {
      type: TYPE_HELLO,
      priority: PRIO_TEXT,
      flags: FLAG_HAS_BUNDLE,
      hopLimit: 1,
      hopCount: 0,
      expiresInSec: EPHEMERAL_EXPIRES_SEC,
      sprayCopies: 0,
      msgId: randomBytes(8),
      srcTag: tag,
      dstTag: ZERO8,
      payload: encodeHello({ version: 2, caps: 1, ephX: bundle.bundle.ephX, ephPq: bundle.bundle.ephPq }),
    };
    for (const link of links ?? this.securedLinks()) {
      this.sendOnLink(link, encodeEnvelope(env));
    }
    this.pruneHelloTags();
  }

  private pruneHelloTags(): void {
    const cutoff = this.now() - 3600_000;
    for (const [tagHex, rec] of this.helloTags) {
      if (rec.createdAt < cutoff) this.helloTags.delete(tagHex);
    }
    if (this.helloTags.size > this.helloTagCapacity) {
      const oldest = [...this.helloTags.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      for (const [k] of oldest.slice(0, oldest.length - this.helloTagCapacity)) this.helloTags.delete(k);
    }
    const peerCutoff = this.now() - 3600_000;
    for (const [tagHex, rec] of this.peerHelloBundles) {
      if (rec.at < peerCutoff) this.peerHelloBundles.delete(tagHex);
    }
    if (this.peerHelloBundles.size > 256) {
      const oldest = [...this.peerHelloBundles.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [k] of oldest.slice(0, oldest.length - 256)) this.peerHelloBundles.delete(k);
    }
  }

  // ------------------------------------------------------------ sending

  /**
   * Sends a message to a contact, or to a stranger via their HELLO tag.
   * Returns the local message id (hex of msgId).
   */
  async sendMessage(
    contactId: string | null,
    kind: MessageKind,
    body: string,
    opts: { media?: string | null; targetId?: string | null; priority?: Priority; sos?: boolean; dstHelloTag?: Uint8Array } = {},
  ): Promise<string> {
    if (!this.started) throw new Error('node not started');
    const sos = opts.sos === true;
    const priority: Priority = sos ? PRIO_SOS : (opts.priority ?? PRIO_TEXT);
    const contact = contactId ? await this.getContact(contactId) : null;
    const msgId = randomBytes(8);
    const ad = concat(new Uint8Array([TYPE_MSG, priority]), msgId);

    const payload = makeSignedPayload(this.identity, {
      k: kind,
      b: body,
      m: opts.media ?? null,
      t: opts.targetId ?? null,
      n: this.displayName,
      ts: this.now(),
    });
    const plaintext = utf8(JSON.stringify(payload));

    let ratchet: DoubleRatchet;
    let initHeader: SessionInitHeader | null = null;
    let dstTag: Uint8Array;
    let srcTag: Uint8Array;
    let sessionKey: string | null = null;
    let conversationTag: Uint8Array | undefined;

    if (contact) {
      const existing = this.sessions.get(contact.id);
      if (existing) {
        ratchet = existing.ratchet;
        if (existing.conversationTag && contact.strangerTag) {
          // Stranger conversation: keep using the stable conversation tag as
          // the shared address until the pairwise hand-off completes.
          dstTag = existing.conversationTag;
          srcTag = dstTag;
        } else {
          dstTag = contact.pairwise ? this.tagForContact(contact) : (opts.dstHelloTag ?? ZERO8);
          srcTag = dstTag;
        }
      } else {
        if (!contact.bundle) throw new Error('no bundle for contact; pair via QR first');
        dstTag = contact.pairwise ? this.tagForContact(contact) : (opts.dstHelloTag ?? ZERO8);
        srcTag = dstTag;
        const bundle: PrekeyBundle = {
          kind: 'paired',
          dhPub: hexToBytes(contact.dhPub),
          spk: hexToBytes(contact.bundle.spk),
          spkSig: hexToBytes(contact.bundle.spkSig),
          opk: contact.bundle.opk ? hexToBytes(contact.bundle.opk) : null,
          pqPk: hexToBytes(contact.bundle.pqPk),
        };
        const init = x3dhInitiate(this.identity, bundle);
        ratchet = DoubleRatchet.initAsSender(init.sharedSecret, init.recipientDhPub);
        initHeader = init.header;
        sessionKey = contact.id;
      }
    } else {
      if (!opts.dstHelloTag) throw new Error('stranger sends require dstHelloTag');
      const their = this.peerHelloBundles.get(bytesToHex(opts.dstHelloTag));
      if (!their) throw new Error('unknown hello bundle for tag');
      const init = x3dhInitiate(null, { kind: 'hello', ephX: their.ephX, ephPq: their.ephPq });
      ratchet = DoubleRatchet.initAsSender(init.sharedSecret, init.recipientDhPub);
      initHeader = init.header;
      dstTag = opts.dstHelloTag;
      conversationTag = randomBytes(8);
      srcTag = conversationTag;
      sessionKey = 'stranger:' + bytesToHex(conversationTag);
    }

    if (sessionKey) {
      this.sessions.set(sessionKey, { ratchet, contactId, conversationTag, createdAt: this.now() });
      if (contactId) await this.store.putSession(contactId, ratchet.serialize());
    }

    const { wire } = sessionEncrypt(ratchet, plaintext, ad, initHeader);
    // Persist the ratchet AFTER each send so a restart resumes from the exact
    // chain state (otherwise a restored sender replays already-consumed keys).
    if (contactId) await this.store.putSession(contactId, ratchet.serialize());
    const env: Envelope = {
      type: TYPE_MSG,
      priority,
      flags: FLAG_E2E | (initHeader ? FLAG_SESSION_INIT | FLAG_PQ_HYBRID : 0),
      hopLimit: sos ? SOS_HOP_LIMIT : DEFAULT_HOP_LIMIT,
      hopCount: 0,
      expiresInSec: sos ? SOS_EXPIRES_SEC : DEFAULT_EXPIRES_SEC,
      sprayCopies: DEFAULT_SPRAY_COPIES,
      msgId,
      srcTag,
      dstTag,
      payload: padToBucket(priority, wire),
    };

    const record: MessageRecord = {
      id: bytesToHex(msgId),
      contactId: contactId ?? 'stranger:' + bytesToHex(conversationTag ?? dstTag),
      direction: 'out',
      kind: sos ? 'sos' : kind,
      body,
      media: opts.media ?? null,
      targetId: opts.targetId ?? null,
      priority,
      ts: this.now(),
      status: 'queued',
    };
    await this.store.putMessage(record);
    const accepted = this.queue.push(env, this.now());
    if (!accepted) {
      await this.store.setMessageStatus(record.id, 'failed');
      this.events.onDeliveryChanged?.(record.id, 'failed');
    } else {
      await this.store.putQueueItem(queueRecordFromEnvelope(env, env.sprayCopies, false, this.now()));
      this.events.onMessagesChanged?.();
      this.pumpQueue();
    }
    return record.id;
  }

  /** Opportunistic pump: direct-hit delivery plus inventory-less gossip. */
  private pumpQueue(): void {
    void this.pushToPeers();
  }

  private deliverItem(link: Link, item: QueueItem): void {
    this.sendOnLink(link, encodeEnvelope(item.env));
    item.copies = 0; // direct hit: stop spraying this item elsewhere
    void this.markHanded(item.env);
  }

  private async markHanded(env: Envelope): Promise<void> {
    const id = bytesToHex(env.msgId);
    const m = await this.store.getMessage(id);
    if (m && m.status === 'queued') {
      await this.store.setMessageStatus(id, 'handed');
      this.events.onDeliveryChanged?.(id, 'handed');
    }
  }

  private async flushAckBatch(): Promise<void> {
    for (const [dstTagHex, batch] of [...this.pendingAcks]) {
      this.pendingAcks.delete(dstTagHex);
      if (batch.ids.length === 0) continue;
      const env: Envelope = {
        type: TYPE_ACK,
        priority: PRIO_TEXT,
        flags: 0,
        hopLimit: DEFAULT_HOP_LIMIT,
        hopCount: 0,
        expiresInSec: EPHEMERAL_EXPIRES_SEC,
        sprayCopies: DEFAULT_SPRAY_COPIES,
        msgId: randomBytes(8),
        srcTag: batch.srcTag,
        dstTag: hexToBytes(dstTagHex),
        payload: encodeAckBatch(batch.ids.map(hexToBytes)),
      };
      const accepted = this.queue.push(env, this.now());
      if (accepted) {
        await this.store.putQueueItem(queueRecordFromEnvelope(env, env.sprayCopies, false, this.now()));
        for (const link of this.securedLinks()) {
          if (link.peerTag && bytesEqual(link.peerTag, env.dstTag)) {
            this.deliverItem(link, {
              env,
              bytes: encodeEnvelope(env),
              createdAt: this.now(),
              copies: env.sprayCopies,
              forMe: false,
              sizeBucket: env.priority,
            });
          }
        }
      }
    }
  }

  // ------------------------------------------------------------ receiving

  private async handleEnvelopeBytes(linkId: string, buf: Uint8Array): Promise<void> {
    let env: Envelope;
    try {
      env = decodeEnvelope(buf);
    } catch {
      return;
    }
    ageEnvelope(env, 0);
    if (!this.dedup.checkAndAdd(env.msgId)) return;
    switch (env.type) {
      case TYPE_HELLO:
        await this.handleHello(linkId, env);
        break;
      case TYPE_MSG:
        await this.handleMsg(env);
        break;
      case TYPE_ACK:
        await this.handleAck(env);
        break;
      case TYPE_INVENTORY:
        await this.handleInventory(linkId, env);
        break;
      case TYPE_REQUEST:
        await this.handleRequest(linkId, env);
        break;
    }
  }

  private async handleHello(linkId: string, env: Envelope): Promise<void> {
    let body;
    try {
      body = decodeHello(env.payload);
    } catch {
      return;
    }
    const tagHex = bytesToHex(env.srcTag);
    this.peerHelloBundles.set(tagHex, { ephX: body.ephX, ephPq: body.ephPq, at: this.now() });
    const link = this.links.get(linkId);
    if (link) link.peerTag = env.srcTag;
    await this.store.logEvent({ ts: this.now(), kind: 'peer-seen', detail: `tag=${tagHex.slice(0, 8)} caps=${body.caps}` });
    const inv = this.queue.buildInventory(64);
    if (inv.length > 0) {
      const invEnv: Envelope = {
        type: TYPE_INVENTORY,
        priority: PRIO_TEXT,
        flags: 0,
        hopLimit: 1,
        hopCount: 0,
        expiresInSec: EPHEMERAL_EXPIRES_SEC,
        sprayCopies: 0,
        msgId: randomBytes(8),
        srcTag: ZERO8,
        dstTag: env.srcTag,
        payload: encodeInventory(inv),
      };
      this.sendToLinkId(linkId, invEnv);
    }
    this.events.onLinksChanged?.();
  }

  private async handleMsg(env: Envelope): Promise<void> {
    const forMe = await this.matchesMyTags(env.dstTag);
    const isInit = (env.flags & FLAG_SESSION_INIT) !== 0;
    if (!forMe && !isInit) {
      await this.relayOrDrop(env);
      return;
    }
    let ctx = await this.resolveInboundSession(env);
    if (!ctx && isInit) {
      // Session-init addressed to a tag we cannot map (e.g. the sender paired
      // via QR from our published bundle, so we hold their prekey). Attempting
      // the X3DH is cheap and gated; failure falls through to relay/drop.
      if (!this.incomingRate.allow('init', this.now())) return;
      ctx = await this.tryUnmatchedInit(env);
    }
    if (!ctx) {
      if (!forMe) await this.relayOrDrop(env);
      return;
    }
    const { body: wire } = decodeSessionWire(env.payload);
    let plaintext: Uint8Array;
    try {
      plaintext = ctx.ratchet.decrypt(wire, concat(new Uint8Array([TYPE_MSG, env.priority]), env.msgId));
    } catch {
      return;
    }
    if (ctx.sessionKey && !ctx.sessionKey.startsWith('stranger')) {
      await this.store.putSession(ctx.sessionKey, ctx.ratchet.serialize());
    }
    await this.acceptPlaintext(ctx, env, plaintext);
    this.enqueueAck(env);
  }

  private enqueueAck(env: Envelope): void {
    const dstTagHex = bytesToHex(env.srcTag);
    const entry = this.pendingAcks.get(dstTagHex) ?? { ids: [], srcTag: env.dstTag };
    entry.ids.push(bytesToHex(env.msgId));
    this.pendingAcks.set(dstTagHex, entry);
    this.flushAckBatch();
  }

  private async relayOrDrop(env: Envelope): Promise<void> {
    const rateOk = this.incomingRate.allow('relay:' + bytesToHex(env.srcTag), this.now());
    const decision = relayDecision(this.policy, env, {
      isForMe: false,
      circleAuthOk: this.circleKeys.length > 0 && this.verifyCircleAuth(env),
      link: { linkId: '', peerTag: null, wifi: true, charging: true },
      rateOk,
    });
    if (!decision.relay) {
      await this.store.logEvent({ ts: this.now(), kind: 'relay-forward', detail: `drop ${decision.reason}` });
      return;
    }
    if (this.queue.overPerPeer(env)) return;
    if (!this.queue.push(env, this.now())) return;
    await this.store.putQueueItem(queueRecordFromEnvelope(env, env.sprayCopies, false, this.now()));
    this.suppression.startJitter(env.msgId, 400, this.now());
    await this.store.logEvent({ ts: this.now(), kind: 'relay-forward', detail: `store ${bytesToHex(env.msgId).slice(0, 8)} copies=${env.sprayCopies} ttl=${env.expiresInSec}s` });
    this.events.onMessagesChanged?.();
  }

  private verifyCircleAuth(env: Envelope): boolean {
    if (env.payload.length < 8) return false;
    const body = env.payload.slice(0, env.payload.length - 8);
    const mac = env.payload.slice(env.payload.length - 8);
    const epoch = currentEpoch(this.now());
    for (const e of [epoch - 1, epoch, epoch + 1]) {
      for (const key of this.circleKeys) {
        if (bytesEqual(circleMac(key, e, body), mac)) return true;
      }
    }
    return false;
  }

  private async handleAck(env: Envelope): Promise<void> {
    const forMe = await this.matchesMyTags(env.dstTag);
    if (!forMe) {
      await this.relayOrDrop(env);
      return;
    }
    let ids: Uint8Array[];
    try {
      ids = decodeAckBatch(env.payload);
    } catch {
      return;
    }
    for (const id of ids) {
      const hex = bytesToHex(id);
      await this.store.setMessageStatus(hex, 'delivered');
      this.events.onDeliveryChanged?.(hex, 'delivered');
      this.queue.drop(id, 'acked');
      await this.store.deleteQueueItem(hex);
      this.retried.add(hex);
      // An ACK for a conversation-tag message proves the peer received our
      // first E2E message (and thus our identity key): complete the hand-off
      // to pairwise tags on our side.
      const rec = await this.store.getMessage(hex);
      if (rec && rec.direction === 'out' && rec.contactId.startsWith('stranger:')) {
        const realId = this.convTagToContact.get(rec.contactId.slice('stranger:'.length));
        if (realId) {
          const c = await this.getContact(realId);
          if (c && c.strangerTag) {
            c.strangerTag = null;
            await this.store.putContact(c);
            this.contactCache.set(realId, c);
          }
          const sess = this.sessions.get(realId);
          if (sess) sess.conversationTag = undefined;
        }
      }
    }
    this.events.onMessagesChanged?.();
  }

  private async handleInventory(linkId: string, env: Envelope): Promise<void> {
    let entries: InventoryEntry[];
    try {
      entries = decodeInventory(env.payload);
    } catch {
      return;
    }
    for (const e of entries) {
      // Count DISTINCT relay peers so repeated inventories from the same
      // neighbor do not inflate the broadcast-storm counter.
      const link = this.links.get(linkId);
      const peerKey = link?.peerTag ? bytesToHex(link.peerTag) : linkId;
      this.suppression.observeRelay(e.msgId, peerKey);
    }

    const mine = await this.filterMyTags(entries.map((e) => e.dstTag));
    const mineSet = new Set(mine.map(bytesToHex));
    const wanted = entries.filter((e) => mineSet.has(bytesToHex(e.dstTag))).map((e) => e.msgId);
    if (wanted.length > 0) {
      const reqEnv: Envelope = {
        type: TYPE_REQUEST,
        priority: PRIO_TEXT,
        flags: 0,
        hopLimit: 1,
        hopCount: 0,
        expiresInSec: EPHEMERAL_EXPIRES_SEC,
        sprayCopies: 0,
        msgId: randomBytes(8),
        srcTag: ZERO8,
        dstTag: env.srcTag,
        payload: encodeRequestBatch(wanted),
      };
      this.sendToLinkId(linkId, reqEnv);
    }
    await this.pushToPeers();
  }

  /** Gossip push: send to links whose peer misses the item, with suppression. */
  private async pushToPeers(): Promise<void> {
    const links = this.securedLinks();
    for (const item of this.queue.listAll()) {
      if (item.forMe) continue;
      if (!this.suppression.shouldRelay(item.env.msgId, 2, this.now())) continue;
      const copies = copiesForDestination(item, Math.max(1, links.length));
      let sentTo = 0;
      for (const link of links) {
        if (link.peerTag && item.copies > 0 && bytesEqual(link.peerTag, item.env.dstTag)) {
          this.deliverItem(link, item);
          sentTo++;
        } else if (copies > 0) {
          this.sendOnLink(link, encodeEnvelope(item.env));
          await this.markHanded(item.env);
          sentTo++;
        }
      }
      if (sentTo > 0 && copies > 0 && item.copies > 0) {
        item.copies = Math.max(0, item.copies - copies);
      }
    }
    this.flushAckBatch();
  }

  private async handleRequest(linkId: string, env: Envelope): Promise<void> {
    let ids: Uint8Array[];
    try {
      ids = decodeRequestBatch(env.payload);
    } catch {
      return;
    }
    for (const id of ids.slice(0, 16)) {
      const item = this.queue.get(id);
      if (!item || item.forMe || item.copies <= 0) continue;
      item.copies -= 1;
      this.sendToLinkId(linkId, item.env);
      await this.markHanded(item.env);
    }
  }

  // ------------------------------------------------------- inbound sessions

  private async resolveInboundSession(env: Envelope): Promise<{ ratchet: DoubleRatchet; contactId: string | null; sessionKey: string | null; viaStranger: boolean } | null> {
    const dstHex = bytesToHex(env.dstTag);
    const parsed = decodeSessionWire(env.payload);
    // a) Our HELLO tag: stranger session (init) or continuation.
    const hello = this.helloTags.get(dstHex);
    if (hello) {
      if (parsed.isInit && parsed.init) {
        const r = await this.initFromHello(env, hello, parsed.init);
        return r ? { ...r, viaStranger: true } : null;
      }
      const existing = this.sessions.get('strangerIn:' + bytesToHex(env.srcTag));
      if (existing) return { ratchet: existing.ratchet, contactId: existing.contactId, sessionKey: 'strangerIn:' + bytesToHex(env.srcTag), viaStranger: true };
      return null;
    }
    // b) Our conversation tag (either side of a stranger conversation).
    for (const [key, sess] of this.sessions) {
      if (sess.conversationTag && bytesEqual(sess.conversationTag, env.dstTag)) {
        return { ratchet: sess.ratchet, contactId: sess.contactId, sessionKey: key, viaStranger: true };
      }
    }
    // c) Pairwise tag -> contact. A pairwise-tagged message also proves the
    // peer has switched off the conversation tag, completing the hand-off.
    const contact = await this.contactByTag(env.dstTag);
    if (contact) {
      const existing = this.sessions.get(contact.id);
      if (existing && !parsed.isInit) {
        if (contact.strangerTag) {
          contact.strangerTag = null;
          await this.store.putContact(contact);
          this.contactCache.set(contact.id, contact);
        }
        existing.conversationTag = undefined;
        return { ratchet: existing.ratchet, contactId: contact.id, sessionKey: contact.id, viaStranger: false };
      }
      if (parsed.isInit && parsed.init) {
        const r = await this.initFromPaired(contact, parsed.init);
        return r ? { ...r, viaStranger: false } : null;
      }
    }
    return null;
  }

  /**
   * Session-init addressed to a tag we cannot map, but carrying a bundle id
   * that matches OUR published paired bundle. This happens when the sender
   * scanned our QR and we have no contact record for them yet: we hold the
   * matching prekey secrets, so the X3DH attempt succeeds and the stranger
   * handshake completes without any prior relationship.
   */
  private async tryUnmatchedInit(env: Envelope): Promise<{ ratchet: DoubleRatchet; contactId: null; sessionKey: string; viaStranger: boolean } | null> {
    if (!this.prekeys) return null;
    let parsed: ReturnType<typeof decodeSessionWire>;
    try {
      parsed = decodeSessionWire(env.payload);
    } catch {
      return null;
    }
    if (!parsed.isInit || !parsed.init) return null;
    const myBundleId = bundleIdOf({
      kind: 'paired',
      dhPub: this.identity.dhPub,
      spk: hexToBytes(this.prekeys.spkPub),
      spkSig: new Uint8Array(0),
      opk: null,
      pqPk: hexToBytes(this.prekeys.pqPk),
    });
    if (!bytesEqual(parsed.init.bundleId, myBundleId)) return null;
    const opkPriv = bytesEqual(parsed.init.opkHint, ZERO32) ? null : this.consumeOpk(parsed.init.opkHint);
    const secrets: BundleSecrets = {
      kind: 'paired',
      spkPriv: hexToBytes(this.prekeys.spkPriv),
      opkPriv,
      pqSk: hexToBytes(this.prekeys.pqSk),
      identityDhPriv: this.identity.dhPriv,
    };
    let shared: Uint8Array;
    try {
      shared = x3dhReceive(secrets, parsed.init).sharedSecret;
    } catch {
      return null;
    }
    const tempKey = 'strangerIn:' + bytesToHex(env.srcTag);
    const ratchet = DoubleRatchet.initAsReceiver(shared, { priv: hexToBytes(this.prekeys.spkPriv), pub: hexToBytes(this.prekeys.spkPub) });
    this.sessions.set(tempKey, { ratchet, contactId: null, createdAt: this.now() });
    return { ratchet, contactId: null, sessionKey: tempKey, viaStranger: false };
  }

  /** New session from a paired contact's session-init header. */
  private async initFromPaired(contact: ContactRecord, init: SessionInitHeader): Promise<{ ratchet: DoubleRatchet; contactId: string; sessionKey: string } | null> {
    if (!this.prekeys) return null;
    const opkPriv = bytesEqual(init.opkHint, ZERO32) ? null : this.consumeOpk(init.opkHint);
    const secrets: BundleSecrets = {
      kind: 'paired',
      spkPriv: hexToBytes(this.prekeys.spkPriv),
      opkPriv,
      pqSk: hexToBytes(this.prekeys.pqSk),
      identityDhPriv: this.identity.dhPriv,
    };
    let shared: Uint8Array;
    try {
      shared = x3dhReceive(secrets, init).sharedSecret;
    } catch {
      return null;
    }
    const ratchet = DoubleRatchet.initAsReceiver(shared, { priv: hexToBytes(this.prekeys.spkPriv), pub: hexToBytes(this.prekeys.spkPub) });
    const entry: SessionEntry = { ratchet, contactId: contact.id, createdAt: this.now() };
    this.sessions.set(contact.id, entry);
    await this.store.putSession(contact.id, ratchet.serialize());
    return { ratchet, contactId: contact.id, sessionKey: contact.id };
  }

  /** New session from a stranger using one of our advertised HELLO bundles. */
  private async initFromHello(
    env: Envelope,
    hello: { bundleId: string; secrets: { ephXPriv: Uint8Array; ephPqSk: Uint8Array; ephX: Uint8Array; ephPq: Uint8Array } },
    init: SessionInitHeader,
  ): Promise<{ ratchet: DoubleRatchet; contactId: string | null; sessionKey: string } | null> {
    if (!bytesEqual(init.bundleId, hexToBytes(hello.bundleId))) return null;
    const secrets: BundleSecrets = { kind: 'hello', ephXPriv: hello.secrets.ephXPriv, ephPqSk: hello.secrets.ephPqSk };
    let shared: Uint8Array;
    try {
      shared = x3dhReceive(secrets, init).sharedSecret;
    } catch {
      return null;
    }
    const tempKey = 'strangerIn:' + bytesToHex(env.srcTag);
    const ratchet = DoubleRatchet.initAsReceiver(shared, { priv: hello.secrets.ephXPriv, pub: hello.secrets.ephX });
    // conversationTag = the peer's conversation tag, so replies they send to
    // their own tag still resolve here after this session is promoted.
    this.sessions.set(tempKey, { ratchet, contactId: null, conversationTag: hexToBytes(tempKey.slice('strangerIn:'.length)), createdAt: this.now() });
    return { ratchet, contactId: null, sessionKey: tempKey };
  }

  private async acceptPlaintext(
    ctx: { ratchet: DoubleRatchet; contactId: string | null; sessionKey: string | null; viaStranger: boolean },
    env: Envelope,
    plaintext: Uint8Array,
  ): Promise<void> {
    let payload: E2EPayload;
    try {
      payload = JSON.parse(new TextDecoder().decode(plaintext)) as E2EPayload;
    } catch {
      return;
    }
    if (!payload || typeof payload.k !== 'string' || typeof payload.s !== 'string' || typeof payload.sig !== 'string') return;
    const signPub = hexToBytes(payload.s);
    if (signPub.length !== 32) return;
    const { sig, ...rest } = payload;
    if (!verifyBytes(signPub, payloadSigningBytes(rest), hexToBytes(payload.sig))) {
      this.events.onSecurityWarning?.('bad-signature', null);
      return;
    }

    const senderId = payload.s;
    let contact = await this.getContact(senderId);
    if (!contact) {
      const dhRemote = payload.d ? hexToBytes(payload.d) : null;
      const pairwise = dhRemote && dhRemote.length === 32 ? bytesToB64(pairwiseSecret(this.identity, dhRemote)) : '';
      contact = {
        id: senderId,
        name: payload.n || 'Unknown',
        signPub: senderId,
        dhPub: dhRemote ? bytesToHex(dhRemote) : '',
        pairwise,
        bundle: null,
        safetyNumber: safetyNumber(this.identity.signPub, signPub),
        trusted: false,
        blocked: false,
        verified: false,
        lastSeen: this.now(),
        addedAt: this.now(),
      };
      await this.store.putContact(contact);
      this.contactCache.set(senderId, contact);
      this.events.onContactsChanged?.();
    } else {
      contact.lastSeen = this.now();
      if (payload.d && contact.dhPub !== payload.d) {
        contact.dhPub = payload.d;
        contact.pairwise = bytesToB64(pairwiseSecret(this.identity, hexToBytes(payload.d)));
      }
      if (payload.n && contact.name === 'Unknown' && payload.n) {
        contact.name = payload.n;
      }
    }
    // Conversation-tag return address: while this is a stranger conversation
    // (not yet on pairwise tags), replies go back under the peer's tag.
    if (ctx.viaStranger && !contact.trusted) {
      contact.strangerTag = bytesToHex(env.srcTag);
    }
    await this.store.putContact(contact);
    this.contactCache.set(senderId, contact);
    if (contact.blocked) return;

    // Promote stranger temp session to the contact session, keeping the
    // conversation tag so both sides can still address each other by it.
    if (ctx.sessionKey && ctx.sessionKey.startsWith('stranger')) {
      const prev = this.sessions.get(ctx.sessionKey);
      this.sessions.delete(ctx.sessionKey);
      ctx.sessionKey = senderId;
      ctx.contactId = senderId;
      this.sessions.set(senderId, { ratchet: ctx.ratchet, contactId: senderId, conversationTag: prev?.conversationTag, createdAt: this.now() });
      await this.store.putSession(senderId, ctx.ratchet.serialize());
      if (prev?.conversationTag) this.convTagToContact.set(bytesToHex(prev.conversationTag), senderId);
    }

    const status: MessageStatus = contact.trusted ? 'delivered' : 'request';
    const record: MessageRecord = {
      id: bytesToHex(env.msgId),
      contactId: senderId,
      direction: 'in',
      kind: payload.k,
      body: payload.b ?? '',
      media: payload.m ?? null,
      targetId: payload.t ?? null,
      priority: env.priority,
      ts: payload.ts ?? this.now(),
      status,
    };
    await this.store.putMessage(record);
    if (status === 'request') this.events.onMessageRequest?.(record);
    if (record.kind === 'sos') this.events.onSos?.(record);
    if (payload.k === 'receipt' && payload.t) {
      await this.store.setMessageStatus(payload.t, 'read');
      this.events.onDeliveryChanged?.(payload.t, 'read');
    }
    if (payload.k === 'profile' && payload.m) {
      try {
        const bundle = JSON.parse(payload.m) as { spk: string; spkSig: string; opk: string | null; pqPk: string };
        contact.bundle = { spk: bundle.spk, spkSig: bundle.spkSig, opk: bundle.opk, pqPk: bundle.pqPk, bundleId: bundleIdHexFrom({ spk: bundle.spk, pqPk: bundle.pqPk }) };
        await this.store.putContact(contact);
        this.contactCache.set(senderId, contact);
      } catch {
        /* ignore malformed profile */
      }
    }
    this.events.onMessagesChanged?.();
    await this.store.logEvent({ ts: this.now(), kind: 'session', detail: `msg ${record.id.slice(0, 8)} from ${senderId.slice(0, 8)}` });
  }

  // ---------------------------------------------------------------- helpers

  private async contactByTag(tag: Uint8Array): Promise<ContactRecord | null> {
    for (const contact of this.contactCache.values()) {
      if (!contact.pairwise) continue;
      if (tagsForNow(hexToBytes(contact.pairwise), this.now()).some((t) => bytesEqual(t, tag))) return contact;
    }
    return null;
  }

  private tagForContact(contact: ContactRecord): Uint8Array {
    return epochTag(hexToBytes(contact.pairwise), currentEpoch(this.now()));
  }

  private async matchesMyTags(tag: Uint8Array): Promise<boolean> {
    if (await this.contactByTag(tag)) return true;
    const dstHex = bytesToHex(tag);
    if (this.helloTags.has(dstHex)) return true;
    if (this.replylessCheck(tag)) return true;
    return false;
  }

  private replylessCheck(tag: Uint8Array): boolean {
    for (const sess of this.sessions.values()) {
      if (sess.conversationTag && bytesEqual(sess.conversationTag, tag)) return true;
    }
    return false;
  }

  private async filterMyTags(tags: Uint8Array[]): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    for (const t of tags) if (await this.matchesMyTags(t)) out.push(t);
    return out;
  }

  private async getContact(id: string): Promise<ContactRecord | null> {
    const cached = this.contactCache.get(id);
    if (cached) return cached;
    const c = await this.store.getContact(id);
    if (c) this.contactCache.set(id, c);
    return c;
  }

  private async loadContacts(): Promise<void> {
    for (const c of await this.store.listContacts()) this.contactCache.set(c.id, c);
  }

  private async restoreSessions(): Promise<void> {
    for (const c of this.contactCache.values()) {
      const json = await this.store.getSession(c.id);
      if (json) {
        try {
          this.sessions.set(c.id, { ratchet: DoubleRatchet.deserialize(json), contactId: c.id, createdAt: this.now() });
        } catch {
          /* corrupt session: drop, re-init on demand */
        }
      }
    }
  }

  private async restoreQueue(): Promise<void> {
    for (const q of await this.store.listQueueItems()) {
      const env = envelopeFromRecord(q);
      if (env.expiresInSec <= 0) {
        await this.store.deleteQueueItem(q.msgId);
        continue;
      }
      this.queue.push(env, this.now());
    }
  }

  /** Periodic maintenance driven by the node clock. */
  tick(): void {
    if (!this.started) return;
    const now = this.now();
    this.queue.expireExpired(now);
    this.suppression.prune(now);
    this.reassembler.prune();
    this.flushAckBatch();
    if (now - this.lastHelloAt >= this.helloIntervalMs) {
      void this.broadcastHello();
      this.pumpQueue();
    }
  }

  /** Test/simulator hook: run gossip push immediately. */
  async gossip(): Promise<void> {
    await this.pushToPeers();
  }

  /** Diagnostic: hex tags of peer HELLO bundles we have learned (no contents). */
  peerHelloTags(): string[] {
    return [...this.peerHelloBundles.keys()];
  }

  /** Diagnostic: hex tags of our own advertised HELLO addresses. */
  ownHelloTags(): string[] {
    return [...this.helloTags.keys()];
  }

  /** Diagnostic: whether a hex tag is one of our own advertised HELLO addresses. */
  ownsHelloTag(tagHex: string): boolean {
    return this.helloTags.has(tagHex);
  }

  // ------------------------------------------------------------- contacts

  async setTrusted(contactId: string, trusted: boolean): Promise<void> {
    const c = await this.getContact(contactId);
    if (!c) return;
    c.trusted = trusted;
    await this.store.putContact(c);
    this.contactCache.set(contactId, c);
    this.events.onContactsChanged?.();
  }

  async setBlocked(contactId: string, blocked: boolean): Promise<void> {
    const c = await this.getContact(contactId);
    if (!c) return;
    c.blocked = blocked;
    if (blocked) {
      this.sessions.delete(contactId);
      await this.store.deleteSession(contactId);
    }
    await this.store.putContact(c);
    this.contactCache.set(contactId, c);
    this.events.onContactsChanged?.();
  }

  async setVerified(contactId: string, verified: boolean): Promise<void> {
    const c = await this.getContact(contactId);
    if (!c) return;
    c.verified = verified;
    await this.store.putContact(c);
    this.contactCache.set(contactId, c);
    this.events.onContactsChanged?.();
  }

  /** QR pairing: import a contact's published bundle (out of band). */
  async pairFromQr(data: { signPub: string; dhPub: string; name: string; spk: string; spkSig: string; opk: string | null; pqPk: string }): Promise<string> {
    const signPub = hexToBytes(data.signPub);
    if (signPub.length !== 32) throw new Error('bad identity key');
    const bundle: PrekeyBundle = {
      kind: 'paired',
      dhPub: hexToBytes(data.dhPub),
      spk: hexToBytes(data.spk),
      spkSig: hexToBytes(data.spkSig),
      opk: data.opk ? hexToBytes(data.opk) : null,
      pqPk: hexToBytes(data.pqPk),
    };
    if (!verifyPrekeyBundle(bundle, signPub)) throw new Error('prekey bundle signature invalid');
    const pairwise = bytesToB64(pairwiseSecret(this.identity, bundle.dhPub));
    const contact: ContactRecord = {
      id: bytesToHex(signPub),
      name: data.name,
      signPub: data.signPub,
      dhPub: data.dhPub,
      pairwise,
      bundle: { spk: data.spk, spkSig: data.spkSig, opk: data.opk, pqPk: data.pqPk, bundleId: bundleIdHexFrom({ spk: data.spk, pqPk: data.pqPk }) },
      safetyNumber: safetyNumber(this.identity.signPub, signPub),
      trusted: true,
      blocked: false,
      verified: false,
      lastSeen: 0,
      addedAt: this.now(),
    };
    await this.store.putContact(contact);
    this.contactCache.set(contact.id, contact);
    this.events.onContactsChanged?.();
    return contact.id;
  }

  /** Our QR payload (public keys + current prekey bundle; no secrets). */
  qrPayload(): string {
    return JSON.stringify(this.publishedBundle());
  }

  snapshot(): NodeSnapshot {
    return {
      started: this.started,
      links: [...this.links.values()].map((l) => ({
        id: l.id,
        transport: l.transport,
        secured: l.secured,
        peerTag: l.peerTag ? bytesToHex(l.peerTag).slice(0, 8) : null,
        establishedAt: l.establishedAt,
      })),
      queueSize: this.queue.size,
      queueBytes: this.queue.totalBytes,
      dedupSize: this.dedup.size,
      contacts: this.contactCache.size,
      epoch: currentEpoch(this.now()),
      relayEnabled: this.policy.relayEnabled,
      displayName: this.displayName,
    };
  }
}

function bundleIdHexFrom(parts: { spk: string; pqPk: string }): string {
  return bytesToHex(sha256Bytes(hexToBytes(parts.spk), hexToBytes(parts.pqPk)).slice(0, 8));
}

export { queueRecordFromEnvelope, envelopeFromRecord, bytesToB64, b64ToBytes, randomBytes, u32le, utf8, concat };
