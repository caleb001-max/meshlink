# Distribution: get the Android APK onto a phone

GitHub Releases is the host. It is free, has no practical size limit for an
APK, gives a stable HTTPS link Chrome can download directly, and keeps the
binary next to the source instead of in it.

Nothing here is a store listing. The app is not on Google Play, so it is not
searchable in Chrome; you share the release link.

## 1. Build the APK

```bash
npx eas-cli@latest login          # free Expo account, once
npm run build:android             # preview profile -> standalone APK
```

The build page shows a download button when it finishes (10-20 minutes).
Save the file as `meshlink.apk`.

The `preview` profile bundles the JavaScript, so the installed app runs
without Metro. The first build creates an Android signing key in your Expo
account; keep that account, because a different key means future APKs cannot
install over an older one.

## 2. Create the GitHub repository (public)

Anonymous downloads only work from a public repo. If the repo is private,
every phone must be signed in to GitHub before the link works.

```bash
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin master
```

## 3. Publish the release

Web UI (works entirely in Chrome, no tools to install):

1. Open `https://github.com/<you>/<repo>/releases/new`.
2. Tag: `v1.0.0`. Title: `MeshLink 1.0.0 (Android preview)`.
3. Drag `meshlink.apk` into the assets box. **Name it exactly
   `meshlink.apk`** - the stable link below depends on that name.
4. Describe the build honestly, for example: "Unsigned preview build.
   Unit-tested core, not yet verified on a device. Android 8+."
5. Publish.

Command line equivalent, if GitHub CLI is installed (`winget install
GitHub.cli`):

```bash
gh release create v1.0.0 meshlink.apk \
  --title "MeshLink 1.0.0 (Android preview)" \
  --notes "Unsigned preview build. Unit-tested core, not yet verified on a device. Android 8+."
```

Never commit the APK - `.gitignore` already excludes `*.apk`, `*.aab`, `*.ipa`.

## 4. The download link

Stable link, always points at the newest release asset with that name:

```
https://github.com/<you>/<repo>/releases/latest/download/meshlink.apk
```

Open it in Chrome on the phone. Chrome saves the file to its downloads
(`chrome://downloads` lists it). Tap it, and allow "install unknown apps" for
Chrome when Android asks.

You can also download on a PC and move the file over USB, Google Drive, or
`python -m http.server` on the same Wi-Fi.

## iPhone

No free path exists. iOS installs must be signed by Apple, which needs a paid
Apple Developer account and a registered device UDID:

```bash
npx eas-cli@latest device:create   # open the QR on the iPhone to register it
npm run build:ios
```

TestFlight is the realistic route after that. An unsigned `.ipa` on a GitHub
Release installs on nothing.

## What to tell people

This is a test build, not a product: the protocol core is unit-tested and
simulated, but the app has never been run on a phone. Two phones on the same
Wi-Fi or hotspot are required to see messaging at all. Android may show a
Play Protect warning because the APK is not distributed through Play; that is
expected for sideloaded builds. See `docs/STATUS.md` for what is and is not
verified.
