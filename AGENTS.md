# AGENTS.md - Bilikara Agent Development Guide

This document provides operational guidance, architectural rules, and validation standards for automated coding agents working on the Bilikara codebase.

## 1. Scope and Precedence

- **Repository-Wide Default**: This root `AGENTS.md` applies across the entire repository.
- **Nested Instructions**: Before modifying files in a sub-directory, agents must search for any nested `AGENTS.md` files within that subtree.
- **Precedence Rule**: The closest applicable `AGENTS.md` file takes precedence over root guidance.
- **User Instruction Precedence**: The user's explicit task instructions take precedence over general repository guidance.

## 2. Current Architecture

Bilikara is a Bilibili-based Karaoke system consisting of a Host (PC display & desktop application) and a Remote (Mobile controller).

The architecture consists of the following primary layers:

- `static/`: Frontend Host and Remote user interfaces built with vanilla JavaScript, HTML5, and CSS3. UI components use state-driven re-rendering and subscribe to real-time state updates via Server-Sent Events (SSE) at `/api/events`. Bundled and served by the Host server or packaged into the Tauri desktop shell.
- `bilikara/`: Retained Python source Host transport and compatibility adapter, used by development workflows and tests, not native desktop products or their build imports. Handles legacy HTTP/SSE routing (`http.server.ThreadingHTTPServer`), persistence I/O derived from Rust snapshots, trusted tool configuration, BBDown preparation and retained yt-dlp orchestration/source-mode media CLI compatibility, version checks/updates, and frozen Python compatibility references. `PlaylistStore` is an AppState/persistence adapter, not a mutable state authority.
- `rust/`: Shared typed Rust domain core crate (`bilikara_rust`). Native products link its `rlib`; the `cdylib` and C ABI remain for Python compatibility/integration tests and source workflows. Implements pure, deterministic business logic domains.
- `rust-runtime/`: Typed Rust runtime and application-services crate (`bilikara_runtime`), compiled as both `cdylib` and `rlib`. Owns the process-wide authoritative `AppState`, production native HTTP/SSE Host, Rust Native cache/runtime services and operational I/O such as the independent HTTP media downloader. Its C ABI remains for the legacy Python adapter and tests; native products link Rust directly.
- `scripts/`, `media-libav/`: Platform recipes, independent verification and retained compatibility tooling. Replaced Python desktop/libav construction references and their dedicated tests are retired; normal native desktop construction uses `xtask` and must not execute Python or import `bilikara` application modules. Shared package validation belongs in the tooling layer.
- `xtask/`: Independent Rust build and package-verification tool for adjacent desktop development preparation, ordinary release construction/assembly, libav prerequisites/cache and pinned build-time BBDown acquisition (`prepare-bbdown`). `prepare:desktop`, Tauri's development hook and `npm run build` use it; CI uses its shared backend/assembly entries around the existing Tauri build and native checks. Libav shell/MSVC recipes use its C-only cache, library probe, companion and dependency/metadata stages. It must not invoke Python or link the application Runtime. The extracted native package gate uses `verify-native-desktop` with isolated actual Host execution; remaining Python verification drivers stay separate. Retained Python business tests use only `tests/native_host_support.py` transport; foreign-platform fixtures do not qualify native Windows/macOS products.
- `src-tauri/`: Tauri 2 desktop shell providing native windowing, system tray integration, and cross-platform desktop application packaging.
- `tests/`: Node desktop construction contracts and entry checks run via `npm run test:desktop-build`, using actual xtask and compiled native fixtures with independent expectations. Remaining Python `unittest` covers media, business/legacy/FFI and frontend consumers, including native library loading (`BILIKARA_REQUIRE_RUST_LIB=1`). Construction drivers no longer require Python; native package qualification remains a separate artifact gate.

## 3. Backend Ownership After Phase 2

Phase 2 is complete. Its existing Python reference implementations may remain
frozen for compatibility and historical equivalence testing, but its rule of
creating a complete Python fallback for each Rust migration no longer applies
to new work.

For all **new backend or business functionality** from this point forward:

- Rust is the authoritative implementation.
- Do not add an equivalent Python business-rule implementation or a new
  `_py_*` mirror of a new Rust capability.
- The retained source Host may adapt objects, transport FFI payloads, validate
  native results, and perform the legacy I/O/orchestration listed in Section 4.
  That glue must not independently recompute the new policy.
- A new Rust-only capability must fail explicitly or report itself unavailable
  when Rust cannot execute it. Do not silently add a Python semantic fallback.
- New stateful backend features must extend the authoritative Rust `AppState`;
  they must not create Python-owned state or a parallel authority.
- This boundary is not a new "Phase 3." The current architectural milestone is
  **v0.8 Preview 2 stabilization after Rust Core Convergence**.

Pure deterministic policy remains a good small Rust-domain boundary when all
of the following criteria are met:

1. **Immutable Input**: It receives a complete, self-contained, immutable value model.
2. **Deterministic**: Given the same inputs, it always produces the exact same output.
3. **Pure Arithmetic / Policy**: It performs **no** network, filesystem, subprocess, environment variable, system clock, thread, mutex lock, or mutable state access.
4. **Structured Decision**: It returns a structured decision, calculation result, or candidate ranking.
5. **Canonical Policy**: It represents canonical application policy or is useful across multiple host environments.

When adding such a Rust-authoritative rule:
- **Frozen Compatibility Surface**: Leave pre-existing Python references unchanged unless the task explicitly requires modifying them; do not create a new one.
- **Output Validation**: Validate native Rust outputs before applying decisions to application state.
- **Semantic Error Handling**: Distinguish valid domain-level empty/`no_match` decisions from backend, JSON, or FFI execution failures.
- **Separation of Concerns**: Keep pure typed domain logic separate from `serde`, JSON adapters, and FFI wire exports.
- **ABI Compatibility**: Keep additive FFI exports ABI-compatible unless a deliberate FFI ABI migration is requested.

## 4. Rust AppState Authority and Retained Host/UI Responsibilities

The process-wide Rust `AppState` is the only authoritative mutable application
state. Playlist, session, current-item, player-setting, history, and playlist
item cache projections are committed under its single serialized lock. Python
may cache defensive read-only projections and persist Rust snapshots, but it
must not independently mutate or recompute this state.

Rust AppState availability and initialization are startup requirements. There
is no whole-application Python Core fallback. The default desktop launcher uses
one supervised `bilikara-desktop-host` Rust process. Native desktop bundles ship
no Python runtime, PyInstaller payload or temporary Python FFI libraries.
Windows desktop builds keep application data in `runtime/data/`, media cache in
`runtime/data/cache/`, and shell logs, window preferences and WebView storage
inside the installation's `runtime/` by default. Do not rename these user-facing
directories merely to reflect the backend implementation language. Do not scan or
automatically reopen AppData records; explicit data/import overrides remain
available for isolated tests or a deliberate import.
`BILIKARA_NATIVE_DATA_DIR` (and the earlier preview-directory alias) overrides
the native data root; it does not select a different backend. See
`docs/native-desktop.md` for layouts, builds, storage and explicit legacy import.
Packaged Windows/macOS update installation uses the shared Rust installer and
private shell lifecycle boundary. **v0.8.0-preview.2 has been released** with
this Rust desktop runtime. Current work stabilizes that baseline and scopes
remaining Python to tooling, testing, compatibility or development workflows;
it is not another desktop migration. Per-platform validation is still required
for each subsequent change.

The retained legacy Python Host has the following adapter responsibilities.
They are not dependencies of normal native desktop launch or packaging; the
native product uses the shared Rust services and native Host adapters. Keep UI
and shell responsibilities in their existing layers:

- DOM event handling, button states, modal behavior, toast notifications, and UI rendering (`static/`).
- HTTP request/response routing, SSE connection lifecycle, cookies, URL fetching, and API endpoints (`bilikara/`).
- Retained Host filesystem I/O, archive extraction, and system paths. Export font discovery/rendering and archive assembly belong to Rust Runtime.
- Retained subprocess execution and management for `yt-dlp` and existing source-mode media CLI compatibility. BBDown and DownKyi/aria2c download execution is shared Rust-owned. Python retains BBDown preparation and trusted configuration/login/status transport; aria2c preparation also belongs to Rust. Packaged FFmpeg/ffprobe executables remain retired.
- Host runtime capability detection and environment variable evaluation.
- Real-time clock acquisition and timestamping.
- Atomic state-file reads/writes, legacy-shape loading, backup/archive file handling, and persistence-error reporting. All semantic data written by Python is derived from Rust snapshots.
- Retained cache scheduling, retries, cancellation, and execution for explicit yt-dlp and its existing media CLI compatibility. Its projections are committed through Rust AppState. Native, BBDown and DownKyi admissions, execution and publication are owned by shared `rust-runtime` services.
- Tauri application lifecycle, native menus, and OS shell integrations (`src-tauri/`).

These are retained adapter and I/O responsibilities, not Python application-core
ownership. Existing operational code may be maintained for release safety, but
new stateful backend capabilities belong in Rust AppState.

P03 releases only the former `bilikara/playlist_export.py` subsystem freeze.
CSV/image interpretation, layout, font discovery/fallback/cache/prewarm, PNG and
multi-page ZIP encoding now belong to Rust. Python retains the public entry
signatures, configured asset-root transport, native output validation and HTTP
responses. The renderer and prewarm share Rust font resources; there is no
Pillow renderer or Python semantic fallback. All other frozen references and
public-interface retention decisions remain unchanged.

## 5. UI Rules

### 5.1 Behavior baseline and shared ownership

- Use the released **v0.8.0-preview.2 native desktop Host**, plus subsequently approved changes, as the current desktop behavior baseline. Preserve all approved Preview 1 behavior and later changes; Android previews do not redefine desktop behavior.
- Reuse shared components, actions, tokens and layout definitions across Host, local Remote and public Remote. Keep platform adaptations narrow; do not copy whole screens.
- Treat viewport size, input method and platform capabilities separately. Narrow desktop windows retain desktop navigation, tool rail, playback controls and mouse/keyboard operations. Width alone must not select Android workflows or hide supported desktop features.
- Native player fullscreen must hide the Host toolbar, tool rail and workspace at every desktop width, release narrow-layout stacking isolation, and restore them on exit without recreating media nodes. Test the native fullscreen path separately from browser DOM fullscreen, including high-DPI-sized logical viewports.
- Windows native fullscreen must cover the monitor rather than its taskbar-excluding work area. Keep the fullscreen client area equal to the monitor bounds even when maximized, without an intermediate restore/maximize step. Preserve the original window placement for exit; serialize transitions on the native window thread, suppress system transition animations during the operation and exclude intermediate geometry from saved preferences. Validate both normal-window and maximized entry on Windows; browser layout tests do not verify the system taskbar.
- Ordinary Host/Remote controls share a 44px height. Only Android's phone layout adopts Remote's two-row delay layout (four adjustment buttons, then reset/value/lock). Touch targets must not overflow native window chrome.
- Validate desktop first, including the native 700px minimum width and mixed mouse/touch input, then Android. Adopt an Android improvement only when it preserves desktop workflows and demonstrates a benefit; record intentional behavior changes.
- Presentation changes must preserve media nodes, playback state, pitch graphs, selections, rating drafts and in-flight guards. Do not recreate/reparent media or attach duplicate handlers.

### 5.2 Asynchronous actions and rendering

For actions that start asynchronous operations or backend side effects:

1. Disable the activated button immediately and set `aria-busy="true"`.
2. Use the existing translated loading label where appropriate (for example, `t("gatcha.adding")` or `t("search.adding")`).
3. Reject duplicate activation while its Promise is pending.
4. In `finally`, restore the original disabled state and text, and remove `aria-busy`.
5. Never re-enable controls with a fixed short timer before the request completes.

Immediate UI actions (open/close, expand/collapse, tabs, fullscreen, mute and local view switches) are exempt from busy guards.

- Preserve snapshot-order validation and immediate playback/terminal-state updates. Revision/timestamp changes alone must not invalidate workspace rendering.
- Preserve unchanged-content guards, node identity, open menus and pending actions when enhancing queues or other live lists.
- Coalesce progress-only paints to once per second; do not delay terminal states or playback controls.
- Measure layout on content, size and font changes, not on timers or playback ticks. Keep observers scoped and coalesce their work.
- Localize dynamic labels in place without resetting form state or busy guards.

### 5.3 Component geometry and control roles

Choose a component by role, then reuse its shared definition. This table describes approved styles; it does not require every control to have one shape or every secondary action to acquire an outline.

| Role | Height / typography | Shape / surface |
| :--- | :--- | :--- |
| Ordinary Host/Remote controls and single-line form fields | 44px; 16px | 14px rounded rectangle |
| Dialog header text actions | 32px; 14px | Pill |
| Dialog icon close | 32px; shared SVG mark | Circle; ordinary secondary fill |
| Compact settings tools | 30px; 12px, weight 700; 12px inline padding | Pill |
| Stacked export selects, both clients | 44px; 16px | 14px corners; visible theme-aware outline |
| Request segmented navigation, both clients | 48px track, including 4px vertical space at each edge; 16px | Shared segmented surface and active fill |
| Pagination editor, both clients | 44px track; 32px input centered inside it | Input 8px corners; retain compact pagination geometry |
| Initial-letter buttons, both clients | 40px; 16px, weight 700; 6px gaps | 12px corners; lightly accented selection |
| Remote seek / next and play / pause | 44px and 48px respectively | Fixed circles on one center line |
| Floating panels | 18px/24px title; 20px content inset | 18px corners |
| Compact request entries | 72px; title 14px/16px; metadata 12px/16px | 16px corners |
| Settings group cards | Single-language 16px subheading | 14px corners and outline |
| Info bubbles | 13px, weight 400; line height 1.45; maximum width 320px | 12px corners |

- Action order follows the component role. Dialog footer groups place secondary/cancel actions before the primary completion action (left-to-right; preserve DOM and keyboard order). Export uses CSV on the left and image export on the right in both clients. Inline task forms retain their established workflow order (for example, request then queue-next); do not reverse every primary/secondary pair. Matching components share order across Host/local/public Remote. Secondary and cancel actions retain the shared neutral fill.
- Pills use a fully rounded radius (currently 999px). Circles constrain width, height and min/max-width equally so inherited button minima cannot stretch them.
- Compact tools include Check for updates and its Cancel action, Copy link, Identify display, Announcements and the Host current-song rating/next actions. Reuse the complete pill definition, not just its radius; a tool hidden by attribute stays hidden.
- Domain actions such as room create/rebuild/close are ordinary controls, not compact tools or dismiss icons: 44px height, 16px text, weight 400, 14px corners and inline padding. Use the primary palette for create/rebuild and secondary for close, with an 8px gap and aligned text centers. Create/rebuild may fill the remaining row; close keeps its content width.
- Volume and delay step/reset controls share the ordinary 16px font, theme-aware 1px outline and interaction states. Inline and floating playback controls retain the same typography and feedback; floating-panel prose does not change their inherited font. Their numeric wrappers share focus-within treatment.
- Browse back actions share secondary fill, 16px normal text, 14px corners and inline padding, a theme-aware outline and no shadow. Use the client's ordinary height for category, name, artist, UP, favorites and advanced-catalog back actions; contextual navigation remains a separate role.
- Select/input shape follows its control group: runtime selects beside pills/switches retain pills; stacked forms use rounded rectangles. Do not impose a single shape on every field.
- Radio/checkbox controls use explicit native appearance, consistent sizing and visible focus. Never inherit text-field height or padding.
- Refresh/regenerate icon actions are circular. Setting help icons sit beside their headings on both clients.

### 5.4 Interaction, focus and motion

- **Remote:** no hover-only styling or pointer-hover help, even with a mouse. Retain click/tap help, keyboard focus and pressed/busy/disabled feedback. Scope shared Host hover rules away from Remote.
- **Host ordinary controls:** preserve the component's border/lift feedback on hover-capable fine pointers. Volume, delay, initial-letter and browse-back buttons share 120ms feedback, a 1px hover lift, the shared hover surface and accent outline; pressing restores their position and uses the shared darker surface and focus-border color. Numeric wrappers retain shared focus-within treatment.
- **Top management/menu triggers, Host and Remote:** keep the normal surface and text colors when expanded, strengthen the theme-aware accent outline, and use the shared darker surface when pressed. Retain 120ms color transitions, visible keyboard focus and reduced-motion handling. Keep size, position and shadow fixed so anchored menus do not move. Host alone strengthens the outline on hover; Remote has no hover-only feedback. Full menus open by click/Enter/Space, with the Host phone QR hover preview remaining a separate annotation.
- **Host dismiss icons:** blend 12% ink into the secondary background and use the existing danger icon color. Transition colors over 120ms; never translate or scale on hover or activation. This rule does not apply to labeled domain actions such as Close room.
- **Inline search icons:** white magnifiers and search-collapse X controls have no shadow, including focus/hover. Host may lift them 2px, including the submit inside an expanded input; Remote has no hover effect. A real outline may mark focus/input state. Search-collapse controls are distinct from dialog dismiss icons.
- Retain visible keyboard focus. Keep panel entry/exit motion separate from button feedback; motion is consistent within each component role and respects reduced motion.
- Retain popup nodes, anchors and geometry until exit motion finishes, and guard rapid reopening. Opening the full phone-access menu replaces its compact hover preview immediately; closing the full menu is instantaneous and must not flash the preview. A later genuine hover may show the preview again.

### 5.5 Surfaces, themes and layering

- Floating surfaces share `static/ui-surfaces.css`: 18px corners, theme-aware translucent fill, shadow and panel-confined backdrop blur. Keep opacity in shared tokens; no per-dialog/client overrides.
- Blur only the outer floating panel, never its header, groups or controls. The collapsed Remote playback dock also blurs once, preserving its fill/progress tint. Removing nested blur must preserve theme colors and opacity.
- Verify visible blur, not only computed CSS; distinguish screenshot-renderer limitations from real-device behavior.
- Host dialogs do not dim or blur the surrounding page or source card.
- Remote large modals (entry gates, details, ratings, selection/export and playback sheet) use a theme-aware page-wide dimmed backdrop with opacity entry/exit, without page blur. Small anchored menus, help and volume editors use shadow without a second backdrop.
- Remote modals and playback sheet lock background scrolling, including anchoring caused by background updates; the top menu is exempt. Prevent clicks reaching content behind open modals, preserve focus and Escape/close behavior, and retain non-dismissible entry gates.
- The Remote top menu sits above the playback dock and below modals, including short landscape viewports. Help bubbles and compact hover QR previews are annotations in the higher browser top layer and may coexist with menus/dialogs.
- Settings group fill is white in the light theme and slightly brighter than the enclosing surface in dark/blue themes, using the unaccented settings-group token. Language/theme segmented controls use the shared segmented background, visibly distinct from that fill.

### 5.6 Panel geometry, positioning and spacing

- The panel container owns outer padding; first/last content blocks add no redundant padding/margins. Hidden status, actions and content must not reserve layout tracks or gaps.
- Dialog titles use 18px/24px typography and at least a 32px title row. Retain 20px title/side insets; header actions align with the first-line center, not the center of a wrapped title block.
- A dismissible dialog has one close icon inside its upper-right corner. Close and neighboring header actions share the ordinary secondary background token, not a separate palette.
- Compare rendered top/right action bounds, including border and title-centering offset. The current 20px inset and -4px offset put action backgrounds 16px from both inner edges. Move adjacent actions as one group and preserve their gaps/touch areas; the rule also applies to absolute close icons.
- Host confirmations cap their border-box width at 440px and the viewport. Host export keeps its 420px exception, stacked fields and two actions on one row with compact inline padding. Verify Chinese, English and Japanese at 320px. Avoid fixed aspect ratios for translated prose.
- Host top management menus and hover QR annotations right-align to their trigger, then clamp to a 12px viewport inset. Measure border-box layout size independently of animated transforms and retain coordinates during exit motion.
- Host phone access, dual-screen and runtime-settings menus are mutually exclusive and dismiss on outside click/Escape. Phone access has no close button or reserved close-button clearance.
- Opening the dual-screen menu may refresh display discovery, but numbered identifier windows appear only after an explicit Identify display action. Keep its button disabled and busy until the native invocation finishes closing those windows; do not restore it with a separate frontend timer.
- Info bubbles choose above/below from measured space and stay inside the viewport. Their transition is 120ms opacity plus 3px slide in both directions; retain the anchor/node through exit. Break long translated clauses deliberately, never split URLs or numbers mechanically. Hidden help must not enlarge panels or cause horizontal scrolling on focus.
- Remote top-menu connection and collapsed-section rows have equal occupied height. Balance visible edge insets around text, icons and corners; do not use negative margins or overlap targets. Expanded sections retain ordinary bottom padding.
- Remote playback sheet slides up. Landscape is a complete 18px rounded card inset beyond safe areas on every side. Narrow portrait extends the background into the bottom safe area, with controls above it; retain rounded bottom corners there, or square corners when meeting a screen edge with no bottom inset.
- Desktop tool rail is 80px wide with 64px square targets and 14px corners. Labels use 12px/14px typography and their actual one/two-line height, fitting four Chinese characters per line. Center the 24px icon and label as a group with a 4px gap and a 1px upward optical bias; selected icons use accent-colored filled silhouettes with transparent cutouts, and the square target uses the shared theme-aware accent-soft fill without an additional outline. Selected fills retain the original outer stroke footprint. The selected queue retains its accent-colored outline and normal stroke weight with a slightly longer first line and shorter second line for staggered ends. History keeps the same 4:00 hands in both states; selection rotates only its outer arrow 30 degrees counterclockwise around the center. Session-user icons align each body apex with its head center in both outline and filled states. Filled silhouettes keep both heads as complete circles; only overlapping bodies use a transparent gap matching the outline width. Keep glyph visual weight balanced, theme contrast and visible keyboard focus.

### 5.7 Dividers, headings and messages

- Dividers separate visible groups/rows only. Hidden platform-specific rows must not leave a rule before the first visible row.
- Semantic title/content separators remain visible and align with the heading's actual responsive text inset. They do not depend on scroll position. Do not add scroll-edge rules to headers/footers.
- Playback-settings dividers align with the content inset, never the enclosing card edge. Remote's settings card owns 14px inline padding; sections add no second inline padding. Preserve control geometry and vertical spacing.
- Bilingual pairs describe the same feature. Chinese/Japanese use its full English title as eyebrow; English uses the corresponding Chinese title. Host/Remote and dynamic headings remain equivalent. Compact navigation labels do not supply full section headings; playback status and individual control labels are not bilingual pairs.
- Settings groups use single-language 16px subheadings.
- Browse loading, selection hints and empty results use one plain centered muted 13px/1.5 status block with 8px vertical padding and no filled card. Place it directly below relevant controls/content, at the start of the list region, never at the bottom of a tall Host panel or duplicated in a footer. Remote may naturally end below it because its panel shrinks to content.
- Preserve actionable errors through their existing error/toast owner. Empty display-list guidance uses bold accent text without a message-card background.
- If an action's busy label already expresses checking/channel changes, do not duplicate that status in a message. Retain failures and completed outcomes.

### 5.8 Request navigation, search and list layout

- Host/Remote request navigation shares `static/request-tabs.css` typography, states, spacing and colors. Wide Host can keep primary/secondary rows; portrait uses the approved compact contextual row and back action.
- Host Quick, Search, Discover and Sources share Quick's responsive panel axis throughout landscape widths. Align the first control below equally sized title/tab tracks; do not stack header bottom padding and content top padding.
- Primary searches use the shared magnifier, busy spinner and translated accessible label. Host submits use the Host control height.
- Contextual search keeps its right-hand toggle stationary: magnifier collapsed, X expanded. Keep a separate submit magnifier inside the input's right edge and support Enter. The input clear action edits the draft; close exits contextual search and restores unfiltered results when necessary. Preserve focus-on-open, guards and accessible labels across Host/local/public Remote.
- A search action beside a horizontal card strip centers on the card track, excluding padding and scrollbar from the center calculation.
- Host song-result grids (search/category/name/artist) and large category covers share `--request-song-card-min-inline-size: 200px`, including narrow overrides. Add columns before cards become oversized; scale category-cover titles to the card. Name/artist entry cards instead reuse compact UP/favorites widths, surface, typography and feedback.
- Remote queue order badges own a 44px square drag/tap target without a separate grip column. A tap opens the shared localized help bubble; movement of at least 6px begins dragging, with no long-press delay. Keep small pointer jitter as a tap, suppress post-drag help clicks, and cancel interrupted gestures without committing a reorder.
- Scroll regions reserve scrollbar space only when actually scrolling. Native scrollbar width participates in layout; never apply unconditional `scrollbar-gutter: stable`. Use the queue's conditional overflow handling as the pattern.
- Bounded name/artist, history and source lists add a 4px content gap only while scrolling. Name/artist grids retain 2px vertical paint room so first-row Host hover lift is not clipped. Remote request lists use document scrolling; bounded Remote queue/history lists use the same conditional gap. Observe content/size changes, not playback ticks.
- Ordinary song/source lists keep bottom and side insets equal. Host result totals appear only in administrator mode, with a reserved footer track and at least 16px bottom clearance.
- Search/entry pagination uses 4px above and below footer controls; do not stack list bottom padding onto it. Remote UP/favorites/category entries have up to 12 cards per page with responsive columns. Preserve the page across unrelated updates.

### 5.9 Request-card geometry and text overflow

- Request source/name/artist, category and song cards share 16px inner corners across clients; ordinary form controls use their separate 14px rule. Preserve outer panel radii and spacing. Align nested/peer corner centers along a horizontal or vertical axis when practical; exact shared centers must not make approved shapes nearly square or reduce text clearance. Edge-flush covers use card clipping; circles, pills and detached controls retain their own shapes.
- Text entries share a 72px height, 10px padding, 32px two-line title area (14px/16px, weight 700), 2px title-to-metadata gap and 16px metadata line (12px/16px).
- Avatars are 24px, inset 10px from inner bottom/right edges. The first title line uses full width; the second line and metadata reserve 32px with an avatar, keeping at least 8px clear. Do not shrink the first line to enforce concentric corners.
- Metadata stays on one line and ellipsizes when needed, preserving complete DOM text for accessibility.
- Leave vertical ink room for emoji/diacritics without changing the 16px baseline rhythm, card height or metadata position. Keep horizontal clipping.
- Text longer than two lines scrolls within the second line. Short titles stay still; offscreen/hidden-page titles pause. Measure content/size/font changes, not timers. Reduced motion uses manual horizontal scrolling.
- Song covers keep 16:9 media, 10px text insets and a 40px two-line title (14px/20px). Equal-width peers align title heights/positions. Remote category labels may wrap to two lines within the fixed 16:9 cover. Preserve source-card widths/pagination; floating-panel radius is not an inline-card rule.
- Queued sources absent from the library appear first as equal-sized dashed placeholders, showing “等待拉取” or the fetching spinner until refreshed data replaces them. Confirmation says “已加入拉取队列”, not “增量拉取”.
- Queued favorites use the confirmed folder name from the authoritative shared queue on all clients. Numeric ID is only a fallback when no title exists; browser-local memory is insufficient.

### 5.10 Playback and selection

- Single-screen fullscreen and audience playback never reveal native video controls, including on entry or pointer/focus events. Fullscreen QR/exit hover expansion requires actual pointer movement over the control and resets on exit, pointer leave, window blur and resize; touch retains explicit tap pinning.
- Remote transport fills its available column and stays next to the song summary without stretch space. Resizing between one/two columns preserves control nodes and keeps progress inside its column.
- Remote retains preview.1's 44px seek/next and 48px play/pause circles on one center line. Part/setting controls are 44px; header actions are 32px.
- Playback-sheet collapse is an unfilled icon, centered when space permits and moving left only to avoid adjacent actions.
- Rating entry remains openable without pending/submitted labels so users can revisit drafts; enforce eligibility and async submission guards inside the dialog.
- Part pills keep their existing shapes. Overflow adds an expand action; expanded lists wrap natural-width pills, never force two columns. Labels wider than a row scroll, manually under reduced motion. Preserve expand nodes across progress-only updates and popup geometry through exit.
- Song titles fit fully within two lines; longer titles use one scrolling line (manual under reduced motion). Cache progress replaces the uploader in its 20px line and restores it when ready; failure/retry affordances must not grow that line.
- Selection dialogs use “选择分 P”, “视频画面（选一个）” and “音频轨道（至少选一个）”. Verify Chinese, English and Japanese at 360px; shorten/remove parentheses only if needed, retaining the full constraint in accessible help.

### 5.11 Access sharing and audience windows

- The Host sends every audience `master-state` envelope through `publish_presentation_output_state` (main window only); a loaded audience requests replay through `request_presentation_output_state` (controller only). Publish displayed changes even while idle. BroadcastChannel/localStorage are optional fast paths, never requirements for QR, room, theme or language delivery between WebViews.
- All desktop windows share one data store. Tauri ignores a configured window's `dataDirectory`: create Windows `main` in code (`"create": false`) with the same `runtime/webview` directory set on audience/identifier windows. Share `WINDOWS_WEBVIEW_BROWSER_ARGS` (wry defaults plus `--disable-direct-composition-video-overlays`) so hardware video overlays cannot cover audience exit/QR controls.
- Identifier windows initialize theme/language via a native-CSP-compatible external script and follow Host preferences while open.
- New-request notices derive from accepted queue additions and appear on both single-screen fullscreen and audience windows. Audience notices use the native master-state relay, retain an expiry time and deduplicate replay; progress-only updates, initial loads and song transitions must not announce a new request.
- All access QR cards share one 3px white frame; do not add a second SVG frame.
- Show the applied public-room password even while an unsaved replacement is edited. Full management menus alone use bold Local/Public scan instructions; their password label stays normal and muted.
- Compact dual-entry Host/fullscreen/audience cards and all Remote share cards omit scan/network/expansion help below QR codes. Local shows the complete clickable URL including protocol with the shared underline on every surface. Public shows muted normal “Room password” and bold accent password on one 12px line. Long passwords scroll horizontally without growing/clipping the panel. Preserve help in the full menu and Host local-only preview.
- Connection counts represent connected Remote devices, merge multiple tabs and exclude Host/audience windows. Full menus use translated labels, compact cards a people icon/count. The full menu's Local count aligns with the Public disclosure chevron's right edge, without reserving a nonexistent Local chevron. Compact counts align with each column's right content edge. Fullscreen headers must not inherit management-menu close-button clearance.

### 5.12 Export, announcements and updates

- Stacked export selects have a visible shared theme-aware outline on both clients. Use one column at narrow widths; two only when translated labels/values fit. Export footer actions stay on one row at 320px; Remote uses equal columns, an 8px gap and 6px inline button padding. If the field already identifies image pagination, use compact options such as `200 per page` / `1ページ 200 曲`.
- Announcements sit immediately before the update action in its action group, using the 30px light/accent-text tool pill (recache palette), including narrow wrapping.
- Update confirmation uses the shared 18px title, 13px body and 12px gap. Include a translated manual-download fallback with an actual GitHub Releases link opened through the Host external-browser boundary.
- Announcement windows separate the 18px window title from the article with an inset rule and 12px on either side. Article title is 16px; secondary type/date/version/deadline metadata is 12px, with 6px title-to-metadata and 12px before body. Do not stack body margins onto these gaps.
- Retain supplied deadlines independently of body text. Publication dates omit seconds; deadlines include minutes/timezone. Refresh/cache status follows article content in small accent text; empty status reserves no space. Keep multi-entry separation inside content, without extra padding after the last entry.

## 6. Change Discipline

- **Context Inspection**: Inspect the latest branch HEAD and `git status` before editing files.
- **Minimal Changes**: Make the smallest coherent change necessary to accomplish the user request.
- **Domain Boundaries**: Do not begin work on an unrelated business domain or migration area.
- **Behavior Preservation**: Preserve existing fallback behaviors and user-visible functionality unless explicitly directed to alter them.
- **Test Quality**: Never weaken, disable, or delete assertions to force a passing build.
- **Python Retirement**: Identify repository, CI, release-script and test consumers before removing legacy code. Keep useful source entry points, frozen references and compatibility coverage. Native build tooling must run without importing the Python application package; keep package layout, provenance/metadata validation and artifact verification unchanged.
- **Explicit UTF-8 for Repository Text**: Python code and tests reading repository JavaScript (especially files containing Chinese text), HTML, CSS, JSON, Markdown, or other UTF-8 source/assets must explicitly pass `encoding="utf-8"` to `Path.read_text()`, `Path.write_text()`, and text-mode `open()`. Text subprocess pipes carrying this content, including Node.js test harnesses, must also specify `encoding="utf-8"` in `subprocess.run()` / `Popen()`; `text=True` alone is insufficient. Never rely on the OS locale, Linux defaults, `PYTHONUTF8`, or a CI environment switch to make these operations portable: Windows may default to CP1252/GBK. Apply this rule to new and modified scripts/tests; do not fix decode failures by ignoring/replacing invalid bytes or weakening assertions.
- **Reviewability**: Each business-rule domain change should remain independently reviewable and revertible.
- **Git Hygiene**: Do not create unexpected branches, worktrees, tags, release builds, or remote pushes unless requested. Never rewrite published history without an explicit request and backup.

## 7. Validation Standards

Run targeted checks during feature development, and execute the full release-quality gate before completing cross-layer work or release preparation.

### Full Release Validation Gate

```bash
# 1. Rust Domain Checks
cd rust
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
cargo build --release --locked
cd ..

# 1b. Rust Runtime Infrastructure Checks
cd rust-runtime
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
cargo build --release --locked
cd ..

# 1c. Desktop Construction Contracts (Node 24, pinned host-native xtask)
npm run test:desktop-build

# 2. Python Test Suite (forcing native library verification)
BILIKARA_REQUIRE_RUST_LIB=1 \
python -m unittest discover -s tests -v

# 3. Python Compilation Checks
python -m compileall -q bilikara
python -m py_compile start_bilikara.py

# 4. Tauri Shell Checks
cd src-tauri
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
cargo build --release --locked
cd ..

# 5. Frontend & Asset Build
npm ci
npm run build

# 6. Formatting & Diff Check
git diff --check
```

*Development Guidance*: Narrow unit tests (e.g. `cargo test` in `rust/` or targeted `unittest` files) may be used for rapid feedback during development. However, full release validation must pass cleanly before finalizing tasks.

## 8. Final-Report Requirements

When completing a task, agents must report:

1. **Files Changed**: Complete list of modified, added, or removed files.
2. **Architectural Classification**: Classification of any newly added or modified Python/Rust logic.
3. **Validation Commands Run**: Exact commands executed and their pass/fail status.
4. **Skipped / Unavailable Validation**: Any checks that were skipped along with exact technical reasons.
5. **Commit Details**: Commit SHA and message if a git commit was created.
6. **Push Status**: Confirmation of whether any remote push occurred (must be "No" unless requested).

## 9. Directory and Module Map

### Retained Python Source Host and Compatibility Layer (`bilikara/`)

This layer supports source development and compatibility/equivalence tests. It
is not shipped or imported by the native desktop build. `ffmpeg_vendor.py`
retains its legacy import surface by forwarding to `scripts/libav_manifest.py`;
legacy diagnostics use that tooling verifier; native construction validates the
same manifest contract in xtask.

| File | Purpose |
| :--- | :--- |
| `server.py` | HTTP Server, API endpoints, SSE event hub (`AppContext`). |
| `store.py` | `PlaylistStore` AppState/FFI adapter, defensive read-only projection, and atomic JSON persistence derived from Rust snapshots. |
| `bilibili.py` | Bilibili API querying, metadata parsing, media-page selection wrapper; DASH is a thin adapter to the Rust Bilibili service for DownKyi too. Shared Gatcha/maintenance WBI helpers remain. |
| `cache.py` | Rust CacheRuntime configuration/state projection plus BBDown preparation/login adapters, retained yt-dlp orchestration and existing source-mode media CLI compatibility. |
| `rust_backend.py` | Native FFI loader, JSON payload validation, frozen compatibility fallbacks for older domains, and fail-closed adapters for new Rust-authoritative capabilities. |
| `updater.py` | GitHub release checking, semver comparison, update asset resolution. |
| `config.py` | Global settings, path resolution, runtime tool discovery. |
| `models.py` | Python data models (`PlaylistItem`, `VideoPage`, etc.). |

### Typed Rust Core (`rust/`)
| File / Module | Purpose |
| :--- | :--- |
| `src/lib.rs` | Domain API exports (`rlib`) and FFI C-ABI entrypoints (`cdylib`). |
| `src/media_page_selection.rs` | Pure matching and ranking algorithm for video pages. |
| `src/audio_binding.rs` | Dual-audio and instrumental variant pairing policy. |
| `src/download_candidate_planning.rs` | Pure updater download URL construction, source labeling, ordering, and deduplication policy. |
| `src/media_download_candidate_planning.rs` | Pure DASH and preferred-audio primary/backup URL flattening, identity, and ordering policy. |
| `src/tool_download_candidate_planning.rs` | Pure BBDown, yt-dlp, and aria2c asset fallback construction, labeling, ordering, and deduplication policy. |
| `src/quality_policy.rs` | Pure quality-label/ID normalization plus BBDown and yt-dlp preference intent. |
| `src/video_stream_ranking.rs` | Pure DASH video codec, quality, bandwidth, AVC-cap, fallback, and stable ranking policy. |
| `src/audio_stream_ranking.rs` | Pure regular DASH audio quality ordering, Hi-Res filtering/fallback, and stable ties. |
| `src/preferred_audio_source_binding.rs` | Pure first-regular, FLAC, and Dolby preferred-audio source binding without regular ranking. |
| `src/cache_planning.rs` | Pure cache-window desired, pending, retention, and preemption planning policy. |
| `src/playlist_planning.rs` | Pure playlist ordering and duplicate-identity planning policy. |
| `src/av_delay.rs` | Pure global/local AV-delay transition, clamping, and lock-button state policy. |
| `src/tool_prepare_policy.rs` | Rust-authoritative deterministic tool prepare routing from immutable host-gathered facts. |
| `src/release_selection.rs` | Semantic version sorting and release filtering rules. |
| `src/asset_selection.rs` | Update package scoring by platform and architecture. |
| `src/ffi.rs` | FFI wrapper utilities, memory safety helpers, panic containment. |

### Rust Runtime Infrastructure (`rust-runtime/`)
| File / Module | Purpose |
| :--- | :--- |
| `src/app_state.rs` | Process-wide authoritative mutable application state, strict commands, revision/generation tracking, snapshots, and persistence effects. |
| `src/http_downloader.rs` | Typed HTTP transfer, URL fallback, progress, cancellation, response validation, and atomic publication. |
| `src/cache_runtime.rs` | Rust Native cache queues, primary/urgent workers, retries, cancellation, multi-track validation, and atomic cache-group publication. |
| `src/media_backend.rs` | Native media probing and MP4/FLAC normalization for Rust Native playback artifacts. |
| `src/bilibili_service.rs` | Bilibili WBI signing, DASH resolution, and redirect handling. |
| `src/gatcha_repository.rs` | Gacha configuration, persistence, browsing, candidate selection, and Bilibili refresh operations. |
| `src/cloudflare_service.rs` | Cloudflare API execution, pool-entry normalization, and bounded background append scheduling. |
| `src/status_service.rs` | Bilibili login state and Gacha refresh lease/status ownership. |
| `src/update_installer.rs` and `src/update_installer/` | Update extraction, native package validation and preparation, retained published-era helper launch, and the external `bilikara-updater` (`apply.rs`, `src/bin/bilikara-updater.rs`) that replaces and reopens a desktop installation. |
| `src/diagnostics.rs` | Diagnostic sanitization and artifact assembly. |
| `src/playlist_export.rs` and `src/playlist_export/` | Complete CSV/image export service, local-time formatting, reusable fonts, text layout/rasterization, PNG/ZIP and coarse wire adaptation; no AppState lock during rendering. |
| `src/networking.rs` and `src/networking/` | Native LAN interface and routing facts per platform, plus the pure address classification and ranking policy. |
| `src/ffi.rs` | Temporary C ABI, including the additive schema-v1 AppState request entry used by the Python Host adapter. |

### Tauri Shell Layer (`src-tauri/`)
| File / Module | Purpose |
| :--- | :--- |
| `src/main.rs` | Tauri application entry point and windowing initialization. |
| `tauri.conf.json` | Tauri desktop app configuration, permissions, and build targets. |

### Frontend Layer (`static/`)
| File / Module | Purpose |
| :--- | :--- |
| `index.html` / `app.js` | Host playback view, video/audio sync engine, UI state listeners. |
| `remote.html` / `remote.js` | Mobile controller UI, search, queueing, remote commands. |
| `export-guard.js` | Asynchronous action concurrency guard helper. |
| `styles.css` / `remote.css` | CSS stylesheets for Host and Remote views. |
