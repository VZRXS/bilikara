# Shared component ownership

Shared owners preserve the approved appearance, stylesheet order, DOM and
runtime actions. Keep client-specific stacking and layout variants explicit.

| Contract | Owner | Explicit variants |
| --- | --- | --- |
| Toast base and error appearance | `static/ui-surfaces.css` | Host/Remote sheets select their existing stacking-layer tokens only. |
| Toast viewport width | `static/ui-surfaces.css` | Existing 75vw cap and natural short-message width. |
| Toast phone/dock clearance | `static/host-layout.css` | Existing responsive layout override; no component material override. |
| Global `--font-sans` / `--font-display` | `static/ui-surfaces.css` | Existing effective system stack; shadowed client declarations removed. |
| Portrait My/Settings and Queue/History scrollports | `static/host-layout.css` | Full-width owners with internal 14px side/trailing insets end at or above the dock top; only background remains behind it. Queue's whole-list fallback uses the same boundary. A hidden/absent current song leaves a single pending track with no inter-track gap; a visible current retains its natural-height row. Playback and its stage-control tray retain their existing behind-dock layout/trailing rules. `static/host-layout.js` retains page clipping, resident controls, visibility/inert state and My's scroll offset. |
| Phone My/Settings groups | `static/host-layout.css` | Settings sections own the surface around heading and controls: 14px padding/corners and 12px between groups. Desktop keeps its separate heading/card treatment. Collapsed account status uses a 44px minimum with unchanged fonts and room to wrap; expanded QR content keeps 14px padding. The existing legacy relation adapter tracks QR collapse for Chromium 83. |
| Request result viewport scroll inset | `static/result-pagination.js`, `static/styles.css` | The existing coalesced ResizeObserver measures bounded vertical overflow at the uninset content width; overflowing viewports add 4px at the right. Narrower aspect-ratio cards may reduce final overflow, but cannot reverse that decision. Measurement restores padding before capacity fitting and paint. Remote document flow, page capacity and the shared pager/hit geometry retain their existing contract. |
| Remote Queue/History scrolling | `static/remote.css`, `static/remote-queue.js` | The document is the sole scroll owner; lists have no height cap or scrollbar inset. Existing document padding clears the playback dock. Queue dragging scrolls the document at the visible list edges above the dock; badges, menus and reorder commits keep their existing ownership. |
| Theme palettes and semantic surfaces | Existing client/shared token sheets | Host/Remote palette differences remain intentional. |

`tests/ui_toast_ownership.test.mjs`, included in `test:auxiliary`, parses actual
CSS with the existing Lightning CSS dependency. It rejects duplicate toast base
or error owners, component `!important`, and duplicated global font tokens.
This is a scoped AST gate, not a claim that every design guideline is linted.

When changing owners, compare computed appearance and bounds before/after in
Chromium and WebKit, Host/Remote, Light/Dark/Blue, phone/desktop widths and
ordinary/error messages. Run-specific JSON and screenshots remain outside git.
The existing real-Host toast interaction tests also cover ZH/EN/JA, natural
width, wrapping and viewport reachability. Regenerate Chromium-83 output
through the existing `prepare:webview83` pipeline.

Native UIKit appearance and physical target measurements require separate
device acceptance.
