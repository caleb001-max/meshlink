# Architecture Decision Records

MeshLink (as built on the "chimera" Expo/React Native codebase).
Each record: context, decision, consequences. Statuses follow classic ADR
semantics. The spec's Phase 0 required ADRs for the shared-core choice,
routing approach, session and group crypto, relay-trust mechanism,
transport policy and licensing; later phases added records as decisions
surfaced.

## ADR-001: Shared protocol core in TypeScript inside the existing Expo app

- Date: 2026-11-13. Status: accepted.
- Context: The spec recommends Kotlin Multiplatform or a shared Rust core
  for the protocol/routing/storage core. The existing project is an Expo
  (React Native) app with an existing identity/lock UX. No Mac, no Android
  SDK and no physical devices are available in this environment.
- Decision: Keep ONE codebase. Implement the entire protocol core
  (codec, crypto, relay, node, simulator) as a platform-independent
  TypeScript layer under `src/lib/core/` that is also runnable under Node
  for the simulator, relay tools and CI. The Expo app consumes it through
  a thin bridge (`src/lib/engine/`: engine singleton, SQLite Store, LAN
  transport). No KMP/Rust multi-platform target is created.
- Consequences: (+) One implementation that is unit-tested and simulated
  end-to-end; CI can run everything without devices; the same code ships
  in the app. (-) Not literally "two native apps" — iOS/Android are built
  from the same RN core, which the spec's ground rules treat as a
  legitimate engineering choice to record, not a silent deviation.
  (-) Native-only platform capabilities (Keystore/Keychain-backed key
  storage) are accessed through Expo modules, not direct platform APIs.
  (-) A future native port must reimplement the core; the protocol spec
  and golden vectors are the portability contract.

## ADR-002: Routing = epidemic spray-and-wait gossip with inventory reconciliation

- Date: 2026-11-13. Status: accepted.
- Context: Phone meshes are sparse, mobile and partitioned; interactive
  routing protocols (AODV-style path discovery) fail when the path is
  only complete minutes later. The spec recommends "gossip-style
  inventory exchange with compact set reconciliation, plus spray-and-wait
  style limited-copy forwarding, validated in the simulator".
- Decision: Epidemic store-carry-forward. Envelopes carry rotating
  src/dst TAGS, not routes. Relays blindly store-and-spray (bounded by
  copies, TTL, quotas and counter-based suppression with distinct-peer
  counting); inventories reconcile what neighbors hold; the recipient
  pulls by REQUEST. Delivery requires no topology knowledge.
- Consequences: (+) Robust to churn; no routing state; simple loop
  prevention via dedup + TTL. (-) Redundant transmissions in dense meshes
  (measured in METRICS as bytes-per-delivered); latency scales with
  encounter rate rather than hops. An alternative (geographic or
  context-aware forwarding) remains a future ADR if metrics show
  unacceptable airtime waste at high density.

## ADR-003: Session crypto = X3DH + hybrid ML-KEM-768 + Double Ratchet; group crypto deferred

- Date: 2026-11-13. Status: accepted (group part: deferred with rationale).
- Context: Store-and-forward means no interactive handshake; relays can
  capture all traffic; a quantum adversary could later decrypt recorded
  classical-only ciphertext. The spec requires prekeys + Double Ratchet
  with a hybrid PQ exchange. libsignal is AGPL-3.0.
- Decision: Sessions use the Signal X3DH structure implemented on pinned
  audited noble libraries (`@noble/curves@1.9.7`, `@noble/hashes@1.8.0`,
  `@noble/ciphers@1.3.0`, `@noble/post-quantum@0.5.0`): X25519 triple-DH
  combined with an ML-KEM-768 encapsulation (both always present), then a
  Double Ratchet with XChaCha20-Poly1305. One-time prekeys and signed
  prekeys come from QR pairing or the stranger HELLO bundle.
  GROUP messaging (Sender Keys / MLS) is deferred: sender keys assume an
  online distribution channel and MLS ordering assumptions do not hold in
  a partitioned mesh (each member must see the full proposal/commit
  sequence). Groups will be re-decided in a later ADR with per-pair
  ratchets as the interim (broadcast to each member).
- Consequences: (+) Forward secrecy + post-compromise security + PQ
  hybrid without license contamination. (-) Larger first messages
  (1192-byte init header) — paid once per session. (-) Group chats are
  not yet end-to-end efficient; interim approach is per-member sessions.

## ADR-004: Relay trust = explicit opt-in + policy gates; trusted-only relaying deferred

- Date: 2026-11-13. Status: accepted (trusted-only part: deferred).
- Context: The spec flags a conflict: "relay only trusted contacts'
  traffic" requires relays to recognize allowed traffic, which risks
  leaking the social graph.
- Decision: v1 relays are content-blind: policy gates are
  opt-in on/off, battery, quotas, rate limits, dedup, TTL, hop limit and
  an optional trust-circle epoch MAC (symmetric group key, verifies
  origin without identifying the sender). The per-contact relay-token
  design for "trusted contacts only" is DEFERRED and documented as an
  open problem: any per-contact token lets the relay group traffic by
  contact, i.e. it necessarily reveals co-membership to the relay.
  Recommended trade-off recorded for the future: tokens scoped per
  SENDER, not per pair, with k-anonymity by token reuse across
  conversations.
- Consequences: (+) No social-graph leakage; relays stay identical
  code-wise to normal nodes. (-) The "trusted-only relay" user setting is
  NOT shipped until the token design exists; the settings UI exposes only
  the gates above.

## ADR-005: Transport policy = LAN TCP now; BLE baseline deferred (superseded for this build by ADR-011)

- Date: 2026-11-13. Status: amended.
- Context: Wi-Fi Direct and MultipeerConnectivity do not interoperate;
  Wi-Fi Aware cross-platform discovery is reported unreliable as of
  November 2026. BLE would be the universal baseline if a peripheral path
  existed, but the prototype only had a central scanner and no device
  verification. react-native-tcp-socket gives a reliable local-LAN
  transport where users share a hotspot.
- Decision: The adapter interface stays transport-agnostic
  (`registerLink`/`ingest` in `MeshNode`). In THIS build, only LAN TCP is
  wired (`src/lib/engine/lan.ts`). BLE (plx central + peripheral,
  MTU-chunked LinkCodec frames) remains a design target; the packages and
  unused permission strings were removed so the app cannot imply BLE
  works. Wi-Fi Aware is a TEST TARGET only.
- Consequences: (+) Honest cross-platform story; no invented
  interoperability claims. (-) The app works only when phones share a
  LAN; there is no radio-range fallback. Reintroducing BLE requires a
  hardware-verified peripheral implementation, not just re-adding a
  dependency.

## ADR-006: Licensing = MIT for this codebase, pinned permissive libs, no AGPL dependency

- Date: 2026-11-13. Status: accepted.
- Context: libsignal (AGPL-3.0) would force license obligations; noble
  libraries are MIT with pinned versions.
- Decision: All first-party code MIT. Dependencies pinned exact:
  @noble/curves 1.9.7, @noble/hashes 1.8.0, @noble/ciphers 1.3.0,
  @noble/post-quantum 0.5.0 (all MIT). The old tweetnacl/disguise-era
  modules were deleted from `src/`; no first-party code imports
  tweetnacl. No AGPL dependency. Reproducible-build goal recorded;
  lockfile committed.
- Consequences: (+) Clean redistribution; audited primitives only.
  (-) We reimplement (and clearly attribute) the X3DH/Ratchet structure
  instead of reusing libsignal.

## ADR-007: Discovery addresses = ephemeral HELLO tags; strangers rendezvous via conversation tags

- Date: 2026-11-13. Status: accepted.
- Context: Sealed-sender routing needs an address a stranger can use
  without prior contact, but stable addresses enable tracking. HELLO
  bundles give one-hop ephemeral addresses only.
- Decision: Strangers start a conversation with a random stable
  conversation tag used as BOTH srcTag and dstTag (so relays can carry
  replies without learning anyone's identity). After the first ACK the
  initiator retires the CT and derives per-epoch pairwise tags from
  X25519(identity, identity); the responder retires it on the first
  pairwise-tagged inbound. HELLO tags rotate on a 10 min cadence with
  1 h retention and a capacity cap (64, configurable for simulators).
- Consequences: (+) Untracked addressing after hand-off; works for
  first contact. (-) The CT window (until first ACK) is a correlation
  point — bounded by ACK latency and documented in the threat model.

## ADR-008: Simulator drives the production node; numbers are Simulated, never Device-verified

- Date: 2026-11-13. Status: accepted.
- Context: The spec requires validation of routing at scale in a
  simulator with honest labeling; emulators never count as device
  verification.
- Decision: `src/lib/core/sim/` runs the REAL MeshNode (same crypto,
  relay, codec code as the app) against a virtual radio with seeded
  mobility. MeshNode takes `noTimers` and `helloTagCapacity` options for
  host-driven time. All published numbers are labeled Simulated in
  docs/METRICS.md; device claims require the checklist in
  docs/testing/DEVICE_TEST_CHECKLIST.md run on real hardware.
- Consequences: (+) No divergence between simulated and shipped logic.
  (-) The radio model omits interference and MTU timing; metrics
  understate real-world airtime cost (stated in METRICS).

## ADR-009: The calculator disguise (pre-existing) stays as the app lock, extended with a panic wipe

- Date: 2026-11-13. Status: accepted.
- Context: The existing chimera app presents as a calculator until
  unlocked (tap sequence). The spec wants app lock and fast panic wipe
  (seizure resistance).
- Decision: Keep and harden the calculator lock as the sole home screen
  gate (no "MeshLink" label while locked), add a hidden panic-wipe
  gesture that requires a long-press confirm and destroys the local
  database keys. Honest labeling: this is security-by-obscure-presentation,
  not strong authentication; device lock (OS) remains the primary control.
- Consequences: (+) Meets seizure-resistance intent without new
  platform APIs. (-) Not a substitute for OS disk encryption; documented
  in the threat model as a low-barrier deterrent only.

## ADR-010: Fixed relay node — deferred in this build (not implemented)

- Date: 2026-11-13. Status: deferred.
- Context: The spec's Phase 9 asks for a reference relay design speaking
  the same protocol. A phone is a poor always-on relay. No Node relay
  was required for the app to function, and none could be hardware-tested
  here.
- Decision: Do NOT claim a relay-node tool. `tools/` contains only the
  simulator. The core is headless and a Node TCP relay *could* be built
  on the same MeshNode/LinkCodec code, but that work is deferred until
  the LAN path is device-verified.
- Consequences: (+) STATUS and this ADR stay truthful; no untested
  binary is shipped. (-) Disaster deployments with fixed relays are not
  possible with this build; phones must carry traffic themselves.

## ADR-011: App integration = engine bridge, LAN-only transport, no fake calls

- Date: 2026-11-13. Status: accepted.
- Context: The UI previously spoke to a JSON/tweetnacl prototype while
  the tested MeshLink v2 node sat unused. The spec forbids presenting
  unimplemented connectivity as working, and the prototype had a call
  screen with signaling but no audio path.
- Decision: All hidden screens talk to one `engine` singleton
  (`src/lib/engine/`) that owns the real `MeshNode`, a SQLite `Store`,
  a SecureStore identity, and a length-prefixed TCP LAN transport on port
  47474. Relay is off by default. The call screen and the prototype
  module tree were deleted. BLE is reported as not active until a
  peripheral implementation is verified on hardware. Media is limited to
  small inline payloads (48 KB base64 cap) so the UI never promises a
  file-transfer engine that does not exist.
- Consequences: (+) One protocol implementation is exercised by unit
  tests, the simulator and the app; UI state labels map to real node
  status (`queued`, `handed`, `delivered`). (-) LAN is the only verified
  transport path and it is still device-unverified; iOS local-network
  permission and Android OEM background killing must be tested by a
  human.
