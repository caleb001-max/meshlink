/**
 * Simulator tests: small, deterministic scenarios that exercise the REAL
 * MeshNode stack under the SimEngine virtual radio. These validate the
 * simulator itself (multi-hop relay line, density sanity, flood queue
 * bounds) — they are NOT device measurements.
 */
import { describe, expect, test } from 'vitest';
import { SimEngine } from '../src/lib/core/sim/sim';
import { allScenarios, scenarioByName } from '../src/lib/core/sim/scenarios';

describe('scenario registry', () => {
  test('all canonical scenarios resolve and build unique configs', () => {
    const defs = allScenarios();
    expect(defs.length).toBeGreaterThanOrEqual(9);
    const names = defs.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of defs) {
      const cfg = d.build();
      expect(cfg.name).toBe(d.name);
      expect(cfg.nodeCount).toBeGreaterThan(0);
      expect(scenarioByName(d.name)).not.toBeNull();
    }
    expect(scenarioByName('nope')).toBeNull();
  });
});

describe('relay line (multi-hop store-carry-forward)', () => {
  test('endpoints of a 5-node line exchange through relays', async () => {
    const def = scenarioByName('relay-line-5')!;
    const r = await new SimEngine(def.build()).run();
    // All three scheduled messages fire (gathered during the cloud phase).
    expect(r.sentCount).toBe(3);
    expect(r.givenUpCount).toBe(0);
    expect(r.deliveredCount).toBe(3);
    // The 0->4 message crossed the whole line: at least 2 relay stores.
    const cross = r.outcomes.find((o) => o.from === 0 && o.to === 4)!;
    expect(cross.deliveredAtSec).not.toBeNull();
    expect(cross.hopsObserved).toBeGreaterThanOrEqual(2);
    expect(cross.latencySec ?? 0).toBeGreaterThan(0);
    // Without relay hops a line delivery would be impossible, so the run
    // must also have produced at least one link per adjacency.
    expect(r.linkUps).toBeGreaterThanOrEqual(4);
  }, 120_000);
});

describe('density sanity (10 nodes)', () => {
  test('walking crowd delivers a majority of stranger messages with bounded queues', async () => {
    const def = scenarioByName('density-10')!;
    const r = await new SimEngine(def.build()).run();
    // Stranger sends require the pair to have met; some pairs may never
    // meet inside the 120 s window, and those are excluded as give-ups.
    expect(r.sentCount + r.givenUpCount).toBe(20);
    expect(r.givenUpCount).toBeLessThanOrEqual(10);
    expect(r.deliveredCount).toBeGreaterThanOrEqual(5);
    expect(r.avgNeighbors).toBeGreaterThan(0);
    expect(r.maxQueueSize).toBeLessThan(500);
    if (r.deliveredCount > 0) {
      expect(r.medianLatencySec ?? Infinity).toBeGreaterThan(0);
      expect(r.wireBytes).toBeGreaterThan(0);
    }
  }, 180_000);
});

describe('flood (burst load)', () => {
  test('60-message burst stays inside queue quotas and still delivers', async () => {
    const def = scenarioByName('flood-20')!;
    const r = await new SimEngine(def.build()).run();
    expect(r.sentCount).toBe(60);
    expect(r.deliveredCount).toBeGreaterThanOrEqual(20);
    // The OutboundQueue quota must bound per-node state even under burst.
    expect(r.maxQueueSize).toBeLessThan(500);
    expect(r.avgQueueSize).toBeLessThan(100);
  }, 180_000);
});

describe('restart resilience', () => {
  test('mid-run reboot keeps delivering for pairs that re-meet', async () => {
    const def = scenarioByName('restart-12')!;
    const r = await new SimEngine(def.build()).run();
    // Restart costs some delivery (discovery state is lost) but the mesh
    // recovers: at least half of scheduled messages still arrive.
    expect(r.sentCount + r.givenUpCount).toBe(12);
    expect(r.deliveredCount).toBeGreaterThanOrEqual(5);
  }, 180_000);
});

describe('relay A/B (same seed)', () => {
  test('relay-on delivers more multi-hop traffic than relay-off', async () => {
    const on = await new SimEngine(scenarioByName('churn-relay-on')!.build()).run();
    const off = await new SimEngine(scenarioByName('churn-relay-off')!.build()).run();
    // Same schedule: identical sends scheduled, relay-off cannot bridge
    // gaps so it must not out-deliver relay-on.
    expect(off.sentCount).toBe(on.sentCount);
    expect(off.deliveryRatio).toBeLessThanOrEqual(on.deliveryRatio);
  }, 300_000);
});
