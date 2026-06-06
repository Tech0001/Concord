# Concord — native iOS wrapper (Capacitor)

Build handoff for the Mac. Goal: wrap the **existing** Concord web app in a
native iOS container so it gets **Picture-in-Picture** and **background
audio** — capabilities Apple blocks in home-screen PWAs but allows in a
real app's WKWebView. No UI is rebuilt; the app loads the live server.

## Why a wrapper (not a rewrite)

The web PiP API is disabled in `display: standalone` home-screen PWAs.
A WKWebView inside a native app is **not** subject to that restriction.
So a thin Capacitor shell pointed at the running Concord server gets us
PiP + background audio while reusing 100% of the web app.

## What's already wired on the web side — DO NOT remove

`client/src/components/VideoDrawer.tsx` already has the media layer the
wrapper needs:
- Both audio and video render through a `<video>` element with
  `playsInline` (so audio can PiP too).
- A "Pop out" button + `togglePiP()` / `enterPiP()` using
  `webkitSetPresentationMode` (iOS) with `requestPictureInPicture()`
  fallback.
- Auto-PiP on app switch: a `visibilitychange` handler **and** the
  native `autoPictureInPicture` property.
- Media Session API: lock-screen / Control Center title + transport
  (play / pause / seek) handlers.

These no-op in the blocked PWA but **work inside the WKWebView**. They are
the wrapper's media plumbing — leave them in place.

## Prereqs (Mac)

- Xcode + Command Line Tools, CocoaPods (`sudo gem install cocoapods`)
- Node 18+
- Apple Developer account (already have it)
- **Tailscale** running on BOTH the home PC (running Concord on :5050) and
  the iPhone. Get the PC's MagicDNS name (e.g. `concord-pc.tailXXXX.ts.net`).
  Sanity check first: from the iPhone browser, `http://<name>:5050` should
  load Concord. The wrapper is pointless until that works.

## Step 0 (recommended) — serve Concord over HTTPS via Tailscale

Avoids the iOS App Transport Security cleartext exception. On the PC:

```bash
tailscale serve --bg --https=443 http://localhost:5050
```

This exposes `https://concord-pc.tailXXXX.ts.net` (valid cert, MagicDNS).
Use that as the app URL. If you skip this and use plain `http://…:5050`,
you must add the ATS exception in Step 4.

## Step 1 — create the wrapper project (separate from the Concord repo)

```bash
mkdir concord-ios && cd concord-ios
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor/ios
npx cap init Concord com.<you>.concord --web-dir=www
mkdir www && printf '<!doctype html><meta http-equiv="refresh" content="0">' > www/index.html
```

`www` is only a fallback; the app loads `server.url` instead.

## Step 2 — capacitor.config.ts

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.<you>.concord',
  appName: 'Concord',
  webDir: 'www',
  server: {
    // HTTPS via `tailscale serve` (Step 0):
    url: 'https://concord-pc.tailXXXX.ts.net',
    cleartext: false,
    // If you stayed on plain http, use instead:
    // url: 'http://concord-pc.tailXXXX.ts.net:5050',
    // cleartext: true,
  },
  ios: { contentInset: 'always' },
};

export default config;
```

The Express server serves both the client and the `/api/*` endpoints on
the same origin, so everything is same-origin inside the WebView — no CORS.

## Step 3 — add iOS + sync

```bash
npx cap add ios
npx cap sync ios
```

## Step 4 — Info.plist  (`ios/App/App/Info.plist`)

Background audio:

```xml
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
```

Only if you used plain http (no Tailscale HTTPS), also add an ATS
exception (scoped to the tailnet is cleaner than NSAllowsArbitraryLoads,
but for a personal app either is fine):

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsArbitraryLoads</key>
  <true/>
</dict>
```

## Step 5 — WKWebView media flags

Capacitor already sets `allowsInlineMediaPlayback = true` and requires no
user gesture for playback, so inline + autoplay work. WKWebView's
`allowsPictureInPictureMediaPlayback` **defaults to true**, so PiP should
work out of the box.

If PiP does NOT engage, set it explicitly. In Capacitor 6 the
`WKWebViewConfiguration` is built by `CAPBridgeViewController`; the
reliable override is a tiny app-level tweak — e.g. in
`ios/App/App/AppDelegate.swift` (or a small custom config) ensure:

```swift
// On the WKWebViewConfiguration used by the bridge:
configuration.allowsPictureInPictureMediaPlayback = true
configuration.allowsInlineMediaPlayback = true
```

Verify first — this is usually unnecessary.

## Step 6 — open, sign, run

```bash
npx cap open ios
```

In Xcode:
1. Select the **App** target → **Signing & Capabilities** → set your
   **Team** and a unique bundle id (`com.<you>.concord`).
2. Add the **Background Modes** capability and check **"Audio, AirPlay,
   and Picture in Picture"** (this is the UI mirror of the plist key).
3. Choose your iPhone as the run destination → **Run**.

## Step 7 (optional) — install-from-anywhere

Product → **Archive** → distribute via **TestFlight**. Then install via
the TestFlight app on the phone — no cable, builds last 90 days.

## Verify on device

- Play a video → tap **Pop out** → it floats out and keeps playing while
  you use other apps. (This is the thing that failed in the PWA.)
- Lock screen / Control Center shows the title + working play/pause/seek.
- Play audio, switch to another app → audio keeps going (background mode).
- Works on cellular / away from home over Tailscale.
- Auto-PiP: with a video playing, swipe to another app → it should pop out
  on its own (the `autoPictureInPicture` + `visibilitychange` paths).

## Maintenance

The wrapper is a thin shell over the live server. To ship new Concord
features, just update the **web app on the PC** — the wrapper reloads it
on next launch. Only rebuild/re-archive the wrapper when you change
native config (Info.plist, capabilities, server URL).

## Known caveats

- The app needs Tailscale connectivity to function (no offline) — matches
  Concord's server-backed design.
- `NSAllowsArbitraryLoads` would block an App Store submission, but this is
  a personal/TestFlight build, so it's fine. Prefer the Tailscale-HTTPS
  path to avoid it entirely.
