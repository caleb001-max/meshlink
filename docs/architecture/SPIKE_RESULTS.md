# Platform Spike Results

Date: 2026-11-13. These are engineering findings from this environment,
not device certifications. They explain why the build looks the way it
does and which assumptions remain untested.

## Environment

| Item | Finding |
| --- | --- |
| OS | Windows 10 x64, Git Bash |
| Node | v24.22.1 |
| Expo SDK | `expo ~58.0.25`, React Native 0.88.1, React 19.3 |
| Android SDK / emulator | Not installed |
| Xcode / Mac | Not available |
| Physical phones | None |
| BLE hardware or sniffer | None |

Consequence: every transport, permission and battery finding below is
**Unverified on hardware**. `docs/STATUS.md` records that explicitly and
`docs/testing/DEVICE_TEST_CHECKLIST.md` is the plan to close it.

## Spike 1: BLE peripheral path

- The prototype had a BLE scanner (`react-native-ble-plx`) and a
  scaffold for `react-native-ble-peripheral`, but no working peripheral
  service, no chunking, and no iOS path.
- iOS only exchanges BLE data through GATT; a central-only design cannot
  receive from another phone. Android-to-Android would still need a
  verified peripheral.
- This build therefore does **not** advertise BLE as a transport. The
  prototype BLE module was deleted instead of leaving a fake scanner.
- To revive it: implement a GATT server, chunk frames to the negotiated
  MTU, test iOS↔Android and Android↔Android on real hardware, and record
  sniffer evidence that advertisements leak no identity.

## Spike 2: LAN TCP transport

- `react-native-tcp-socket` exposes a TCP server and client. TCP is a
  byte stream; `MeshNode` expects complete link frames. The spike
  decision was a 4-byte big-endian length prefix per frame, with
  buffering on receive and a 1 MB safety cap.
- Port: 47474. Discovery: scan the local /24 in eight waves of 32 hosts
  with a 450 ms connect timeout, then broadcast a HELLO on each link.
- Manual IP link exists because many access points isolate clients or
  block scans.
- iOS needs the local-network permission prompt; `app.json` includes
  `NSLocalNetworkUsageDescription`. Android needs no special permission
  for TCP, but OEM background killers can freeze the app.
- Not measured: throughput, connection success rate, firewall behavior,
  hotspot client isolation, battery cost of repeated scans. No device
  has run this code.

## Spike 3: Expo SDK 58 API reality check

Training data is not a reliable guide for this SDK. Findings that changed
the code:

- `expo-status-bar` no longer accepts `backgroundColor`; passing it fails
  typecheck. Removed (Android edge-to-edge handles the background).
- `expo-file-system` uses the new `File`/`Paths` classes; `File.base64()`
  and `File.write(bytes)` are the paths used for voice notes.
- `expo-camera` uses `CameraView` with `barcodeScannerSettings`; the old
  permission/scan APIs are gone.
- `expo-audio` uses `useAudioRecorder`, `useAudioRecorderState` and
  `setAudioModeAsync`. The recorder produces the platform default
  compressed format (M4A/AAC), not Opus.
- `react-native-tcp-socket` writes accept `Uint8Array`; incoming data is
  normalized from Buffer/string before reassembly.

Evidence: `npx tsc --noEmit` is clean after these fixes.

## Spike 4: QR pairing payload size

- A pairing code contains Ed25519 + X25519 public keys plus a 1184-byte
  ML-KEM-768 public key and a signed prekey. The JSON payload is roughly
  2.8 KB, close to the Version 40 QR limit (2953 bytes in byte mode).
- The UI uses error-correction level L and a 272 px code to fit. A dirty
  or dim screen may still fail to scan. This is Unverified on devices.
- Rejected alternative: omitting the PQ key to shrink the code. That
  would break the hybrid handshake and is not acceptable.
- Fallback for field use: transmit the code through a channel you already
  trust, or pair by nearby hello and compare safety numbers.

## Spike 5: Local storage

- `expo-sqlite` with WAL is the store. It is fast and transactional but
  **not encrypted**. The spike considered SQLCipher but no
  Expo-supported, device-tested path was available here.
- Identity private keys go through `expo-secure-store`; if that module
  fails, the engine falls back to the SQLite key/value table and the
  condition is visible in code, not silently claimed as secure.
- Consequence: database-at-rest encryption is recorded as Unsupported in
  STATUS. OS disk encryption is the only at-rest control in this build.

## Spike 6: Simulator fidelity

- The simulator drives the production `MeshNode` with an injectable
  clock and virtual radio, so codec, crypto, relay and storage behavior
  are the same code that ships.
- It intentionally does not model RF interference, BLE collisions, MTU
  timing or OS scheduling. Metrics are labeled Simulated and should be
  read as routing-behavior evidence only.
- Runtime is heavy because real crypto runs: the 74-test suite takes
  about 134 s, with the simulator tests dominating.

## Architecture consequences

1. One transport is wired (LAN). Everything else is marked Unsupported
   rather than half-implemented.
2. The app owns no second protocol stack: the UI reads engine snapshots
   and calls engine methods only.
3. Media stays small and inline (48 KB base64 cap) until chunked transfer
   exists; the UI rejects oversize attachments instead of pretending to
   upload them.
4. Device verification is the gating next step. No code change can
   substitute for phones, a Mac for iOS builds, and a BLE sniffer.
