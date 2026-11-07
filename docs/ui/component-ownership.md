# Shared component ownership

Shared owners preserve the approved appearance, stylesheet order, DOM and
runtime actions. Keep client-specific stacking and layout variants explicit.

| Contract | Owner | Explicit variants |
| --- | --- | --- |
| Toast base and error appearance | `static/ui-surfaces.css` | Host/Remote sheets select their existing stacking-layer tokens only. |
| Toast viewport width | `static/ui-surfaces.css` | Existing 75vw cap and natural short-message width. |
| Toast phone/dock clearance | `static/host-layout.css` | Existing responsive layout override; no component material override. |
| Global `--font-sans` / `--font-display` | `static/ui-surfaces.css` | Existing effective system stack; shadowed client declarations removed. |
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
