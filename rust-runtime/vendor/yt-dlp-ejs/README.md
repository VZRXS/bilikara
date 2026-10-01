# YouTube signature solver

Pinned upstream: [yt-dlp/ejs 0.8.0](https://github.com/yt-dlp/ejs/releases/tag/0.8.0).
Only these two release assets are embedded using `include_str!`; the yt-dlp
executable and its Python dependencies are not used.

| Upstream release asset | SHA-256 |
| --- | --- |
| yt.solver.lib.min.js | c55987fe697e5b9ee18830163f7af85327e9bb5c3e674b969d38c8d205eaa577 |
| yt.solver.core.min.js | 18da6ce0758b416e7ae645084f4f8801f9f9d59d6c477c05eaa0ff94ebd8cc00 |

Local copies differ only by an added final LF. Normalize checkout CRLF to LF
and remove exactly that final LF before checking the above upstream hashes.
`tests/youtube_quick_request.test.mjs` checks this equivalence. No solver source
logic was changed. Retain the library's complete Meriyah/astring license header.

EJS is Unlicense (`LICENSE`); bundled dependencies are ISC/MIT. Full distribution
notices, including rquickjs/QuickJS-NG, are in `static/youtube-native-LICENSES.txt`.

The runtime does not fetch EJS at startup. Update both assets together from a
verified tagged upstream release, update these hashes and the checksum test,
then run the offline solver fixture and explicit public-player signature smoke.
Never add Node/Deno/system commands, account cookies, or host callbacks to the VM.
