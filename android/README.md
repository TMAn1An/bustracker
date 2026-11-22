# IUBAT Bus: Android app

A small native Android app (Kotlin, about 400 KB) that:

- shows the bus tracker website in a WebView, so every feature and fix on the website is in the app at once, with no app update needed;
- **shares the bus location with the screen off.** A web page cannot do this. The app uses a foreground service with a "Sharing Bus 11" notification and Google Play services' fused location (free, no API key needed);
- sends every fix to the same `/api/share` endpoint as the website. The server runs the same checks (on the route, moving like a bus, 3 riders per bus, trip times) and gives the same XP.

In a traffic jam the phone keeps sending fresh fixes with the GPS speed, which is about 0 when standing still. The app also reports speed 0 if the bus moved less than 5 m since the last send. The website then shows "Stopped", or "🚦 In traffic · N min" when the bus stands still away from any stop for over a minute.

The website notices the app through `window.AndroidBridge`. See `js/share.js` (`Share.native`, `Share._native`).

## Build

Requirements: JDK 17 or newer, the Android SDK (platform 36). Android Studio has both.

```bash
cd android
./gradlew assembleDebug        # test APK: app/build/outputs/apk/debug/app-debug.apk
./gradlew bundleRelease        # Play Store bundle: app/build/outputs/bundle/release/app-release.aab
```

GitHub Actions (`.github/workflows/android.yml`) builds both on every change to `android/`. Download them from the run's **Artifacts**.

To use the app for another site (a fork), change `siteUrl` in `gradle.properties`, the link host in `app/src/main/AndroidManifest.xml`,
and `applicationId` in `app/build.gradle.kts`.

## Publish on Google Play (step by step)

1. **Developer account:** https://play.google.com/console, one-time USD 25. A new *personal* account must first run a
   **closed test with at least 12 testers for 14 days** before it can publish to everyone. Friends on the bus are perfect testers.
2. **Upload key** (once, keep the file and passwords safe forever):
   ```bash
   keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
   ```
   Then either create `android/keystore.properties` (never commit it):
   ```
   storeFile=/full/path/upload.jks
   storePassword=…
   keyAlias=upload
   keyPassword=…
   ```
   or add these GitHub secrets so Actions builds a signed bundle: `ANDROID_KEYSTORE_BASE64` (output of `base64 -w0 upload.jks`),
   `ANDROID_STOREPASSWORD`, `ANDROID_KEYALIAS`, `ANDROID_KEYPASSWORD`.
3. **Create the app** in Play Console: name "IUBAT Bus", free, app. Keep **Play App Signing** on.
   The package name `io.github.tman1an.bustracker` is **permanent** after the first upload.
4. **Store listing:** short and full description, 512×512 icon (`assets/icons/icon-512.png`), a 1024×500 feature graphic, and phone screenshots (`docs/screenshots/`).
5. **App content** (Policy section):
   - Privacy policy: `https://bustracker.iubat.workers.dev/privacy.html`
   - Ads: no. Target audience: 18+ (university students).
   - **Data safety:** collects *precise location* and *approximate location* (app functionality, only while the user shares, not shared with third parties,
     encrypted in transit, can be stopped any time) and *user IDs* (the chosen username). No data is sold, no analytics.
   - **Foreground service permissions:** declare `FOREGROUND_SERVICE_LOCATION`. Use case: the user starts sharing the bus location for other riders,
     and it must continue with the screen off. Add a short screen recording: tap Share location → notification appears → lock the phone → bus moves on another phone → Stop.
   - The app does **not** request background location (`ACCESS_BACKGROUND_LOCATION`), so the stricter background-location review does not apply.
6. **Brand:** the app uses the IUBAT name and logo. Google can reject apps that look official without permission ("impersonation").
   Get written permission from the university or transport office, or say "unofficial, made by students" in the listing.
7. Upload `app-release.aab` to **Testing → Closed testing**, add testers, then promote to **Production** after the 14 days.

For each new version, raise `versionCode` (and `versionName`) in `app/build.gradle.kts`. Website changes need no app update.

## Not in the app yet

- **Push reminders:** the WebView cannot receive Web Push. The app shows the in-app reminder while it is open.
  A later version can add native notifications (Firebase Cloud Messaging, free).
