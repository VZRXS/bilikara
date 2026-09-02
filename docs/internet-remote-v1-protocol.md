# Internet Remote v1 protocol boundary

Status: implemented as an opt-in preview. The Host toolbar keeps Local Remote
as the default and exposes a separate Local / Internet switch. Internet mode
creates an eight-hour signaling room and a shared QR code; every Remote scans
the same QR code and enters the Host-displayed room password. The existing
Local Remote HTTP/SSE behavior is unchanged and remains available.

## Boundary

Internet Remote messages must enter a dedicated Rust decoder. They must never
be translated into an HTTP method/path or forwarded to the Python route table.
After transport authentication, the intended path is:

```text
WebRTC DataChannel bytes
  -> Host browser transport (password gate, rate limits, bounded queue)
  -> bounded frame assembly
  -> decode_remote_request_v1
  -> per-device capability check
  -> typed Rust dispatcher
  -> authoritative rust-runtime AppState
```

The initial decoder lives in `rust/src/internet_remote_protocol.rs`. It is pure
and deterministic: callers supply the expected lane, current connection epoch,
last accepted sequence, and approved profile.

The only Python entrypoints are loopback-only adapters under
`/api/internet-remote/*`. They cannot be reached by another LAN client and are
never exposed through the signaling Worker. Python performs the retained Host
I/O after Rust admits a typed request; it does not own peer, replay, capability,
or AppState policy.

## Envelope

Requests use a fixed top-level envelope:

```json
{
  "v": 1,
  "lane": "control",
  "epoch": "base64url-128-bit",
  "seq": 1,
  "id": "uuid-v4",
  "kind": "catalog.search",
  "body": { "query": "example", "limit": 20 }
}
```

Validation occurs before dispatch:

1. 16 KiB control-message limit.
2. Exact top-level schema and protocol version.
3. Expected lane and current connection epoch.
4. Positive, JSON-safe, strictly increasing sequence.
5. UUIDv4 request ID.
6. Closed request-kind table and exact body schema.
7. Field-specific size/range limits.
8. Capability profile.

Epoch ownership and lane-specific last-sequence mutation live in the
process-wide Rust AppState. Opening a new epoch resets that peer's replay
window, and AppState initialization/shutdown clears all transient Internet
Remote peers. The decoder remains pure and does not create a second mutable
authority.

## Capabilities

`viewer` allows only connection health, sanitized state reads, catalog search,
and song detail. `controller` additionally allows the bounded playlist,
playback, player-setting, session-identity, rating, and referenced-item cache
operations explicitly enumerated in the Rust module.

The controller allowlist is intentionally explicit. Adding a new capability
does not grant it automatically. Maintenance operations such as application
updates, diagnostics, Gatcha refresh, downloader configuration, arbitrary URL
fetch/open, and raw HTTP requests are not protocol kinds.

Playlist additions refer to a canonical BVID with an optional positive page
suffix such as `BV1ab411c7mD_p2`, not a URL or an unchecked Bilibili request
object. Other mutations carry an expected AppState revision. The runtime
consumes their sequence but returns `accepted: false` plus a fresh sanitized
state when the revision is stale.

## Remote state

`RemoteStateV1` is a dedicated DTO rather than a serialized `AppSnapshot`. Its
item shape contains display metadata, public cache projection, audio-variant
labels, and Bilibili cover URL only. It has no local paths, resolved media URLs,
cookies, diagnostics, update state, Gatcha maintenance state, or tool settings.

`rust-runtime/src/internet_remote.rs` constructs this DTO directly from one
authoritative `AppSnapshot`. It also admits only HTTPS Bilibili CDN covers;
Python must not independently recompute the projection.

## Transport and room security

`internet-remote-worker/` is a standalone signaling Worker. One opaque room is
one SQLite-backed Durable Object with one Host and at most ten Remote signaling
sockets. It stores only SHA-256 token hashes plus Worker-generated creation and
expiry times. It has no Bilikara D1 binding and never receives search, queue,
playback, media, or room-password data. WebSockets use the Hibernation API, and
Worker Rate Limit bindings cover room creation and per-room socket admission.

The Host and shared join bearer tokens are carried in the WebSocket subprotocol,
not in a URL query. The Remote URL keeps its room ID and join token in the URL
fragment, which is not sent as part of HTTP requests. The human password is sent
only after WebRTC DTLS is established. It is neither uploaded to the Worker nor
stored by the Remote page. The Host allows five failed attempts per peer and 20
per minute across the room. Unauthenticated or incomplete peers are evicted
after 20 seconds.

This is an online password gate, not a PAKE. A leaked QR link alone does not
authorize Bilikara commands, but it can consume signaling attempts; the Host can
invalidate it immediately by rebuilding the room. A public room directory is
intentionally excluded until a PAKE or equivalent low-entropy password protocol
is available.

After both ordered reliable DataChannels open, signaling detaches on the Remote
while the Host signaling socket stays hibernatable so additional Remotes and
network recovery can join. Control and bulk traffic use separate channels.
Search and state payloads use bulk; playback controls use control. Logical
messages are capped at 512 KiB and split into 12 KiB frames. The Host serializes
outbound frames per lane, coalesces superseded state updates, and waits for the
DataChannel buffer to drain. Each peer also has bounded pending work and
per-minute message/request/search/add admission limits before an external Host
request can occur.

Cover images are restricted to HTTPS Bilibili CDN URLs and rendered with
`referrerpolicy="no-referrer"`. Authentication relies on WebRTC's encrypted
channel and does not parse browser-specific certificate fingerprints, avoiding
Safari-specific SDP fingerprint extraction.

## Recovery

The Remote keeps a random endpoint ID and its non-secret display name in browser
storage. Passwords are never persisted. On a connectivity transition it opens
a new signaling socket,
replaces the previous peer connection, creates a new epoch, authenticates again,
and resends its session identity. Rust resets that peer's replay window when the
new epoch opens. Old connection callbacks are identity-checked so they cannot
close or mutate the replacement peer.

Room creation and expiry come from Worker time. The Host schedules the returned
TTL as a duration and treats the Durable Object's expiry close code as
authoritative, so a badly skewed Host wall clock cannot create an already-expired
room or extend its lifetime.

## Deployment boundary

The Worker is deliberately not part of the main static/Tauri deployment. Deploy
`internet-remote-worker/` separately and attach `rtc.kevinx96.icu`; the Host
adapter treats that exact HTTPS origin as its signaling service and as the only
QR URL accepted by the loopback QR generator. Deploying the main
`bilikara-tauri` static project must never overwrite this Worker.

No later slice may expose the current LAN server, add arbitrary URL/HTTP proxy
operations, or reuse the LAN route table as the Internet capability model.
