/**
 * MeshLink discrete-event simulator.
 *
 * Drives the REAL MeshNode code (crypto, relay engine, protocol codec) against
 * a virtual radio: nodes move on a 2D plane, links form inside radio range and
 * break outside it, and every transmission is the exact bytes a phone would
 * put on the air. This is a SIMULATION — numbers produced here are labeled
 * Simulated in docs/METRICS.md, never Device-verified.
 *
 * Model boundaries (what this does and does not model):
 *  - Modeled: link churn from mobility, store-carry-forward delay, spray
 *    copies, dedup, suppression, relay policy, queue quotas, age-based
 *    expiry, full link-security handshakes per link establishment, node
 *    restarts (fresh in-memory discovery state, persisted crypto state).
 *  - Not modeled: radio interference/collisions, packet loss from RF physics,
 *    OS scheduling, battery thermal states, BLE connection setup latency,
 *    MTU-sized writes (links deliver whole frames atomically).
 *
 * Time model: a 1 Hz tick. The host injects the clock into every MeshNode
 * (`now`), so expiry, jitter and ratchet timestamps all use sim time. Node
 * timers are disabled (`noTimers`); the host calls tick()/gossip() on the
 * configured schedule, mirroring what the OS scheduler would do on a phone.
 */
import { MeshNode, type MeshNodeOptions } from '../node';
import { MemoryStore, type MessageRecord, type NetworkEventRecord } from '../store';
import { newIdentity, type Identity } from '../crypto';
import { hexToBytes } from '../bytes';

// ------------------------------------------------------------------ prng

/** Deterministic PRNG (mulberry32) so runs are reproducible from a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ config

export interface SimConfig {
  /** Scenario name for reporting. */
  name: string;
  seed: number;
  nodeCount: number;
  /** Square area side in meters. */
  areaM: number;
  radioRangeM: number;
  durationSec: number;
  /** Mobility speed in m/s (0 disables movement). */
  speedMps: number;
  /** How often each node runs its gossip pump (sim seconds). */
  gossipEverySec: number;
  /** How often each node runs its housekeeping tick (sim seconds). */
  tickEverySec: number;
  /** Number of point-to-point messages scheduled (ignored when `sends` is set). */
  messageCount: number;
  /** First send time and spacing (sim seconds). */
  firstSendSec: number;
  sendSpacingSec: number;
  relayEnabled: boolean;
  /** Optional explicit initial placement (meters); overrides random scatter. */
  positions?: Array<{ x: number; y: number }>;
  /**
   * For the first N seconds every node pair is linked regardless of range
   * (a gathering); afterwards normal radio-range rules apply. Models people
   * meeting in one place before dispersing, which seeds discovery state.
   */
  initialCloudSec?: number;
  /** Explicit send schedule; overrides the random schedule when present. */
  sends?: Array<{ from: number; to: number; atSec: number }>;
  /** Optional mid-run restarts of nodes (fresh process, same store+identity). */
  restarts?: Array<{ atSec: number; nodeIndex: number }>;
}

export interface MessageOutcome {
  id: string;
  from: number;
  to: number;
  sentAtSec: number;
  deliveredAtSec: number | null;
  latencySec: number | null;
  hopsObserved: number;
}

export interface SimResult {
  config: SimConfig;
  sentCount: number;
  deliveredCount: number;
  /** Delivered / sent (delivered at the recipient). */
  deliveryRatio: number;
  /** Scheduled sends that never fired because the pair never met in time. */
  givenUpCount: number;
  latenciesSec: number[];
  medianLatencySec: number | null;
  p90LatencySec: number | null;
  hopsMean: number | null;
  /** Total bytes pushed onto virtual links, including handshakes and HELLOs. */
  wireBytes: number;
  /** Wire bytes divided by delivered messages (relay overhead included). */
  bytesPerDelivered: number | null;
  linkUps: number;
  linkDowns: number;
  avgQueueSize: number;
  maxQueueSize: number;
  avgNeighbors: number;
  wallMs: number;
  outcomes: MessageOutcome[];
}

// ------------------------------------------------------------------ engine

interface SimNodeState {
  node: MeshNode;
  store: MemoryStore;
  identity: Identity;
  index: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface ScheduledSend {
  from: number;
  to: number;
  atSec: number;
  sentAtSec: number | null;
  id: string | null;
  givenUp: boolean;
}

/** How often (sim seconds) relay event logs are scanned for hop counting. */
const EVENT_SCAN_EVERY_SEC = 5;

export class SimEngine {
  private readonly cfg: SimConfig;
  private readonly rand: () => number;
  private readonly nodes: SimNodeState[] = [];
  private readonly linkIds = new Set<string>(); // "i|j" sorted
  private readonly sends: ScheduledSend[] = [];
  private readonly outcomes: MessageOutcome[] = [];
  private readonly eventCounts = { linkUps: 0, linkDowns: 0 };
  private wireBytes = 0;
  private queueSamples: number[] = [];
  private neighborSamples: number[] = [];
  private readonly t0 = 1_700_000_000_000;
  private clock = { value: this.t0 };
  /** Relay hops per message id prefix, from relay event logs. */
  private readonly hopCounts = new Map<string, number>();
  /** Per-node set of already-counted event signatures (stores trim old events). */
  private readonly eventsSeen = new Map<number, Set<string>>();

  constructor(cfg: SimConfig) {
    this.cfg = cfg;
    this.rand = mulberry32(cfg.seed);
    if (cfg.positions && cfg.positions.length !== cfg.nodeCount) {
      throw new Error('positions length must equal nodeCount');
    }
  }

  private nowSec(): number {
    return (this.clock.value - this.t0) / 1000;
  }

  private makeNodeOptions(displayName: string, store?: MemoryStore, identity?: Identity): MeshNodeOptions {
    return {
      identity: identity ?? newIdentity(),
      store: store ?? new MemoryStore(),
      displayName,
      now: () => this.clock.value,
      helloIntervalMs: 3_600_000,
      noTimers: true,
      helloTagCapacity: 256,
      policy: { relayEnabled: this.cfg.relayEnabled },
    };
  }

  /** Runs the whole scenario; awaits node work between steps. */
  async run(): Promise<SimResult> {
    const startWall = Date.now();
    const cfg = this.cfg;
    for (let i = 0; i < cfg.nodeCount; i++) {
      const opts = this.makeNodeOptions(`n${i}`);
      const node = new MeshNode(opts);
      await node.start();
      const p = cfg.positions?.[i];
      this.nodes.push({
        node,
        store: opts.store as MemoryStore,
        identity: opts.identity as Identity,
        index: i,
        x: p ? p.x : this.rand() * cfg.areaM,
        y: p ? p.y : this.rand() * cfg.areaM,
        vx: 0,
        vy: 0,
      });
    }

    // Schedule point-to-point stranger messages (explicit or random pairs).
    if (cfg.sends) {
      for (const s of cfg.sends) {
        this.sends.push({ from: s.from, to: s.to, atSec: s.atSec, sentAtSec: null, id: null, givenUp: false });
      }
    } else {
      for (let m = 0; m < cfg.messageCount; m++) {
        const from = Math.floor(this.rand() * cfg.nodeCount);
        let to = Math.floor(this.rand() * cfg.nodeCount);
        if (to === from) to = (to + 1) % cfg.nodeCount;
        this.sends.push({ from, to, atSec: cfg.firstSendSec + m * cfg.sendSpacingSec, sentAtSec: null, id: null, givenUp: false });
      }
    }

    const restartAt = new Map<number, number[]>(); // simSec -> node indexes
    for (const r of cfg.restarts ?? []) {
      const list = restartAt.get(r.atSec) ?? [];
      list.push(r.nodeIndex);
      restartAt.set(r.atSec, list);
    }

    const endSec = cfg.durationSec;
    for (let t = 0; t <= endSec; t++) {
      this.clock.value = this.t0 + t * 1000;
      const dueRestarts = restartAt.get(t);
      if (dueRestarts) for (const idx of dueRestarts) await this.applyRestart(idx);
      this.mobilityStep();
      await this.radioStep(t);
      await this.sendStep();
      if (t % cfg.tickEverySec === 0) for (const n of this.nodes) n.node.tick();
      if (cfg.gossipEverySec > 0 && t % cfg.gossipEverySec === 0) {
        for (const n of this.nodes) await n.node.gossip();
      }
      await this.collectStep(t);
      this.sampleStep();
    }

    for (const n of this.nodes) n.node.stop();

    const outcomes = this.outcomes.slice().sort((a, b) => a.sentAtSec - b.sentAtSec);
    const latencies = outcomes.filter((o) => o.latencySec !== null).map((o) => o.latencySec as number).sort((a, b) => a - b);
    const delivered = outcomes.filter((o) => o.deliveredAtSec !== null).length;
    const hops = outcomes.filter((o) => o.deliveredAtSec !== null).map((o) => o.hopsObserved);
    return {
      config: cfg,
      sentCount: outcomes.length,
      deliveredCount: delivered,
      deliveryRatio: outcomes.length ? delivered / outcomes.length : 0,
      givenUpCount: this.sends.filter((s) => s.givenUp).length,
      latenciesSec: latencies,
      medianLatencySec: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
      p90LatencySec: latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.9))] : null,
      hopsMean: hops.length ? hops.reduce((a, b) => a + b, 0) / hops.length : null,
      wireBytes: this.wireBytes,
      bytesPerDelivered: delivered ? Math.round(this.wireBytes / delivered) : null,
      linkUps: this.eventCounts.linkUps,
      linkDowns: this.eventCounts.linkDowns,
      avgQueueSize: this.queueSamples.length ? this.queueSamples.reduce((a, b) => a + b, 0) / this.queueSamples.length : 0,
      maxQueueSize: this.queueSamples.length ? Math.max(...this.queueSamples) : 0,
      avgNeighbors: this.neighborSamples.length ? this.neighborSamples.reduce((a, b) => a + b, 0) / this.neighborSamples.length : 0,
      wallMs: Date.now() - startWall,
      outcomes,
    };
  }

  // ------------------------------------------------------------- sim steps

  private mobilityStep(): void {
    const { speedMps, areaM } = this.cfg;
    if (speedMps <= 0) return;
    for (const n of this.nodes) {
      // Random-walk mobility: occasionally pick a new heading.
      if (this.rand() < 0.02) {
        const angle = this.rand() * Math.PI * 2;
        n.vx = Math.cos(angle) * speedMps;
        n.vy = Math.sin(angle) * speedMps;
      }
      n.x += n.vx;
      n.y += n.vy;
      // Reflective walls keep the crowd mixed (a clamp would park nodes at
      // the boundary and isolate them).
      if (n.x <= 0 || n.x >= areaM) {
        n.x = Math.min(areaM, Math.max(0, n.x));
        n.vx = -n.vx;
      }
      if (n.y <= 0 || n.y >= areaM) {
        n.y = Math.min(areaM, Math.max(0, n.y));
        n.vy = -n.vy;
      }
    }
  }

  /** Form and break links by radio range; each link runs the real handshake. */
  private async radioStep(tSec: number): Promise<void> {
    const cloud = this.cfg.initialCloudSec !== undefined && tSec < this.cfg.initialCloudSec;
    const inRange = new Set<string>();
    if (cloud) {
      for (let i = 0; i < this.nodes.length; i++) {
        for (let j = i + 1; j < this.nodes.length; j++) inRange.add(`${i}|${j}`);
      }
    } else {
      const range2 = this.cfg.radioRangeM * this.cfg.radioRangeM;
      for (let i = 0; i < this.nodes.length; i++) {
        for (let j = i + 1; j < this.nodes.length; j++) {
          const a = this.nodes[i];
          const b = this.nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          if (dx * dx + dy * dy <= range2) inRange.add(`${i}|${j}`);
        }
      }
    }
    // Break links that left range.
    for (const key of [...this.linkIds]) {
      if (inRange.has(key)) continue;
      this.linkIds.delete(key);
      const [i, j] = key.split('|').map(Number);
      this.nodes[i].node.unregisterLink(this.linkId(i, j));
      this.nodes[j].node.unregisterLink(this.linkId(j, i));
      this.eventCounts.linkDowns++;
    }
    // Form links that came into range.
    for (const key of inRange) {
      if (this.linkIds.has(key)) continue;
      this.linkIds.add(key);
      this.eventCounts.linkUps++;
      const [i, j] = key.split('|').map(Number);
      this.wirePair(this.nodes[i], this.nodes[j]);
      // Let the handshake + HELLO exchange settle. Macrotask yields so the
      // host process stays responsive (pure microtask churn starves IPC).
      for (let k = 0; k < 4; k++) await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  private linkId(i: number, j: number): string {
    return `l-${i}-${j}`;
  }

  private wirePair(a: SimNodeState, b: SimNodeState): void {
    const idA = this.linkId(a.index, b.index);
    const idB = this.linkId(b.index, a.index);
    b.node.registerLink(idB, 'sim', (bytes) => {
      this.wireBytes += bytes.length;
      void a.node.ingest(idA, bytes);
    }, false);
    a.node.registerLink(idA, 'sim', (bytes) => {
      this.wireBytes += bytes.length;
      void b.node.ingest(idB, bytes);
    }, true);
  }

  /**
   * Restarts a node: same store and identity (persisted sessions, queue,
   * contacts survive), but a fresh process — discovery tags and HELLO
   * secrets are gone, exactly like a phone reboot.
   */
  private async applyRestart(idx: number): Promise<void> {
    const state = this.nodes[idx];
    state.node.stop();
    for (const key of [...this.linkIds]) {
      const [i, j] = key.split('|').map(Number);
      if (i !== idx && j !== idx) continue;
      this.linkIds.delete(key);
      this.nodes[i].node.unregisterLink(this.linkId(i, j));
      this.nodes[j].node.unregisterLink(this.linkId(j, i));
    }
    const node = new MeshNode(this.makeNodeOptions(`n${idx}`, state.store, state.identity));
    await node.start();
    state.node = node;
  }

  /** Fires scheduled sends once the sender has learned the recipient's HELLO. */
  private async sendStep(): Promise<void> {
    for (const s of this.sends) {
      if (s.sentAtSec !== null || s.givenUp) continue;
      if (this.nowSec() < s.atSec) continue;
      const a = this.nodes[s.from];
      const b = this.nodes[s.to];
      // The sender must have learned a HELLO address the recipient still owns.
      const tag = a.node.peerHelloTags().find((t) => b.node.ownsHelloTag(t));
      if (!tag) {
        if (this.nowSec() > s.atSec + 120) {
          s.givenUp = true; // the pair never met inside the window
        }
        continue;
      }
      s.sentAtSec = this.nowSec();
      s.id = await a.node.sendMessage(null, 'text', `sim-${s.from}->${s.to}`, { dstHelloTag: hexToBytes(tag) });
      this.outcomes.push({
        id: s.id,
        from: s.from,
        to: s.to,
        sentAtSec: s.sentAtSec,
        deliveredAtSec: null,
        latencySec: null,
        hopsObserved: 0,
      });
    }
  }

  /** Checks recipient stores for accepted messages; counts relay hops. */
  private async collectStep(tSec: number): Promise<void> {
    if (tSec % EVENT_SCAN_EVERY_SEC === 0) await this.scanRelayEvents();
    for (const o of this.outcomes) {
      if (o.deliveredAtSec !== null) continue;
      const rec: MessageRecord | null = await this.nodes[o.to].store.getMessage(o.id!);
      if (rec) {
        o.deliveredAtSec = this.nowSec();
        o.latencySec = o.deliveredAtSec - o.sentAtSec;
        o.hopsObserved = this.hopCounts.get(o.id!.slice(0, 8)) ?? 0;
      }
    }
  }

  /** Relay hops per message: every relaying node logs `store <msgIdPrefix>`. */
  private async scanRelayEvents(): Promise<void> {
    for (const n of this.nodes) {
      let seen = this.eventsSeen.get(n.index);
      if (!seen) {
        seen = new Set<string>();
        this.eventsSeen.set(n.index, seen);
      }
      const events: NetworkEventRecord[] = await n.store.listEvents(2000);
      for (const ev of events) {
        const sig = `${ev.ts}|${ev.kind}|${ev.detail}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        if (ev.kind === 'relay-forward' && ev.detail.startsWith('store ')) {
          const prefix = ev.detail.split(' ')[1];
          this.hopCounts.set(prefix, (this.hopCounts.get(prefix) ?? 0) + 1);
        }
      }
    }
  }

  private sampleStep(): void {
    let q = 0;
    for (const n of this.nodes) q += n.node.snapshot().queueSize;
    this.queueSamples.push(q / Math.max(1, this.nodes.length));
    this.neighborSamples.push(this.linkIds.size * 2 / Math.max(1, this.nodes.length));
  }
}
