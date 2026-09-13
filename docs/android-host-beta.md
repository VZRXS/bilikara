# Android Host Beta · first acceptance

This follows the Android Alpha work on `codex/android-host-alpha`. The launcher
name is **bilikara beta** and uses the desktop artwork. The test APK retains
`com.bilikara.app.alpha` and the existing local debug signer so it can replace
Alpha without uninstalling or erasing login/settings. It is **not** a production
signed release. The technical bootstrap names `android-alpha.html` and
`android_alpha_status` remain compatible implementation identifiers.

## Included in this acceptance round

- Compact landscape upcoming-song panel, with scrollable following songs.
- Queue move requests accept the shared Host's `index` field. Cache usage counts
  actual private media bytes (including partial downloads); cached-song counts
  come from committed, ready current/queued artifacts rather than directory names.
- Choosing **new session** atomically archives the previous session's played
  records, clears current singers/queue/session records, and retains global
  history, login and settings. Export's source selector includes every archived
  session, grouped by date, as well as current-session and all-history records.
  Archives remain in the authoritative Rust checkpoint, not a parallel store.
  There is a 1,000 archive / existing checkpoint-size safety limit; reaching it
  reports an error and preserves records, never silently deletes an old session.
- Diagnostic Markdown supplies UTC generation time, Android/API/device/ABI,
  actual package version, WebView package/version and browser facts. Python is
  explicitly not applicable. Connectivity checks target Bilibili, GitHub and the
  release mirror with bounded timeouts, not D1 scans. Existing sanitizers remain.
- Internet Remote uses the **same frontend, room lifecycle and Rust protocol**
  as desktop. The native adapter connects already-validated commands to native
  queue/player/catalog/Gacha/rating services. Peer identity, replay/generation
  guards and bounded public metadata projections remain mandatory. Room admin,
  old-session export and updater admin remain Host-only. Local and Internet QR
  images are generated locally; credentials are not sent to a QR service.
- Successfully accepted new songs enqueue the existing bounded Cloudflare
  metadata append operation, matching desktop. No new SQL or table write path,
  bulk import upload, full scan or schema migration was introduced.
- Android update checks select **Android ARM64 APKs**, not desktop archives,
  using the shared Rust release/channel policy. Download URLs are reconstructed
  from fixed GitHub/R2 origins. Release metadata must include a SHA-256 digest
  and bounded size. Android independently checks downloaded size/hash, package
  ID, increasing versionCode, non-debug build and exact signer before offering
  the **system installer**; installing is never silent. Unknown-source permission
  is requested through Android settings and requires another explicit attempt.
  Test builds can check versions but cannot install formal signed APKs.

Room lifetimes follow the shared 1–24-hour UI (default 12) and the expiration
returned by the deployed signaling Worker. This work does not deploy a Worker.
The earlier [catalog pagination patch](worker-patches/20260912-browse-pagination.patch)
still needs applying if the online catalog Worker has not yet been updated.

## Deferred by the user

Independent dual-screen output, general external-link integration, developer
mode and diagnostic ZIP packages. Continue using the existing system WiFi/HDMI
mirror. Neither real hardware display latency nor long-session reliability is
claimed by desktop browser or emulator tests.

## APK workflow and signing

`CI And Bundles` now builds an Android ARM64 APK after its existing test jobs.
PR/manual builds produce clearly named **debug test artifacts**; they do not
upload APKs to a Release or R2. Tags require all four Android signing secrets,
with no fallback to publishing a debug package:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded release keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Signing entry alias |
| `ANDROID_KEY_PASSWORD` | Signing entry password |

The user has not provided a release key; **formal signing/key backup remains a
separate decision**. Until configured, the tag Android job fails explicitly and
the combined R2 mirror waits rather than advertising an incomplete bundle.
No new Cloudflare secret is required: R2 continues using `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET`.

Signed tag assets are `bilikara-vX.Y.Z[-preview.N]-android-arm64.apk`. The mirror
waits for desktop and Android jobs, uploads all assets, and publishes the release
list plus per-tag/stable metadata. Metadata retains GitHub's SHA-256 digest.
Android's versionCode mapping preserves preview-to-stable upgrades; downgrading
to an older stable base is rejected by Android even if desktop offers that
channel switch. Debug and release package IDs/signers differ: do not uninstall a
test installation expecting its local data to transfer into a new release app.

## First acceptance checklist

1. Install the test APK over Alpha, without uninstalling. Confirm icon/name and
   that login/settings survive. Continue an existing session once, then restart
   and choose new; export both the old session and the new empty/current session.
2. Queue several songs; move to top/bottom and verify ordering. Download, retry,
   clear and change cache size; compare ready counts and storage usage after the
   two-second metadata refresh. Partial downloads correctly occupy space.
3. In landscape, verify countdown, current title and following-song list are
   reachable. Portrait pages, background pause/foreground resume remain intact.
4. Create a public room, scan from a separate network/device, register a singer,
   browse/search, add a real intended song, seek, switch tracks and reconnect.
   Close the room. Validate expiration against the deployed Worker's response.
5. Copy diagnostic Markdown: generation time, Android/device/build/WebView and
   connectivity results should be populated; failed networks report failure,
   not blank success. Do not share an unsanitized native checkpoint.
6. Check app updates. The test build must never offer to overwrite itself with a
   differently signed formal APK. Release installation and R2 publication need
   a future signed tag and remain unverified until that run exists.

Implementation and acceptance here make no production D1 queries or fabricated
song/rating submissions. Hardware and real release-pipeline results must be
recorded separately from local regression results.
