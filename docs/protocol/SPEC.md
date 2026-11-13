# MeshLink Wire Protocol Specification, version 2

Status: implemented in `src/lib/core/protocol.ts` (envelope codec),
`src/lib/core/crypto.ts` (sessions), `src/lib/core/linksec.ts` (link
channels). Golden vectors at the bottom are executed by
`tests/protocol.test.ts` in CI.

Design goals, in priority order:

1. **Metadata privacy.** Relays and passive sniffers see only an opaque
   rotating 8-byte sender tag, an opaque rotating 8-byte recipient tag, a
   priority class, a size bucket and the remaining age. No display names,
   identity keys or stable identifiers ever appear on the wire.
2. **No clock trust.** Lifetimes are age-based and decremented per hop by
   transit time measured locally. Replay protection uses counters and
   nonces, never wall-clock comparison.
3. **Delay tolerance.** Every datagram is self-contained; relays store and
   re-spray envelopes hours later without any session state.
4. **Compactness.** A 37-byte fixed header; AEAD everywhere; bucket padding
   so size side-channels are coarse.

## 1. Transport framing (link security layer)

Every physical link (BLE GATT characteristic write, L2CAP stream, TCP
socket, virtual sim link) carries frames produced by `LinkCodec`:

```
frame := len(u16le) || ctr(u64le) || ciphertext
```

- `len` counts only the ciphertext (plaintext + 16-byte Poly1305 tag);
  the full frame is `10 + len` bytes.
- `ctr` is a 64-bit little-endian counter that starts at 0 independently
  in each direction and must increase by exactly 1 per frame; a mismatch
  kills the link (replay/stall detection).
- The cipher is XChaCha20-Poly1305 with a per-DIRECTION key from the link
  handshake (see section 6). Nonce = `"LNK"` (3 bytes) || counter (8
  bytes, LE, offset 4); associated data = the 8-byte counter itself.

Envelopes larger than the transport MTU are fragmented (section 4);
each fragment is one codec frame.

## 2. Envelope

All multi-byte integers are little-endian. Header is exactly 37 bytes:

| Off | Len | Field       | Notes                                                     |
|-----|-----|-------------|-----------------------------------------------------------|
| 0   | 2   | magic       | `0x4D 0x4C` = "ML"                                        |
| 2   | 1   | version     | `2`; other versions are dropped, never relayed            |
| 3   | 1   | type        | 1 HELLO, 2 MSG, 3 ACK, 4 INVENTORY, 5 REQUEST             |
| 4   | 1   | priority    | 0 SOS, 1 TEXT, 2 VOICE, 3 MEDIA, 4 BULK                   |
| 5   | 1   | flags       | see 2.1                                                   |
| 6   | 1   | hopLimit    | 8 default, 5 for SOS                                     |
| 7   | 1   | hopCount    | incremented by every relay, saturating at 255             |
| 8   | 2   | expiresInSec| REMAINING lifetime, u16, seconds                          |
| 10  | 1   | sprayCopies | remaining spray-and-wait copies                           |
| 11  | 8   | msgId       | random 64-bit message id (also reassembly key)            |
| 19  | 8   | srcTag      | rotating sender tag (opaque, per-epoch)                   |
| 27  | 8   | dstTag      | rotating recipient tag, or 8 zero bytes for broadcast     |
| 35  | 2   | payloadLen  | u16                                                       |
| 37  | var | payload     | `payloadLen` bytes                                        |

`payloadLen` is capped at 65519 (65535 minus one AEAD tag) and the whole
decoded frame at 262144 bytes (decoder safety cap).

Default lifetimes: MSG 24 h, SOS 1 h, HELLO/INVENTORY/ACK/REQUEST 15 min.

### 2.1 Flags

| Bit | Value | Meaning                                                        |
|-----|-------|----------------------------------------------------------------|
| 0   | 1     | `FLAG_E2E` — payload is end-to-end encrypted (MSG only)         |
| 1   | 2     | `FLAG_CTL_AUTH` — control payload ends with an 8-byte trust-circle MAC |
| 2   | 4     | `FLAG_SESSION_INIT` — MSG carries an X3DH init header           |
| 3   | 8     | `FLAG_PQ_HYBRID` — init header includes an ML-KEM-768 ciphertext|
| 4   | 16    | `FLAG_HAS_BUNDLE` — HELLO carries an ephemeral prekey bundle    |

Unknown flag bits make the envelope invalid (fail closed).

### 2.2 Ageing

`ageEnvelope(env, transitSec)` is applied by every hop:

```
expiresInSec = max(0, expiresInSec - ceil(transitSec))
hopCount    = min(255, hopCount + 1)
```

`transitSec` is measured by the forwarding node with its OWN clock
(how long it held the envelope). Absolute clocks are never compared.
`expiresInSec == 0` means expired: drop, never relay.

### 2.3 Bucket padding

MSG payloads are padded to the size bucket of their priority class so a
relay cannot see exact content lengths:

| priority | class | bucket |
|----------|-------|--------|
| 0        | SOS   | 512    |
| 1        | TEXT  | 1024   |
| 2        | VOICE | 8192   |
| 3        | MEDIA | 16384  |
| 4        | BULK  | 16384 (round payload up to whole buckets, max 1 extra) |

If the payload already exceeds the bucket it is sent unpadded (integrity
first). Padding bytes are zeros; the ratchet body carries its own exact
length field (section 5.4).

## 3. Tags and epochs

Tags are 8-byte HMAC-SHA-256 truncations over a per-relationship secret
and a time epoch (`epochTag`):

```
tag = HMAC-SHA256(secret, "meshlink/tag/v1" || u32le(epoch))[0..8]
```

The epoch is coarse (hours) so both sides derive the same tag without
exchanging anything. Relationships:

- **Pairwise contacts** share `pairwiseSecret = X25519(ownIdentityDh,
  peerIdentityDh)`; both directions use the same tag for an epoch — the
  tag IS the conversation address.
- **Strangers** (no pairing yet) communicate through a stable
  *conversation tag* (CT): the initiator generates a random 8-byte CT and
  uses it as BOTH srcTag and dstTag, so either party's relays can carry
  the reply. Once the first ACK proves receipt, the initiator switches to
  pairwise epoch tags; the responder switches on the first pairwise-tagged
  inbound message. The CT is retired after hand-off.
- **HELLO tags** are fresh random 8-byte values minted per HELLO broadcast
  (default every 10 min, capacity 64, pruned after 1 h). A session-init
  addressed to a HELLO tag is answered by whoever still holds that tag's
  X25519/ML-KEM secrets.

Relays never learn which tags belong to which identity key. Rotating BLE
advertisement addresses are handled by the transport layer, never by the
protocol.

## 4. MTU-aware fragmentation

An envelope whose encoded size exceeds the transport MTU is split into
fragments; each fragment is framed as in section 1:

```
fragment := idx(1) || count(1) || msgId(8) || len(u16le) || data
```

- All fragments of one envelope share the envelope's `msgId`.
- `idx` is 0-based, `count <= 255`, `len <= mtu - 12`.
- The reassembler keys by `msgId`, tolerates duplicates and out-of-order
  arrival, caps sessions (64) and total buffered bytes (512 KiB), expires
  partial reassemblies after 60 s, and produces the envelope bytes only
  when every index has arrived.

## 5. Message flow

### 5.1 HELLO (type 1)

Broadcast on every link establishment and periodically (10 min default).
Payload: `version(1) || caps(1) || ephX(32) || ephPq(1184)`.

- `caps` bit 0 = willing to relay, bit 1 = Wi-Fi available, bit 2 = L2CAP.
- `ephX` is a fresh X25519 prekey; `ephPq` its ML-KEM-768 partner. Both are
  ephemeral per HELLO, held 1 h, and let ANY node start an encrypted
  conversation with a stranger without prior contact (sealed-sender-style
  session init). HELLOs are never relayed (hopLimit 1).
- Receiving a HELLO stores the bundle keyed by the HELLO's `srcTag` and
  answers with an INVENTORY of the node's current queue (section 5.3).

### 5.2 MSG (type 2)

The only type that carries user content. Payload is
`padToBucket(priority, sessionWire)` where `sessionWire` is:

```
sessionWire := isInit(u32le) || bodyLen(u32le) || [initHeader] || ratchetBody
```

- `isInit = 1` only on the first message of a session (flag
  `FLAG_SESSION_INIT` set). `initHeader` is present iff `isInit = 1`.
- `bodyLen` counts `[initHeader] + ratchetBody` — explicit because bucket
  padding makes the envelope payload longer than the content.
- `ratchetBody = ratchetHeader || AEAS ciphertext` (Double Ratchet,
  section 5.4), with AD = `type(1) || priority(1) || msgId(8)`.
- `initHeader = bundleId(8) || dhA1(32) || ekA(32) || opkHint(32) ||
  kemCt(1088)`; `kemCt` is the ML-KEM-768 ciphertext (flag
  `FLAG_PQ_HYBRID`).

Delivery: sprayed and relayed (section 5.3). A node accepts an MSG iff
`dstTag` is one of its own live tags (HELLO tag, pairwise epoch tag, or
conversation tag). On acceptance it queues an ACK for the ORIGINAL
sender's `srcTag`.

### 5.3 INVENTORY (type 4) and REQUEST (type 5)

Gossip reconciliation. INVENTORY payload: `count(1)` then per entry
`msgId(8) || copies(1) || priority(1) || sizeBucket(1) || dstTag(8)`
(19 bytes each, max 64 entries). Sent on HELLO receipt (64 newest) and
before pushes. A node that sees an INVENTORY entry whose `dstTag` is one
of its own tags answers with a REQUEST listing those `msgId`s; the holder
responds by spraying the envelope. INVENTORY/REQUEST are never relayed.

Entries also feed broadcast-storm suppression: each distinct peer
advertising a message raises that message's counter on the receiver;
above the threshold (2) the receiver stops re-pushing (randomized jitter
delay of up to 400 ms applies first).

### 5.4 ACK (type 3)

Batched receipts. Payload: `count(1)` then `msgId(8)` per entry (max 64).
`srcTag` = the ORIGINAL message's sender tag, `dstTag` = that message's
`srcTag`. ACKs are sprayed like messages (they may need relays) but are
small and ephemeral (15 min). Batched per destination and flushed by the
15 s housekeeping tick. An ACK for a conversation-tag message completes
the stranger-to-pairwise hand-off on the initiator side.

### 5.5 Ratchet (Double Ratchet)

Per Signal specification as published by the audited implementations in
use (`@noble/ciphers`, `@noble/curves`, `@noble/hashes` — pinned versions
in `package.json`):

- Root chain `KDF_RK(rk, dh_out)` = HKDF-SHA256 with info
  `"meshlink/ratchet/rk"`.
- Message chain `KDF_CK(ck)` = HMAC-SHA256(ck, 0x01) → new chain key,
  HMAC-SHA256(ck, 0x02) → message key.
- Header: `dh(32) || pn(u32) || n(u32)`.
- AEAD: XChaCha20-Poly1305, nonce = counter `n` with bytes 8..11 = `01`,
  AD as above. Skipped-message keys are stored (bounded, 512) and
  accepted out of order.
- Hybrid PQ: X3DH shared secret is `HKDF(X25519s || ML-KEM-768.ss)`, so a
  future quantum adversary who records ciphertext still faces the
  X25519 component, and the ML-KEM component protects against classical
  capture now. Both components are always used together.

## 6. Link handshake (authenticated ephemeral, over each physical link)

Every link runs a 2-message authenticated handshake before any envelope
(`src/lib/core/linksec.ts`):

1. `Handshake1` (initiator -> responder): X25519 ephemeral public key
   (32 B) || nonce (16 B) || Ed25519 signature over
   `"MeshLink-Handshake1-v1" || ephPub || nonce` by the initiator's
   identity key. 113 bytes.
2. `Handshake2` (responder -> initiator): own X25519 ephemeral (32 B) ||
   nonce (16 B) || Ed25519 signature over the full transcript
   (`"MeshLink-Handshake2-v1" || hs1.ephPub || hs1.nonce || ephPub ||
   nonce`) || responder's Ed25519 public key (32 B). 145 bytes.
3. Both sides derive per-direction keys:
   `hkdf-sha256(ikm = X25519(eI, eR), salt = SHA256(transcript), info =
   "MeshLink-LinkKeys-v1", 64)` -> first 32 bytes protect initiator ->
   responder frames, last 32 bytes responder -> initiator.

- The transcript binding prevents replay of handshake messages; the
  responder verifies the initiator's identity from the first sealed
  application frame (or trusts-on-first-use for strangers), keeping
  identity keys out of plaintext handshake traffic.
- Link keys are in-memory only; every re-establishment redoes the
  handshake. This gives link-local confidentiality and integrity plus
  defense-in-depth on top of the E2E ratchet (a malicious relay reads
  nothing at either layer).
- ML-KEM-768 participates at the SESSION layer (X3DH hybrid), not the
  link layer; link keys are worthless after the link drops.

## 7. Relay policy

`relayDecision(policy, env, ctx)` gates every relay attempt. A node
relays only if ALL of: relay opt-in is on; the envelope is not expired;
`hopCount < hopLimit`; the message id is unseen (bounded dedup set);
per-peer and global quotas allow; optional trust-circle MAC verifies when
the policy restricts relaying to trusted traffic; battery-saver allows
(for non-SOS); the per-peer rate limiter allows. SOS is exempt from
battery-saver and eviction (highest priority, never evicted in favor of
lower classes).

## 8. Golden test vectors

### 8.1 SOS envelope header

A minimal SOS MSG envelope with an empty payload (74 hex chars = 37
bytes). Validates magic, version, type, priority, flags, hop limit,
expiry, spray field and tag offsets:

```
4d4c020200010500100e080001020304050607deadbeef00000000cafebabe000000000400
```

Field walk: magic `4d4c`, version `02`, type `02` (MSG), priority `00`
(SOS), flags `01` (E2E), hopLimit `05` (SOS cap), hopCount `00`,
expiresInSec `100e` (LE) = 3600, sprayCopies `08`, msgId
`0001020304050607`, srcTag `deadbeef00000000`, dstTag `cafebabe00000000`,
payloadLen `0000`.

### 8.2 Fragment framing

Envelope bytes `00 01 02 ... 0f` (16 bytes) fragmented at MTU 14
(2 payload bytes per fragment) produce 8 fragments, each
`idx || count=08 || msgId || len=0002 || data`. The reassembler returns
the original 16 bytes regardless of arrival order and deduplicates
repeated fragments.

### 8.3 Session wire

`isInit=0` wire `00000000 || bodyLen(u32) || body`; `isInit=1` wire adds
the 1192-byte init header (`8+32+32+32+1088`) before the ratchet body.
Vector: a sender using a fixed test ratchet produces a deterministic
ratchetBody only with a fixed nonce source; the conformance suite
therefore pins the FRAMING (offsets, lengths, AD construction) and the
crypto vectors separately in `tests/crypto.test.ts` (X25519, ML-KEM,
HKDF, HMAC, AEAD round trips with published test keys).

## 9. Compatibility rules

- Envelopes with an unknown `version` byte are dropped by the decoder and
  MUST NOT be relayed (prevents version-confusion floods).
- Unknown flag bits are a decode error (fail closed).
- Unknown envelope types (>= 6) are a decode error.
- Control bodies (INVENTORY/ACK/REQUEST) cap their entry count at 64;
  larger counts are a decode error.
- All parsers throw `ProtocolError` on structural violations; callers
  treat any parse failure as junk and never relay it.
