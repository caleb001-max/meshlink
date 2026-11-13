# Device Test Checklist (run by a human with hardware)

These are the manual steps that CANNOT be verified in this environment:
no Mac/Xcode, no Android SDK, no physical phones, no BLE hardware. Every
item records evidence back into `docs/STATUS.md`. Emulators do not count
for any item here.

**Important:** this build has one working transport — LAN TCP. There is no
BLE implementation, so BLE sections are blocked. Do not mark a BLE item
passed until BLE exists and is tested.

Hardware needed for the current build: 2+ Android phones (one low-end),
2 iPhones, and a Wi-Fi access point or hotspot that does not isolate
clients. A BLE sniffer is listed only for the future BLE work. There is no
relay-node tool in this repository.

## 0. Build and install

- [ ] Android debug APK builds (EAS cloud build: `npx eas build --profile
      development --platform android`) and installs on both Android
      phones. Record build number and date.
- [ ] iOS: developer build via `npx eas build --profile development
      --platform ios`, installs via TestFlight or direct device. Record
      build number and date. (Cannot be done in this environment; code is
      written to compile but is Unverified until this passes.)
- [ ] App opens; calculator lock screen appears with no MeshLink
      branding.

## 1. Identity, pairing, lock

- [ ] Onboarding saves a display name and a 3–8 digit + operator code.
- [ ] Typing the code on the calculator opens the hidden app; the wrong
      code does not.
- [ ] Backgrounding the app locks it again.
- [ ] QR shows on phone A; phone B scans it; pairing completes.
- [ ] Safety number is visible on both phones and IDENTICAL. Record the
      number.
- [ ] Verify the contact; restart the app; verification persists.
- [ ] Wipe one phone and re-pair; the safety number changes and the
      contact shows as unverified.

## 2. One-hop messaging over LAN (current transport)

- [ ] Both phones on the same AP, both unlocked and foreground, 2 m
      apart: send a text. Record delivery time (5 samples).
- [ ] Recipient app killed: sender shows "Queued" or "Handed to relay",
      never "Delivered". Reopen B; it delivers. Record recovery time.
- [ ] Recipient on a different Wi-Fi network: message stays queued.
      This proves there is no internet path.
- [ ] Airplane mode with Wi-Fi on, same hotspot: text delivers.
- [ ] Turn Wi-Fi off on one phone: links drop; SOS and text remain
      queued, with honest UI states.

## 3. Background behavior (the honest limits)

- [ ] Android: sender foreground, receiver backgrounded. Record whether
      delivery happens and how long it takes.
- [ ] iOS: both apps backgrounded, screen off. Record result. A failure
      is an expected, documented limit — record it, do not treat it as a
      bug.
- [ ] Android with battery optimization ON vs disabled for the app:
      compare discovery reliability. Record both.
- [ ] Locking the phone (not just backgrounding) and returning: the
      hidden app requires the passcode again and links recover after
      re-unlock.

## 4. Multi-hop relay (3+ phones in a line)

- [ ] A – B – C where A and C are out of direct Wi-Fi range but both
      reach B. B relays. C receives; A eventually shows "Delivered".
      Record latency.
- [ ] Turn B's relay OFF in Network: A→C stops delivering (stays
      queued). Turn it back on: delivers. Record.
- [ ] 4–5 phone line: same check. Record latency and failure cases.
- [ ] Confirm the relay phone's event log shows forwarding events and
      that the relay UI never displays message content.

## 5. Store-carry-forward (mobility)

- [ ] A and C never share a network at the same time; B moves between
      them. Message from A to C delivers eventually. Record total time.
- [ ] Recipient phone restarts mid-transit: after restart, new messages
      deliver. Confirm any lost in-flight message remains visibly
      "Handed to relay" rather than being shown as delivered.

## 6. Metadata privacy (current LAN build)

- [ ] Packet capture on the AP during a text: frames carry a 4-byte
      length prefix and opaque sealed bytes. Confirm no names, no
      message text, no full identity keys. Record sample hex dumps.
- [ ] Envelope/tag diagnostics: tags shown are truncated to 8 hex
      characters, never full identity keys.
- [ ] Relayed traffic on B cannot be read by B: verify B's UI and
      database do not contain the plaintext.

### Blocked until BLE exists

- [ ] Sniffer captures advertisements for 10 min: confirm no display
      name, no identity keys, and rotation per epoch. (Blocked: BLE is
      Unsupported in this build.)
- [ ] Sniffer captures an established BLE connection: payloads opaque.
      (Blocked: BLE is Unsupported in this build.)

## 7. Flood and abuse

- [ ] Send 20 rapid messages A→B (both foreground): UI stays
      responsive; messages deliver; queue indicator shows honest states.
- [ ] Unknown sender (stranger) messages land as message requests, not
      accepted conversations. Block one; verify no further delivery.
- [ ] Send a photo above the 48 KB inline cap: the app rejects it with a
      clear message and does not pretend to send.

## 8. Battery

- [ ] Idle with relaying OFF, 1 h: record battery % drop on both OSes.
- [ ] Idle with relaying ON, 1 h: record drop.
- [ ] Active chat 15 min: record drop.
- Compare against the proposed targets in `docs/METRICS.md`. These are
  device numbers; do not substitute simulated values.

## 9. Panic wipe

- [ ] Settings → Panic wipe → confirm. The app returns to onboarding;
      relaunch starts fresh; the database is gone; a new identity and
      safety number appear.

## 10. Cross-platform LAN interop

- [ ] Android ↔ iOS on the same AP: scan, manual link, pairing, text,
      photo, voice note. Record per-feature results with dates.
- [ ] If any step fails, record the exact failure and keep the row
      Unverified or mark the feature Unsupported. Never claim interop
      without this test.
- [ ] BLE cross-platform: **blocked** until a peripheral implementation
      exists and passes Android↔Android first.

## Recording results

For each line: date, devices, OS versions, result (pass/fail/limited),
numbers. Update `docs/STATUS.md` rows from Unverified to Device-verified
only when the evidence exists here.
