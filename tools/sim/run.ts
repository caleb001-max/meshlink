/**
 * MeshLink scenario runner CLI.
 *
 * Usage:
 *   npx tsx tools/sim/run.ts                 run every scenario, print a table
 *   npx tsx tools/sim/run.ts density-50      run one scenario by name
 *   npx tsx tools/sim/run.ts --json out.json also write machine-readable JSON
 *
 * Runs the real MeshNode stack in the simulator. Output is SIMULATED
 * evidence: paste the table into docs/METRICS.md marked as "Simulated".
 */
import { SimEngine, type SimResult } from '../../src/lib/core/sim/sim';
import { allScenarios, scenarioByName } from '../../src/lib/core/sim/scenarios';
import { writeFileSync } from 'node:fs';

function fmt(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return '-';
  return v.toFixed(digits);
}

function row(r: SimResult): string {
  return [
    r.config.name,
    `${r.deliveredCount}/${r.sentCount}`,
    `${Math.round(r.deliveryRatio * 100)}%`,
    r.givenUpCount,
    fmt(r.medianLatencySec, 0),
    fmt(r.p90LatencySec, 0),
    fmt(r.hopsMean, 2),
    r.wireBytes.toLocaleString('en-US'),
    r.bytesPerDelivered === null ? '-' : r.bytesPerDelivered.toLocaleString('en-US'),
    `${r.linkUps}/${r.linkDowns}`,
    fmt(r.avgQueueSize, 1),
    Math.round(r.maxQueueSize),
    fmt(r.avgNeighbors, 1),
    `${(r.wallMs / 1000).toFixed(1)}s`,
  ].join(' | ');
}

const HEADER = [
  'scenario',
  'delivered',
  'ratio',
  'giveup',
  'medLat(s)',
  'p90Lat(s)',
  'hops',
  'wireBytes',
  'B/deliv',
  'ups/downs',
  'avgQ',
  'maxQ',
  'nbrs',
  'wall',
].join(' | ');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf('--json');
  let jsonPath: string | null = null;
  if (jsonIdx >= 0) {
    jsonPath = args[jsonIdx + 1] ?? null;
    args.splice(jsonIdx, 2);
  }
  const wanted = args.filter((a) => !a.startsWith('-'));
  const defs = wanted.length
    ? wanted.map((n) => {
        const d = scenarioByName(n);
        if (!d) throw new Error(`unknown scenario: ${n} (available: ${allScenarios().map((s) => s.name).join(', ')})`);
        return d;
      })
    : allScenarios();

  const results: SimResult[] = [];
  for (const def of defs) {
    const cfg = def.build();
    process.stdout.write(`running ${cfg.name} ... `);
    const t0 = Date.now();
    const res = await new SimEngine(cfg).run();
    results.push(res);
    process.stdout.write(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  }

  console.log('');
  console.log(HEADER);
  for (const r of results) console.log(row(r));
  console.log('');
  for (const def of defs) console.log(`- ${def.name}: ${def.description}`);

  if (jsonPath) {
    const payload = results.map((r) => ({
      scenario: r.config.name,
      simulated: true,
      seed: r.config.seed,
      nodeCount: r.config.nodeCount,
      durationSec: r.config.durationSec,
      relayEnabled: r.config.relayEnabled,
      sentCount: r.sentCount,
      givenUpCount: r.givenUpCount,
      deliveredCount: r.deliveredCount,
      deliveryRatio: Number(r.deliveryRatio.toFixed(4)),
      medianLatencySec: r.medianLatencySec,
      p90LatencySec: r.p90LatencySec,
      hopsMean: r.hopsMean === null ? null : Number(r.hopsMean.toFixed(3)),
      wireBytes: r.wireBytes,
      bytesPerDelivered: r.bytesPerDelivered,
      linkUps: r.linkUps,
      linkDowns: r.linkDowns,
      avgQueueSize: Number(r.avgQueueSize.toFixed(3)),
      maxQueueSize: r.maxQueueSize,
      avgNeighbors: Number(r.avgNeighbors.toFixed(3)),
      wallMs: r.wallMs,
    }));
    writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + '\n');
    console.log(`\nwrote ${jsonPath}`);
  }
}

void main();
