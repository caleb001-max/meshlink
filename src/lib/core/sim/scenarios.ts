/**
 * Canonical simulation scenarios for MeshLink.
 *
 * Every scenario drives the real MeshNode stack over a virtual radio.
 * Numbers from these runs are SIMULATED evidence (docs/METRICS.md), not
 * device measurements. All scenarios are deterministic for a fixed seed:
 * mobility, placement and send schedules come from the seeded PRNG. Node
 * identities and message ids come from real crypto randomness, so
 * delivery-ratio noise between two runs of the SAME seed is possible but
 * schedules and topology are identical (this is what makes the relay
 * on/off A/B pair meaningful).
 */
import { type SimConfig } from './sim';

/** Area side (m) for a target mean neighbor count under uniform density. */
function sideForDegree(nodeCount: number, radioRangeM: number, targetDegree: number): number {
  return Math.ceil(Math.sqrt((nodeCount * Math.PI * radioRangeM * radioRangeM) / targetDegree));
}

export interface ScenarioDef {
  name: string;
  description: string;
  build: () => SimConfig;
}

/** Walking-speed mobile crowd at mean degree ~5. */
function density(nodeCount: number): ScenarioDef {
  const area = sideForDegree(nodeCount, 30, 5);
  return {
    name: `density-${nodeCount}`,
    description: `${nodeCount} nodes walking at 1.4 m/s in a ${area}x${area} m area, radio range 30 m, 20 stranger messages over 10 min.`,
    build: () => ({
      name: `density-${nodeCount}`,
      seed: 42,
      nodeCount,
      areaM: area,
      radioRangeM: 30,
      durationSec: 600,
      speedMps: 1.4,
      gossipEverySec: 5,
      tickEverySec: 15,
      messageCount: 20,
      firstSendSec: 30,
      sendSpacingSec: 20,
      relayEnabled: true,
    }),
  };
}

/** Five static nodes in a line; only neighbors are in radio range. */
const relayLine: ScenarioDef = {
  name: 'relay-line-5',
  description: '5 static nodes 30 m apart in a line (range 35 m); endpoints exchange after a 20 s gathering so HELLO tags spread.',
  build: () => ({
    name: 'relay-line-5',
    seed: 7,
    nodeCount: 5,
    areaM: 200,
    radioRangeM: 35,
    durationSec: 300,
    speedMps: 0,
    gossipEverySec: 5,
    tickEverySec: 15,
    messageCount: 0,
    firstSendSec: 0,
    sendSpacingSec: 0,
    relayEnabled: true,
    positions: [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 60, y: 0 },
      { x: 90, y: 0 },
      { x: 120, y: 0 },
    ],
    initialCloudSec: 20,
    sends: [
      { from: 0, to: 4, atSec: 40 },
      { from: 4, to: 0, atSec: 60 },
      { from: 1, to: 3, atSec: 80 },
    ],
  }),
};

/** Burst of 60 messages in 30 s: exercises queue quotas under load. */
const flood: ScenarioDef = {
  name: 'flood-20',
  description: '20 nodes gathered for 15 s then dispersing slowly; 60 messages fired in a 30 s burst; measures queue growth and delivery under load.',
  build: () => ({
    name: 'flood-20',
    seed: 11,
    nodeCount: 20,
    areaM: sideForDegree(20, 30, 5),
    radioRangeM: 30,
    durationSec: 360,
    speedMps: 0.5,
    gossipEverySec: 5,
    tickEverySec: 15,
    messageCount: 60,
    firstSendSec: 20,
    sendSpacingSec: 0.5,
    relayEnabled: true,
    initialCloudSec: 15,
  }),
};

/** Mid-run restart of a mobile node with in-flight traffic. */
const restart: ScenarioDef = {
  name: 'restart-12',
  description: '12 mobile nodes, 12 messages over 4 min; node 3 reboots at t=150 s (persisted state kept, discovery state lost).',
  build: () => ({
    name: 'restart-12',
    seed: 23,
    nodeCount: 12,
    areaM: sideForDegree(12, 30, 5),
    radioRangeM: 30,
    durationSec: 420,
    speedMps: 1.0,
    gossipEverySec: 5,
    tickEverySec: 15,
    messageCount: 12,
    firstSendSec: 20,
    sendSpacingSec: 20,
    relayEnabled: true,
    restarts: [{ atSec: 150, nodeIndex: 3 }],
  }),
};

const CHURN_SEED = 20_260_213;

const churnOn: ScenarioDef = {
  name: 'churn-relay-on',
  description: 'A/B arm A: 16 mobile nodes, 16 messages over 5 min, relay enabled.',
  build: () => ({
    name: 'churn-relay-on',
    seed: CHURN_SEED,
    nodeCount: 16,
    areaM: sideForDegree(16, 30, 5),
    radioRangeM: 30,
    durationSec: 300,
    speedMps: 1.4,
    gossipEverySec: 5,
    tickEverySec: 15,
    messageCount: 16,
    firstSendSec: 30,
    sendSpacingSec: 8,
    relayEnabled: true,
  }),
};

const churnOff: ScenarioDef = {
  name: 'churn-relay-off',
  description: 'A/B arm B: identical seed/mobility/schedule as churn-relay-on but relay disabled.',
  build: () => ({
    ...churnOn.build(),
    name: 'churn-relay-off',
    relayEnabled: false,
  }),
};

/** All scenarios in canonical run order. */
export function allScenarios(): ScenarioDef[] {
  return [density(10), density(50), density(100), density(300), relayLine, flood, restart, churnOn, churnOff];
}

export function scenarioByName(name: string): ScenarioDef | null {
  return allScenarios().find((s) => s.name === name) ?? null;
}
