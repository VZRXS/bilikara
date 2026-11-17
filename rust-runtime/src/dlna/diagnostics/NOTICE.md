# DLNA diagnostic trace provenance

Stage priority, monotonic durations, connection retention (six) and output
retention (current/previous) are adapted from bilikara-next, MIT, commit
`7750dca707286e74616a7e08ed5df506b9809b6f`,
`rust-runtime/src/native_host/purek/trace.rs`, including historical `0870f2b`.
Copyright (c) 2026 bilikara contributors. The complete MIT notice is retained
in the repository's `LICENSE`; see also `THIRD_PARTY_NOTICES.md`.

The collector, HMAC privacy boundary, report schema and T2/T4/T9 adapters are
implemented here for bilikara. This does not port next's AppState ownership,
raw diagnostic JSON inputs, or its Stop-fault policy.
