# MeshLink User Manual

This manual describes the app as built in this repository. It does not
promise features that are absent. If a section says "not in this build",
the UI will not offer it.

## 1. Install and open

1. Install the development build on each phone. Expo Go is not enough
   because the LAN transport uses a native TCP module.
2. Open **Calculator**. It works as a normal calculator.
3. First run shows onboarding: choose a display name (max 24 characters)
   and a secret code of 3–8 digits followed by an operator
   (`÷ × − + %`). Example: `1337%`.
4. To open MeshLink later, type that code into the calculator and press
   the operator/equals key. The hidden app replaces the calculator.
5. The app locks when it goes to the background. Return to the
   calculator by backgrounding and reopening, then enter the code again.

There is no account and no recovery. If you forget the code, you must
reinstall or wipe and start over.

## 2. Connect two phones

Both phones must be unlocked, on the same Wi-Fi network or one phone's
personal hotspot, and have the app in the foreground for discovery to
work. There is no internet path.

### Pair by QR (recommended)

1. On phone A: **Pair** from the Chats header, or Settings → MeshLink →
   Pair.
2. Phone A shows a large QR code. It contains only public keys and a
   signed prekey bundle.
3. On phone B: Pair → **Scan**, allow camera access, and point the camera
   at phone A's code.
4. Phone B verifies the prekey signature and opens a chat. Phone A sees
   the new contact when it announces/refreshes.
5. Compare the **safety number** on both phones in Security. If the
   digits match, tap **Mark verified**. This step is what makes
   verification meaningful; pairing alone is trust-on-first-use.

If the QR code will not scan: increase brightness, clean the screen, hold
steady, and try again. The payload is large (about 2.8 KB) because it
carries a post-quantum key.

### Nearby (strangers)

1. Open **Nearby** on both phones.
2. Tap **Scan local network**. The app walks the local /24 and opens
   sealed links.
3. Devices appear as **anonymous rotating tags**, not names.
4. Tap **Say hello** on a tag. The other phone receives a message
   request. If they accept, the conversation moves to pair-style
   encrypted tags.
5. If scanning is blocked by the access point, use **Manual link** and
   enter the other phone's IP address (shown in Nearby/Network).

## 3. Chatting

- Type a message and press ➤. Text is stored locally and sealed before
  it leaves the device.
- Status labels are literal:
  - **Queued · no route yet** — no link or relay has accepted it.
  - **Handed to relay** — another phone took custody; not delivered.
  - **Delivered** — the recipient's device acknowledged it.
  - **Failed** — the node gave up after retries.
- No label is invented. If the phone is offline, the message stays queued
  and can be carried later by people who move between networks.
- **Message requests**: a stranger's first message shows Accept/Block.
  Nothing is treated as an accepted conversation until you choose.
- **Block**: future messages from that contact are discarded.
- **Voice note**: tap 🎙, allow microphone access, record up to 30
  seconds, tap ⏹ to send. The clip is the platform recorder format
  (M4A/AAC), not Opus, and is capped at 48 KB inline. Longer/higher
  quality clips are rejected rather than truncated silently.
- **Photo**: tap 📷, take a picture, and it is compressed for the mesh.
  Large photos are rejected with a message explaining the 48 KB limit.
  There is no file/video/document transfer in this build.

## 4. Network screen

- **Wi-Fi / hotspot**: listener address, port (47474), and open sockets.
- **Bluetooth**: explicitly marked not active. Do not expect BLE range.
- **Relay**: off by default. Turning it on lets this phone store and
  forward sealed envelopes for others. It cannot read them. Turning it
  off stops forwarding immediately.
- **Scan local network / Re-announce**: reconnect after moving networks.
- **Manual link**: fallback IP connect.
- **Links**: each link shows transport, sealed state and peer tag.
- **SOS**: sends an urgent message to trusted contacts and nearby
  devices. It is high priority and long-lived but still store-and-forward.
  It does not call emergency services.
- **Event log**: local diagnostics (link up/down, relay, security). Clear
  it without touching messages.

## 5. Security screen

- Review every contact's 30-digit safety number. Compare in person.
- **Mark verified** records that you compared it. **Unverify** reverses
  that.
- **Block/Unblock** controls acceptance.
- The summary card states what the crypto does and does not protect. The
  database is not encrypted at rest in this build; OS disk encryption and
  device lock matter.

## 6. Storage screen

- Shows contact, message, queue, event and database-size counts.
- Shows this device's public identity prefix. The private half lives in
  secure storage.
- **Clear event log** frees diagnostics rows only.
- **Go to danger zone** opens Settings for a panic wipe.

## 7. Settings

- Change display name (sent to paired contacts inside sealed messages).
- Change unlock code. Only a hash is stored; there is no recovery.
- Navigate to Pair, Nearby, Network, Security and Storage.
- **Panic wipe** deletes the identity, sessions, contacts, messages,
  relay queue, database and unlock code. It cannot be undone.

## 8. Troubleshooting

| Symptom | Likely cause and action |
| --- | --- |
| No devices after Scan | Different networks, client isolation on the AP, or the other app is backgrounded. Use a hotspot or manual IP. |
| Manual link fails | Wrong IP, port 47474 blocked, or the other phone's listener is off. Check Network on both. |
| Messages stay Queued | No sealed link and no relay has taken custody. Move closer, rescan, or wait for store-carry-forward. |
| Photo rejected | Encoded image exceeds 48 KB. Lower quality/zoom out; large media is not supported. |
| QR will not scan | Payload is large. Raise brightness, stabilize, or pair via Nearby and compare safety numbers. |
| Voice note silent | Microphone permission denied, or audio mode is still in recording mode. Reopen the chat and retry. |
| App locked unexpectedly | Backgrounding locks the app by design. Enter the calculator code again. |
| iOS cannot see the LAN | Local Network permission denied. Enable it in iOS Settings → Privacy → Local Network. |

## 9. Limits you must plan around

- Same LAN only. One phone cannot extend another's radio range.
- Delivery depends on density and movement; store-carry-forward can take
  minutes or hours.
- Bluetooth, calls, groups, files, notifications and database encryption
  are not in this build.
- The crypto composition is unaudited. Do not use this for life-safety
  communication until the device checklist and an independent review are
  complete.

## 10. Removing data

Use Settings → Panic wipe for a full erase, or uninstall the app. There
is no remote wipe and no backup.
