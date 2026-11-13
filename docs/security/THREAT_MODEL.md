# MeshLink Threat Model

Version 1.0, 2026-11-13. This document was written before shipping the
security-relevant features and is kept next to the code it constrains.
It follows the spec's required adversary list. Every mitigation names the
code that implements it and its test status. Where a mitigation is not
implemented, the residual risk says so plainly — this app is UNAUDITED
until an independent audit completes (see "Audit status").

## Scope and assumptions

- Two or more phones (Android and/or iOS) running MeshLink, no internet,
  no cellular, no servers. The only transport wired in this build is LAN
  TCP; BLE is a design target and is NOT active (STATUS: Unsupported).
  Optional fixed relay nodes (same protocol over TCP) are not shipped.
  Adversary sections that describe BLE frames state design intent, not
  a working capability.
- User devices are assumed uncompromised at pairing time. The OS
  (Keystore/Keychain) is assumed to honor its storage guarantees.
- The QR pairing channel is assumed out-of-band and visually verifiable
  (the safety number defends against a MITM within camera range).
- We do NOT defend against a global passive adversary correlating RF
  presence across space and time beyond what rotating tags provide, nor
  against a device attacker who extracts keys from the secure enclave.

## Adversaries

### A1. Passive eavesdropper (nearby radio observer, e.g. BLE sniffer)

Sees: raw advertisement frames and link-layer traffic; cannot modify.

Mitigations:
- BLE advertisements carry a random service UUID only — no name, no
  payload, no identity (app.json transport config; manual verify item in
  the device checklist with an nRF sniffer). Unverified on hardware.
- Link confidentiality/integrity: every frame XChaCha20-Poly1305 sealed
  under per-direction keys from the Noise-style handshake
  (`linksec.ts`, unit-tested; device-verified pending).
- Envelope metadata: rotating 8-byte tags per epoch; fixed size buckets;
  no names/IDs anywhere in an envelope (`protocol.ts`, unit-tested).
- E2E payload: Double Ratchet under a hybrid X25519+ML-KEM-768 X3DH
  (`crypto.ts`, unit-tested against noble test vectors).

Residual risks: traffic analysis (who talks to whom, when, how often) is
only weakly mitigated — tags rotate per epoch but the conversation tag
window (first contact until first ACK, minutes) is linkable; packet
timing/volume is unobscured beyond bucket padding. The sniffer can also
map presence (MAC rotation helps, RF fingerprinting may not).

### A2. Active BLE man-in-the-middle (relay in the middle of first contact)

Can: inject, replay, alter, block; can present its own keys.

Mitigations:
- Link handshake signs the transcript with Ed25519 identity keys
  (`linksec.ts`); an attacker without the private key cannot forge it.
- BUT: for strangers there is nothing to authenticate against before the
  first message — TOFU on the link layer, so an active MITM CAN swap
  keys at first contact. The defense is the QR pairing + SAFETY NUMBER
  for contacts (`pairFromQr`, `safetyNumber`): both users verify the
  digits match, binding identity keys out-of-band. Unit-tested for the
  derivation; device-verified pending.
- For stranger conversations: the session init is bound to the HELLO
  bundle the RESPONDER advertised on its own link; an attacker cannot
  decrypt or alter it without the responder's ephemeral secrets, but CAN
  suppress or delay it (blocking, not forging).
- Replay: link counters must increment exactly by 1 (frames replayed are
  rejected); session ratchet rejects reused message counters; dedup set
  drops envelope-level replays. Unit-tested.

Residual risks: a MITM who completes QR-scanning in place of one party
(evil twin camera target) is out of scope of the safety number check —
users must scan the QR shown on the peer's own screen. Key-change
warning exists for re-paired contacts; the UI must surface it (device
checklist item).

### A3. Malicious relay (runs MeshLink, opted in, hostile)

Sees: every envelope transiting it; can drop, delay, duplicate, replay,
flood. Cannot: read E2E payloads (Double Ratchet, AD-bound to
type/priority/msgId); read link frames of others (per-link keys);
correlate tags to identities without side channels.

Mitigations:
- Content-blind forwarding path; relay sees priority, remaining age,
  size bucket, opaque tags only (ADR-004; `relay.ts`, unit-tested).
- Duplicate/delay detection surfaced to the user as honest delivery
  states: "queued" (no route yet), "handed to relay" (left us), never
  "delivered" without an ACK (`node.ts`; simulated).
- Flood abuse: per-peer rate limits, per-sender/global relay quotas,
  bounded dedup memory, per-peer queue fairness, priority-aware eviction
  that never evicts SOS in favor of lower classes (`relay.ts`
  OutboundQueue; unit-tested).
- Junk: cheap envelope authentication (structure + flags + AEAD tag on
  control traffic); malformed envelopes are dropped, never relayed
  (`decodeEnvelope` ProtocolError; fuzz-property tests).
- "Accepts but never forwards" relays: detected statistically — the
  diagnostics screen shows per-relay forwarding counts observed via
  inventories (topology data, never content). Device checklist verifies
  UX.

Residual risks: a malicious relay can ALWAYS refuse to forward (loss, an
availability attack) and can measure timing/volume per neighbor. It can
attempt tag correlation across epochs it observes; epoch rotation and
CT-retirement bound this but do not eliminate it. Sybil relays can shape
the epidemic spread (partition the mesh around a victim).

### A4. Spammer / Sybil attacker (many fake nodes, many junk messages)

Mitigations:
- Envelope-level cheap authentication and structure checks make junk
  generation cheap to DROP.
- Per-peer rate limiter (token bucket) and global relay quotas bound
  injection (`RateLimiter`, unit-tested).
- Message-requests inbox: unknown senders land in a filtered inbox, not
  the main chat list (app layer; planned screen, see STATUS).
- Eviction: bulk/media messages evict before text; SOS never evicts.
- Sybil density attacks (fill the neighborhood with fake relays to
  outvote suppression) are possible by design in epidemic routing;
  counter-based suppression with distinct-peer counting and copy
  budgets bound amplification but a radio-saturated adversary always
  wins the physical layer (jamming is out of scope).

Residual risks: pseudonymous tags make sender-accountable rate limiting
hard for STRANGER traffic; the limiter keys on tag, which the attacker
rotates. Real defense is per-CONTACT quotas after pairing.

### A5. Traffic analyst (global or local observer across time)

Sees: presence, link formation times, message sizes (bucketed),
priorities, (approximately) origin/destination neighborhoods.

Mitigations: rotating tags + bucket padding + fixed priorities; store-
carry-forward blurs producer/consumer timing (a message may be carried
for minutes before delivery).

Residual risks: bucket padding reveals CLASS (a 16 KB bucket is a media
message); SOS rate/shape is distinctive by design (it must be, to get
priority). Social-graph inference across many epochs is NOT fully
mitigated; documented honestly.

### A6. Device seizure (physical capture of an unlocked or locked phone)

Mitigations:
- Panic wipe deletes the SQLite database, SecureStore identity and
  passcode hash, forcing loss of message plaintext and session keys.
- App lock: calculator disguise (ADR-009) with a destructive confirmation
  before wiping.
- The database itself is NOT encrypted at rest in this build; OS disk
  encryption plus device lock are the only at-rest controls. This is a
  known gap, not a claimed mitigation.
- Disappearing messages and encrypted identity export are NOT
  implemented; they remain future work and are labeled Unsupported in
  STATUS.

Residual risks: seizure while unlocked defeats everything; seizure while
locked still exposes an unencrypted database if the OS disk is not
encrypted. Neither property is verifiable without devices — checklist
item.

## Audit status

UNAUDITED. The cryptography is assembled from audited pinned libraries
(noble v1.x) but the composition (X3DH variant, ratchet AD bindings,
link handshake, relay policy) is our own and must be reviewed by an
independent auditor before any security claim beyond "unit-tested".
Planned: external review of `src/lib/core/crypto.ts` and `linksec.ts`
against the Signal specification, plus a public bug bounty after the
first device-verified release. Fuzz status: property-based tests
(fast-check) cover envelope/fragment/inventory/handshake parsers;
coverage reported in docs/STATUS.md.
