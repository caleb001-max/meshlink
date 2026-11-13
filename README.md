# MeshLink (Chimera)

An offline-first mesh messenger with a calculator disguise. Two phones on
the same Wi-Fi or hotspot can pair, exchange end-to-end encrypted
messages, queue mail when no route exists, and relay sealed envelopes for
other phones that opt in. No accounts, no server, no internet path.

This repository is the Expo/React Native app plus the tested MeshLink v2
protocol core. **Read [docs/STATUS.md](docs/STATUS.md) before believing
any capability claim.** The short version: the protocol, crypto, relay and
routing logic are unit-tested and simulated; the app has **not** been run
on a phone in this environment, and Bluetooth, calls, groups, large files
and database encryption do not exist in this build.

## Quick start

Requirements: Node.js 20+ and npm. A phone needs a **development build**;
Expo Go does not include `react-native-tcp-socket`, so LAN messaging will
not work there.

```bash
./start.sh          # macOS/Linux/Git Bash: installs deps if needed, checks, starts Metro
start.bat           # Windows: same flow
npm start           # if dependencies are already installed
```

`start.sh`/`start.bat` run `scripts/preflight.mjs`, then `expo start`.
Both print the QR for Expo and the next step for a development build.
Nothing is sent to the internet by the app; the dev server only serves the
bundle on your LAN.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm start` | Preflight + Expo dev server (automatic via `prestart`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest suite (74 tests, ~2–3 min because crypto is real) |
| `npm run check` | Typecheck + tests |
| `npm run android` | Build/run a local Android dev build (needs Android SDK) |
| `npm run ios` | Build/run a local iOS dev build (needs macOS/Xcode) |
| `npm run build:android` | Cloud-build an installable Android APK via EAS (no Android SDK needed) |
| `npm run build:ios` | Cloud-build an iOS ad hoc build via EAS (needs paid Apple Developer account) |
| `npm run preflight` | Environment and dependency check only |

### Install on a phone (no dev machine required)

Android, from Windows/macOS/Linux:

```bash
npx eas-cli@latest login          # free Expo account, once
npm run build:android             # ~10-20 min cloud build, prints a download URL
```

Then publish the downloaded APK as a **GitHub Release** so the phone gets a
stable Chrome download link:

1. `https://github.com/<you>/<repo>/releases/new`, tag `v1.0.0`.
2. Upload the APK named exactly `meshlink.apk`, publish.
3. Open in Chrome on the phone:
   `https://github.com/<you>/<repo>/releases/latest/download/meshlink.apk`

Allow "install unknown apps" for Chrome, install, open **Calculator**, set
an unlock code (3–8 digits + operator, e.g. `1337%`), then type it to reveal
MeshLink. The repo must be public for downloads without a GitHub login.
Never commit the APK; `.gitignore` already excludes it. Full steps and
caveats: [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).

iPhone: EAS needs your device UDID registered (`npx eas-cli@latest
device:create`) and a paid Apple Developer account, because every iOS
install must be signed. Without that, iOS cannot be installed at all.
With a Mac, `npm run ios` works as a local alternative.

The APK build is `preview` (bundled JS, runs without Metro). For live
reload during development use a development build instead: `npx
eas-cli@latest build --profile development` after `npx expo install
expo-dev-client`.

First run on a phone: build a development client
(`npx expo run:android` or `npx eas build --profile development`), install
it, then open the calculator. Set a display name and an unlock code of
3–8 digits plus an operator (for example `1337%`). Type that code on the
calculator to open the app. Full steps: [docs/USER_MANUAL.md](docs/USER_MANUAL.md).

## What works today

- Calculator disguise and passcode-gated hidden app.
- One transport: length-prefixed TCP over the local network/hotspot.
- QR pairing with signature verification; safety numbers.
- Sealed links, X3DH + ML-KEM-768 hybrid sessions, Double Ratchet.
- Store-and-forward queue, ACK-based delivery states, spray-and-wait relay
  when the user opts in.
- Chat with text, small photos and 30-second voice notes (48 KB inline cap).
- Message requests, block, verify, SOS queue, network and storage views.
- Panic wipe.

## What does not work (and is not shown as working)

Bluetooth, live calls/push-to-talk, groups, file transfer, Opus, read
receipts, notifications/background delivery, disappearing messages,
database encryption at rest, relay-node tooling, internet/LoRa gateways,
and cross-platform golden vectors. See the matrix in
[docs/STATUS.md](docs/STATUS.md).

## Project layout

```text
src/app/                 Expo Router screens (calculator, chats, pair, network, …)
src/components/ui.tsx    Shared themed UI kit
src/lib/theme.ts         Jet black / soft white / flame orange tokens
src/lib/core/            Tested protocol, crypto, link security, relay, node, simulator
src/lib/engine/          App bridge: engine singleton, SQLite store, LAN transport
src/lib/lock.tsx         Calculator gate, passcode hash, auto-lock, panic wipe
tests/                   Vitest: protocol, crypto, relay, node, simulator
tools/sim/               Simulator runner
docs/                    Status, metrics, decisions, protocol, security, testing
scripts/preflight.mjs    Startup checks
```

## Documentation

- [docs/STATUS.md](docs/STATUS.md) — capability labels with evidence.
- [docs/METRICS.md](docs/METRICS.md) — proposed targets and simulated results.
- [docs/DECISIONS.md](docs/DECISIONS.md) — ADRs, including deferred work.
- [docs/protocol/SPEC.md](docs/protocol/SPEC.md) — wire format.
- [docs/security/THREAT_MODEL.md](docs/security/THREAT_MODEL.md) — adversaries and gaps.
- [docs/PRIVACY_POLICY.md](docs/PRIVACY_POLICY.md) — what is stored and what is not.
- [docs/PERMISSIONS.md](docs/PERMISSIONS.md) — every OS permission and why.
- [docs/USER_MANUAL.md](docs/USER_MANUAL.md) — step-by-step usage.
- [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) — build an APK and publish it as a GitHub Release.
- [docs/architecture/SPIKE_RESULTS.md](docs/architecture/SPIKE_RESULTS.md) — platform findings.
- [docs/testing/DEVICE_TEST_CHECKLIST.md](docs/testing/DEVICE_TEST_CHECKLIST.md) — hardware verification plan.

## Security disclaimer

The cryptography is assembled from pinned, audited noble libraries, but the
composition (X3DH variant, ratchet bindings, link handshake) is unaudited.
This is not a replacement for Signal, and it is not an emergency service.
Do not rely on it for life-safety communication until the device checklist
is complete and an independent review has been done.

## License

MIT. See [LICENSE](LICENSE).
