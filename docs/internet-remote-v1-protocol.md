# Internet Remote v1 protocol boundary

Status: Rust protocol core plus transient peer sessions and sanitized AppState
projection. There is no Internet listener, Worker binding, WebRTC transport,
or UI entry in Bilikara yet. The existing Local Remote HTTP/SSE behavior is
unchanged.

## Boundary

Internet Remote messages must enter a dedicated Rust decoder. They must never
be translated into an HTTP method/path or forwarded to the Python route table.
After transport authentication, the intended path is:

```text
WebRTC DataChannel bytes
  -> bounded frame assembly
  -> decode_remote_request_v1
  -> per-device capability check
  -> typed Rust dispatcher
  -> authoritative rust-runtime AppState
```

The initial decoder lives in `rust/src/internet_remote_protocol.rs`. It is pure
and deterministic: callers supply the expected lane, current connection epoch,
last accepted sequence, and approved profile.

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

## Remaining merge gates

1. Request-result deduplication, revocation generation, and bounded in-flight
   RPCs around the existing Rust-owned peer epoch/sequence state.
2. Typed Host-effect dispatch after runtime validation.
3. DataChannel framing/backpressure and authenticated connection adapter.
4. Standalone signaling Worker hardening and room-password authentication.
5. Host/Remote UI integration, abuse tests, and security review.

No later slice may expose the current LAN server or reuse its HTTP routes as
the Internet capability model.
