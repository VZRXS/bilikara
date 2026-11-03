# Generated WebView 83 CSS

These files are compiler output from the styles linked by `index.html` and
`controller.html`, not separately maintained screens. Only an explicitly chosen
legacy document with Chromium 83–90 loads them through `webview83.js`. Latest
and legacy 91 retain their original styles and native APIs.

After editing shared CSS, run `npm run prepare:webview83` and commit the changed
outputs. `node scripts/build_webview83.mjs --check` and `test:android-webview`
reject stale artifacts. The fixed compiler versions live in package-lock.json;
no compiler runs in the app, Rust build or release package.

The same command compiles the pinned Signalsmith JavaScript wrapper to
`vendor/signalsmith-stretch/SignalsmithStretch83.js`. The original wrapper,
upstream revision, license and embedded DSP/WASM bytes remain unchanged.
Runtime adapters cover flex spacing, aspect ratio and simplified CSS motion;
CSS compilation alone does not supply these browser features.
