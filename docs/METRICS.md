# MeshLink Metrics

Last updated: 2026-11-13. All measured routing numbers in this file are
**Simulated** (see `docs/STATUS.md` for the label definitions). They come
from the seeded runs in `docs/sim-results.json`, produced by the real
`MeshNode`/relay/crypto code driving a virtual radio. They are **not**
device measurements and must never be quoted as such. Battery and
throughput rows are targets only; nothing in this environment can measure
them.

## Proposed targets (awaiting human approval)

The master prompt asks for numeric targets before Phase 1. These are
proposals, not approved commitments, and no device row below has been
measured.

| Metric | Proposed target | Current evidence |
| --- | --- | --- |
| Discovery, same access point, both unlocked | p90 ≤ 30 s after scan or announce | Simulated hello cadence only; device Unverified |
| One-hop LAN latency | p50 ≤ 3 s, p90 ≤ 10 s | Device Unverified |
| Two-to-five-hop delivery latency | p90 ≤ 60 s while people keep moving | Device Unverified |
| Delivery ratio at 1–5 hops, 10–50 nodes | ≥ 95% within 10 simulated minutes | Simulated: 100% of resolved messages (small samples) |
| Flood (60 messages, 20 nodes, 6 min) | ≥ 95% delivered, queues bounded | Simulated: 59/60 = 98.3%, max queue 102 |
| Restart resilience | 100% of queued messages survive process restart | Simulated: 11/12 = 91.7% in the restart scenario |
| Idle battery | ≤ 2% per hour | Not measured |
| Chatting battery | ≤ 5% per hour | Not measured |
| Relaying battery | ≤ 8% per hour | Not measured |
| LAN throughput (future file transfer) | ≥ 500 KB/s on 2.4 GHz Wi-Fi | No transfer path exists |
| BLE throughput | Not applicable | BLE Unsupported |
| Text storage growth | ≤ 2 KB per message on disk | SQLite not measured |

## Simulated routing results (seed 42 unless noted)

`deliveryRatio` is `delivered / (delivered + givenUp)` as emitted by the
simulator. `sentCount` is small in the density runs because the scenario
only sends when pair encounters occur; treat ratios as directional, not
statistically strong. Durations differ per scenario and are shown.

| Scenario | Nodes | Duration | Sent | Delivered | Given up | Ratio | Median | p90 | Mean hops | Wire bytes | Bytes/delivered | Max queue |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| density-10 | 10 | 600 s | 20 | 20 | 0 | 100% | 5 s | 25 s | 4.65 | 5.11 MB | 255 KB | 31.9 |
| density-50 | 50 | 600 s | 11 | 11 | 9 | 100% | 3 s | 9 s | 9.64 | 16.0 MB | 1.45 MB | 14.4 |
| density-100 | 100 | 300 s | 2 | 2 | 7 | 100% | 1 s | 1 s | 4.50 | 8.30 MB | 4.15 MB | 2.37 |
| density-300 | 300 | 300 s | 4 | 4 | 5 | 100% | 1 s | 85 s | 11.75 | 25.0 MB | 6.24 MB | 1.39 |
| relay-line-5 (seed 7) | 5 | 300 s | 3 | 3 | 0 | 100% | 15 s | 15 s | 2.67 | 149 KB | 49.6 KB | 4.2 |
| flood-20 (seed 11) | 20 | 360 s | 60 | 59 | 0 | 98.3% | 4 s | 10 s | 8.49 | 53.5 MB | 906 KB | 102.15 |
| restart-12 (seed 23) | 12 | 420 s | 12 | 11 | 0 | 91.7% | 0 s | 8 s | 2.82 | 3.72 MB | 338 KB | 19.4 |
| churn relay-on (seed 20260213) | 16 | 300 s | 16 | 16 | 0 | 100% | 2 s | 8 s | 4.88 | 6.28 MB | 392 KB | 27.7 |
| churn relay-off (same seed) | 16 | 300 s | 16 | 10 | 0 | 62.5% | 1 s | 1 s | 0 | 1.13 MB | 113 KB | 1.06 |

Reading these honestly:

- The churn A/B pair is the clearest routing signal: with relaying off,
  only direct encounters deliver (62.5%); with relaying on, all 16
  delivered and hops rose to 4.88 mean. Same seed, same mobility.
- Dense runs send very few messages, so their 100% ratios are weak
  evidence. The density-300 p90 of 85 s shows tail latency grows with
  crowd size.
- Flood cost is high: ~906 KB of wire traffic per delivered text under
  burst load and a peak queue above 100 envelopes. This is the measured
  price of epidemic forwarding; the core's quotas bound it but do not
  make it cheap.
- `hopsMean = 0` in relay-off means no multi-hop path was taken, as
  expected.
- Bytes/delivered includes link handshakes, HELLO traffic, inventory and
  ACK overhead, not just the message body.

## Model limitations

- The virtual radio models encounters and link up/down events from a
  seeded mobility process. It does not model RF interference, BLE
  advertisement collisions, MTU timing, OS scheduling, or radio wake
  costs. Real airtime cost will be worse.
- Crypto runs for real in simulation, which makes wall-clock times long
  (the full suite takes ~134 s) but does not change event-time latencies.
- No battery or throughput result exists. Do not infer them from wire
  bytes.
- No device has run this build. When hardware results exist, add a
  separate **Device-verified** table with phone models, OS versions,
  build IDs, sample counts and dates. Do not merge them into this one.
