# MeshLink Privacy Policy (plain language)

Last updated: 2026-11-13. This policy describes the MeshLink app as
built in this repository. It is written for the person holding the
phone. No company operates this app; there are no accounts, no servers
and no analytics.

## What never happens

- MeshLink never sends anything to the internet. It has no backend, no
  telemetry, no crash reporting, no ads and no analytics SDKs.
- MeshLink never reads your contacts, your location, your photos or your
  microphone except when you explicitly use a feature that requires it
  (see PERMISSIONS list in docs/PERMISSIONS.md).
- Your messages are never stored anywhere except your own phone and the
  phones that volunteer to carry them.

## What is stored on your phone

- **Your identity keys** (Ed25519 + X25519): created offline on first
  run. The private half is stored through `expo-secure-store` (Android
  Keystore / iOS Keychain backed). If secure storage is unavailable the
  engine falls back to the local database and records that condition.
- **Message database** (SQLite): your chats, delivery states, contacts
  and settings. This build does NOT encrypt the database file at rest:
  the OS disk encryption and device lock are the only at-rest controls.
  Treat a seized unlocked phone as readable. Panic wipe deletes the
  database, keys and unlock code.
- **Relay queue**: copies of messages your phone is carrying for others
  while you have opted in to relaying. Encrypted end-to-end — your phone
  cannot read them either. Expire automatically per envelope lifetime
  (messages 24 h, SOS 1 h, control traffic 15 min).
- **Network history**: a local log of "saw a peer", "relayed a message"
  events with no message content and no real names — only short random
  tags. Used for the diagnostics screen. You can clear it.
- **Camera and microphone**: used only when you tap photo or voice-note.
  Recordings are written to the app cache; you can delete them with the
  panic wipe.

## What other people's phones can see

- Phones you talk to directly: that you exist, an opaque rotating tag,
  and your encrypted traffic. Paired contacts know your display name
  because you showed it to them during QR pairing.
- Phones carrying your messages (relays): an encrypted envelope, a
  priority class, a size bucket ("up to 1 KB"), the remaining lifetime
  and opaque rotating tags. They cannot read the message.
- The LAN access point and anyone sniffing it: that two IP addresses
  opened a TCP connection, plus sealed frame sizes and timings. Message
  contents and names are not exposed.
- Bluetooth observers: nothing in this build, because BLE is not active.

## What relaying means

If you enable "relay for others" (off by default for battery and
privacy reasons), your phone stores and passes along messages for
nearby people. You opt in; you can turn it off any time from Network.
There is no charge-only scheduler in this build. You can never read what
you carry.

## SOS messages

SOS messages are sent at highest priority and use more relay copies. They
go to trusted contacts and to the ephemeral bundles of nearby devices;
each copy is still end-to-end encrypted for that recipient. They are not
broadcast in the clear, and they are not a connection to emergency
services.

## Children

MeshLink is a general-purpose communication tool with no age gate and no
data collection; nothing is sent anywhere, so there is nothing to
consent to beyond the on-device features.

## Contact

This build is developed as an open, inspectable codebase. There is no
support address because there is no operator; the source code in this
repository is the documentation of record.
