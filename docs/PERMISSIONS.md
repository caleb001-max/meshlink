# Permissions

MeshLink requests the minimum needed for the features it actually ships.
No permission is used for analytics, advertising or background tracking.

| Permission | When | Why | Config |
| --- | --- | --- | --- |
| Camera | Only while the Pair → Scan tab or the photo modal is open | Read a QR pairing code; take a photo attachment | `expo-camera` plugin in `app.json` |
| Microphone | Only after tapping the voice-note button | Record a 30-second voice note | `expo-audio` plugin; `expo-camera` also declares a microphone string because it can record video, which this app does not use |
| Local network (iOS) | First time the app starts the LAN listener | Reach phones on the same Wi-Fi/hotspot over TCP | `NSLocalNetworkUsageDescription` in `app.json` |
| Internet (Android) | Installed by React Native/Expo by default | Required for local TCP sockets and the Metro bundle in development | Framework default; the app has no internet backend |

## Not requested

- **Bluetooth**: the Bluetooth permission strings, the BLE plugin and the
  BLE packages were removed. BLE is Unsupported in this build, so the app
  does not ask for a capability it cannot use.
- **Location**: no location permission. Local-network discovery uses the
  device's IP address, not GPS.
- **Contacts**: the app never reads the OS address book.
- **Photos/media library**: photos are taken in-app with the camera and
  kept as base64 in the local database; the gallery is not read.
- **Notifications**: no notification permission and no push token.
- **Background activity**: no background service is registered. The LAN
  listener runs only while the app process is alive and unlocked.

## Revoking

Revoke camera or microphone access in the OS settings; pairing by camera
and voice notes stop working, and text messaging is unaffected. On iOS,
denying local-network access blocks LAN links entirely; switch it back on
in Settings → Privacy → Local Network.
