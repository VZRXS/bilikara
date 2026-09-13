# Internet Remote v1 protocol boundary

> Catalog follow-up: the verified public `gid=0` source is now implemented as
> a shared Rust, read-only GViz CSV search fallback. Snapshot expiry and local
> removal exclusions are enforced; external deletion/blacklist synchronization
> remains unverified. See [the catalog report](catalog-rust-local-migration.md).

Status: implemented as an opt-in preview. The Host toolbar keeps Local Remote
as the default and exposes a separate Local / Internet switch. Internet mode
creates a signaling room lasting one to twenty-four hours (twelve hours by
default) and a shared QR code; every Remote scans the same QR code and enters
the Host-displayed room password. The existing Local Remote HTTP/SSE behavior
is unchanged and remains available.

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

`viewer` allows only connection health, sanitized state reads, catalog search
and browse, local Gatcha browse, pool-config reads, random candidates, and song
detail. `controller` additionally allows the bounded playlist, playback,
player-setting, session-identity, rating, referenced-item cache, and Gatcha
management operations explicitly enumerated in the Rust module.

The controller allowlist is intentionally explicit. Adding a new capability
does not grant it automatically. Gatcha management uses dedicated typed
messages and retained Host I/O; it is not access to the Python route table.
Maintenance operations such as application updates, diagnostics, downloader
configuration, arbitrary URL fetch/open, and raw HTTP requests are not
protocol kinds.

Playlist additions refer to a canonical BVID with an optional positive page
suffix such as `BV1ab411c7mD_p2`, not a URL or an unchecked Bilibili request
object. An addition is safely rebased onto the latest authoritative playlist
after its Host-side metadata fetch; duplicate and session checks run against
that latest state. Destructive and ordering mutations carry an expected
AppState revision. The runtime consumes their sequence but returns
`accepted: false` plus a fresh sanitized state when the revision is stale.
Playback commands additionally carry the item ID and playback generation that
were visible when the user acted. Audio-variant changes and cache retries carry
the item's opaque incarnation ID. Rust compares those click-time identities to
the same authoritative snapshot used for dispatch and rejects a mismatch before
emitting any Host effect, so an ordered but delayed command cannot be rebound to
a newer song or to a re-created item that happens to reuse the same public ID.
Relative seeks carry a bounded non-zero delta. Absolute seeks carry a bounded
non-negative integral target in seconds and share the same click-time playback
target checks; the Host remains responsible for clamping that target to the
active media duration.

Player delivery uses the shared Rust AppState FIFO extracted from PR109's
native session, with its existing capacity of 16. Desktop HTTP/Runtime FFI and
native Host use the same queue implementation. Generation and item are checked
again when a delayed Host effect is enqueued; a stale effect fails explicitly
with `stale_command` (409), and a full queue returns `player_busy` (429).
A successful dispatch reply is sent only after that Host effect succeeds.
Playback-generation changes clear the old queue. Initialization clears pending
commands but preserves the process-lifetime sequence, preventing late ACKs from
naming replacement commands. Internet room teardown leaves LAN delivery usable.

Only the local Host can acknowledge player delivery (native Host retains its
Host-token check). ACK removes exactly the matching head, never a future
high-water mark. Repeated state snapshots retry a failed ACK without replaying
the playback action, with one ACK request per sequence in flight. Delivery ACK
means the Host consumed the command; it is not a seek-settled or playback-success
receipt. Media/session ownership and generation checks still govern application.

AV-delay actions use `player.av_delay_action` with the same closed action body
as the LAN control: `adjust` with an integer `delta_ms`, `set_effective` with
`effective_delay_ms`, `reset_local`, or `toggle_lock`. The dispatcher applies the
action under the AppState lock using the existing AV-delay policy. A Remote
must not calculate an absolute setting from its potentially stale snapshot.
The existing `player.set_av_delay` request remains an absolute setting for older
clients; its last-writer behavior differs from additive adjustments. Both
operations require the existing player-settings capability. Unknown actions or
extra fields are rejected, and an unavailable action is not retried as an
absolute mutation.

An initial `playlist.add` leaves `selected_video_page` absent and
`selected_audio_pages` empty so the Host can apply the normal automatic binding
policy. If manual binding is required, the Host returns a bounded, sanitized
page list; the follow-up request must carry one positive video page and at least
one unique positive audio page. Rust retains and validates that selection across
the Host I/O completion boundary. A failed fetch or binding attempt explicitly
cancels its pending Rust reservation, so repeated application errors cannot
exhaust the per-peer pending-request capacity.

## Remote state

`RemoteStateV1` is a dedicated DTO rather than a serialized `AppSnapshot`. Its
item shape contains display metadata, public cache projection, audio-variant
labels, Bilibili cover URL, and an opaque item-incarnation token used only for
optimistic concurrency. The token is not a credential and grants no capability.
The DTO has no local paths, resolved media URLs, cookies, diagnostics, update
state, or tool settings. The Host adapter adds only the bounded public projection
of the existing Rust Gatcha task status and pool configuration needed by the
shared Remote UI; task results and local records are not forwarded.

`rust-runtime/src/internet_remote.rs` constructs this DTO directly from one
authoritative `AppSnapshot`. Bilibili CDN covers in `http://` or protocol-relative
form are normalized to HTTPS, while credentials, nonstandard ports, fragments,
and non-Bilibili hosts are rejected. Python applies the same rule to retained
catalog/Gatcha I/O results and does not independently recompute AppState.

## Transport and room security

`internet-remote-worker/` is a standalone signaling Worker. One opaque room is
one SQLite-backed Durable Object with one Host and at most ten Remote signaling
sockets. It stores only SHA-256 token hashes plus Worker-generated creation and
expiry times. It has no Bilikara D1 binding and never receives search, queue,
playback, media, or room-password data. WebSockets use the Hibernation API, and
Worker Rate Limit bindings cover room creation and per-room socket admission.
Current Hosts request an integer lifetime from one through twenty-four hours;
omitting the field preserves the legacy eight-hour lifetime for already-released
Hosts.

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
request can occur. Bilibili-backed Gatcha operations have a separate room-wide
ten-minute budget, while control and bulk messages retain independent ordered
queues so a long browse operation cannot block playback heartbeats.

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
room or extend its lifetime. If the Host has not connected yet or its signaling
socket disappears, the Durable Object preserves the room for at most fifteen
minutes for reconnection. One alarm tracks the earlier of that reconnect
deadline and the selected room expiry; reconnecting clears the grace deadline,
while reaching either deadline without a Host releases the room and its capacity
slot. A connected Host is never expired solely by a stale reconnect deadline.

## Deployment boundary

The Worker is deliberately not part of the main static/Tauri deployment. Deploy
`internet-remote-worker/` separately and attach `rtc.kevinx96.icu`; the Host
adapter treats that exact HTTPS origin as its signaling service and as the only
QR URL accepted by the loopback QR generator. Deploying the main
`bilikara-tauri` static project must never overwrite this Worker.

No later slice may expose the current LAN server, add arbitrary URL/HTTP proxy
operations, or reuse the LAN route table as the Internet capability model.

Catalog queries now use the shared Rust catalog service through Python FFI or
the native Host adapter. Both transports retain their existing public field
projection and permissions. D1 emptiness is success, service/auth failures remain
distinct, and no mutation uses a fallback. `/api/catalog/search` is the in-repo
HTTP path; `/api/lark/search` remains an alias and `table` selection is retired
with 410. Eligible search outages use the verified public Sheets snapshot;
external exclusion synchronization remains unverified. See the
[catalog migration status](catalog-rust-local-migration.md).
