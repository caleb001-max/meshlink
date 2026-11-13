/** One-off diagnostic: per-message outcomes for density-10. */
import { SimEngine } from '../../src/lib/core/sim/sim';
import { scenarioByName } from '../../src/lib/core/sim/scenarios';

async function main(): Promise<void> {
  const def = scenarioByName('density-10')!;
  const r = await new SimEngine(def.build()).run();
  console.log(`sent=${r.sentCount} givenUp=${r.givenUpCount} delivered=${r.deliveredCount}`);
  console.log(`links up/down=${r.linkUps}/${r.linkDowns} avgNbrs=${r.avgNeighbors.toFixed(1)} maxQ=${r.maxQueueSize}`);
  for (const o of r.outcomes) {
    console.log(
      `m${o.id.slice(0, 6)} ${o.from}->${o.to} sent=${o.sentAtSec} delivered=${o.deliveredAtSec} hops=${o.hopsObserved}`,
    );
  }
  // Where do undelivered messages sit? Check sender-side status.
  const engines = new SimEngine(def.build());
  void engines;
}

void main();
