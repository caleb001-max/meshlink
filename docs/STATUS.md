# MeshLink Status

Last updated: 2026-11-13. This file is the single source of truth for
what has actually been demonstrated. Evidence labels are used strictly:

| Label | Meaning |
| --- | --- |
| **Unit-tested** | An automated test in `tests/` ran and passed in this repository. |
| **Simulated** | The real node code ran against the virtual radio in `src/lib/core/sim/`; numbers are model output, not device truth. |
| **Device-verified** | A human ran the build on real phones and recorded the result in `docs/testing/`. **Nothing in this build is Device-verified.** |
| **Unverified** | Code exists and typechecks, but no test or device run proves the behavior end to end. |
| **Unsupported** | Not implemented in this build. The UI must not imply otherwise. |

## Evidence snapshot (2026-11-13)

- `npx tsc --noEmit` — clean, no diagnostics.
- `npx expo lint` — 0 errors; 8 pre-existing warnings inside
  `src/lib/core/` (unused imports, `Array<T>` style).
- `npx expo-doctor` — 19/20 checks pass. The remaining failure is a
  metadata warning that `react-native-tcp-socket` is untested on React
  Native's New Architecture. It is the only LAN transport in this build;
  treat it as a device-build risk until
  `docs/testing/DEVICE_TEST_CHECKLIST.md` confirms a real build runs.
- `npx vitest run` — 5 files, 74 tests passed, 127.18 s.
  - `tests/protocol.test.ts` 15
  - `tests/crypto.test.ts` 25
  - `tests/relay.test.ts` 21
  - `tests/node.test.ts` 7
  - `tests/sim.test.ts` 6
- Simulation: `docs/sim-results.json` (seeded, all rows `"simulated": true`).
- Environment limits: no Mac/Xcode, no Android SDK, no physical phones,
  no BLE hardware or sniffer. Device items below cannot be closed in this
  environment; they are listed in `docs/testing/DEVICE_TEST_CHECKLIST.md`.

## Capability matrix

### Protocol and cryptography

| Capability | Status | Evidence / limit |
| --- | --- | --- |
| v2 binary envelope codec (header, tags, size buckets, expiry, priorities) | Unit-tested | `tests/protocol.test.ts`; spec in `docs/protocol/SPEC.md` |
| Fragmentation, bounded reassembly, MTU framing | Unit-tested | `tests/protocol.test.ts` |
| Inventory, ACK and REQUEST batch codecs | Unit-tested | `tests/protocol.test.ts`; exercised by node/relay tests |
| Link handshake and sealed link frames | Unit-tested | `tests/node.test.ts` drives real links; no independent wire capture |
| Ed25519/X25519 identity, safety numbers | Unit-tested | `tests/crypto.test.ts` |
| X3DH + ML-KEM-768 hybrid + Double Ratchet | Unit-tested | `tests/crypto.test.ts`; composition is unaudited |
| Replay/duplicate suppression, expiry, spray accounting, quotas, rate limiting | Unit-tested | `tests/relay.test.ts` |
| Relay decision matrix and suppression | Unit-tested | `tests/relay.test.ts` |
| Paired sessions, stranger tag hand-off, 3-hop relay, restart recovery | Unit-tested | `tests/node.test.ts` (7 scenarios) |
| Routing at 10/50/100/300 nodes, flood, churn, restart | Simulated | `tests/sim.test.ts`; numbers in `docs/METRICS.md` |

### App integration

| Capability | Status | Evidence / limit |
| --- | --- | --- |
| Engine singleton over the real `MeshNode` | Unverified | Typechecks; not exercised on a device |
| SQLite `Store` (`expo-sqlite`) | Unverified | Typechecks; no SQLite test under Node/device |
| SecureStore identity + SQLite fallback | Unverified | Framework behavior not exercised on hardware |
| LAN TCP transport, 4-byte framing, subnet scan | Unverified | Same-Wi-Fi phones required; permission and firewall behavior untested |
| QR generation and camera scanning | Unverified | Large payload (~2.8 KB) needs a clean screen; no device run |
| Onboarding, calculator lock, panic wipe | Unverified | Compiles; wipe path deletes DB + keys but was not device-tested |
| Chat UI with real status labels (`queued`, `handed`, `delivered`) | Unverified | Labels come from the core; no device run |
| Message requests, accept, block | Unverified | Core flows unit-tested; UI not run |
| Safety-number display and verification toggle | Unverified | No device run |
| Relay consent toggle | Unverified | Persisted in SQLite; no device run |
| SOS compose and queue | Unverified | Core SOS unit-tested; UI not run |
| Photo attachment (inline base64) | Unverified | 48 KB cap; larger photos are rejected, not uploaded |
| Voice note (expo-audio, 30 s cap) | Unverified | AAC/M4A, not Opus; no device run |
| Network/links/event log screens | Unverified | No device run |
| Storage stats and event-log clearing | Unverified | No device run |
| Jet-black/soft-white/flame-orange theme | Unverified | Code-level tokens only; no screenshot or device review |

### Not implemented (must not be presented as working)

| Capability | Status | Note |
| --- | --- | --- |
| Bluetooth LE transport | Unsupported | Peripheral path absent; old scaffold deleted. Wi-Fi/LAN only. |
| Live voice/video calls | Unsupported | Call screen and signaling were removed rather than faked. |
| Push-to-talk | Unsupported | No audio codec path over the mesh. |
| Group chats / membership | Unsupported | Deferred in ADR-003. |
| File/video/document transfer, resumable chunks | Unsupported | Inline small media only. |
| Opus compression | Unsupported | Device recorder default format only. |
| Database encryption at rest | Unsupported | SQLite is plaintext on disk; OS disk encryption is the only control. |
| Disappearing messages | Unsupported | No per-conversation TTL. |
| Read receipts | Unsupported | `read` status exists in the store but no receipt flow sets it. |
| Reactions, edits, deletes, replies, search | Unsupported | Only plain text and small media. |
| Typing indicators | Unsupported | Requires live links; mesh is store-and-forward. |
| Notifications and background delivery | Unsupported | No push service; OS background limits not addressed. |
| Multi-device identity sync / recovery | Unsupported | One identity per install. |
| Internet gateway, LoRa bridge | Unsupported | No internet path by design. |
| Fixed relay node tool | Unsupported | Deferred in ADR-010; `tools/` contains only the simulator. |
| Independent security audit | Unsupported | Crypto composition is unaudited. |
| Golden-vector cross-platform conformance suite | Unsupported | Single TypeScript implementation only. |

## What a user can honestly expect from this build

1. The calculator opens the hidden app with the user's code.
2. Two unlocked phones on the same Wi-Fi/hotspot can link by scan or
   manual IP; links are sealed by the tested handshake.
3. QR pairing stores a verified prekey bundle; messages are sealed with
   X3DH + PQ hybrid and a Double Ratchet.
4. Messages show **Queued** until the node has handed them to a link,
   **Handed to relay** after forwarding, and **Delivered** only after an
   ACK. Nothing pretends to be delivered early.
5. Store-carry-forward and multi-hop relay behavior are proven in
   simulation and unit tests, not on phones.
6. Bluetooth, calls, groups, large files, notifications, and database
   encryption do not exist in this build.

## Pending human verification

Run `docs/testing/DEVICE_TEST_CHECKLIST.md` on at least two Android
phones and two iPhones, then replace the Unverified rows above with
dated, recorded evidence. Until that happens, no row may be promoted to
Device-verified.
