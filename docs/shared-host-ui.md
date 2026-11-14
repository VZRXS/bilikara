# Shared native Host UI

The desktop and Android Hosts serve the same `static/index.html`, `app.js`,
controls, song cards, dialogs and translations. Both consume the authoritative
Rust Host state. Remote remains a controller with its own page and permissions;
the audience page remains a presentation surface.

The behavior baseline is the shipped preview.2 native desktop Host, preserving
approved Preview 1 behavior and subsequent changes. Android reuses those shared components; improvements
from Android may supplement the desktop when they preserve its existing flows.
Viewport width, input method and native capabilities are separate concerns:
a compact desktop must not inherit Android-only action restrictions. The compact
Android account page waits for an explicit login action, while opening desktop
Settings retains automatic QR preparation even in a narrow window.

`native-session.js` presents the persisted-session choice on either Host.
Continuing keeps the saved session; dismissing the banner or letting its
10-second countdown finish starts a new session through the same Rust command.
Hover, keyboard focus and a hidden page pause the countdown. A failed command
leaves the banner available for retry without retrying automatically.
The shared Host song controls expose the existing rating dialog for the selected
session requester. Host and Remote submissions retain their playback identity
across layout changes, release failed submissions for retry, and check HTTP and
service failures before retaining a successful submission. The native backend
validates identity and eligible plays independently of these presentation gates.
`host-layout.js` adapts the shared controls to a phone navigation dock or the
existing desktop workspace rail. Preview 2 uses responsive layout without an
Auto/Desktop/Phone selector: On Android, Phone applies below 700 CSS pixels, independently of keyboard height
or physical orientation. Desktop keeps its workspace rail and compact tool sheets
at narrow widths; it does not adopt phone navigation. The desktop shell retains
its minimum window size. Earlier manual layout preferences remain stored but do
not override this responsive behavior. Android follows the system's
auto-rotation setting; player fullscreen temporarily requests landscape and
restores system orientation on exit. Neither Host exposes a manual direction
selector. See [Android layout](android-layout.md) for the native limitations.

Layout changes move existing non-media controls, retaining their drafts,
selection and applicable focus/scroll state. They do not reparent the player,
recreate its media elements or create another Signalsmith graph. The existing
`android-*` DOM hooks remain stable while the layout implementation is shared.

Uncached part-audio pills request an in-place audio supplement. They retain
their label, use a dashed outline and show a horizontal progress fill without
percentage/status text or a plus. Progress-only snapshots retain pill nodes,
expanded lists and scroll position; paints coalesce to once per second, with
terminal state delivered immediately. Verified completion gives the pill a
solid outline and enables selection, without switching the playing part.
Desktop/mobile Hosts and Remote share this presentation in `part-selector.js`.
The action never adds another playlist entry. HTTP admission and background
worker failures both release the pill for explicit retry, retain the reason
and mark the failed page. Existing error feedback reports once per attempt,
including retries whose queued frame was not observed. The diagnostic copy
includes bounded supplement status, page, attempt and reason. Reduced motion removes the
indeterminate sweep and progress transitions.

Playback circles share their ordinary outline; disabled controls have no hover
feedback or help. Restart becomes available after the current Host playback
generation is ready. Desktop Host shows it inline and supports mouse-hover or
keyboard-focus help; Remote keeps held-touch help. A portrait capsule first
grows around Next, then extends left. Sliding onto Restart arms its pressed
state; releasing there submits it, while moving away or cancelling does nothing.
Opening the capsule is independent of media readiness: a visible, enabled Next
can reveal it while Restart stays disabled, including across state refreshes.
Only an enabled Restart may arm or submit a playback command.
Next keeps its original node and visual layer throughout the animation.

Remote's playback sheet uses the same surface morph for taps and drags. Its
persistent top handle crossfades with the sheet content and has a wider invisible
click target; rating and refresh retain priority where targets meet. Animation
lays out the sheet once and moves/clips its outer surface instead of resizing
its content every frame. Sheet surfaces and ordinary buttons may start a
vertical drag. A button retains its normal press/tap feedback until at least
12px of predominantly vertical movement claims the gesture; that release
cannot activate the button. Text, range and select inputs retain their own
gestures. An overflowing content body owns its
whole scroll gesture, including at the top edge; the header remains available
to dismiss. A first pointer gesture on the hidden seek thumb only reveals it;
subsequent gestures seek, while keyboard navigation remains immediate.
Single-screen fullscreen uses the audience screen's
shared cache-status presentation, including indeterminate/progress and failure
states, and hides it again when playback is ready or fullscreen exits.
Fullscreen and the audience output both show incoming-request notices,
including the first accepted song while idle. Restart is recognized from the
existing adjacent, current-generation seek-to-zero and play commands after
playback is observed; it shares a feedback slot with seek and play/pause.

Desktop workspace and scroll ownership remain explicit:

Sources and Session Users keep the same 8px list-to-tool spacing; desktop also
shares their platform panel inset. Android Source pagination uses Remote's
44px track and 4px bottom inset, in one native footer frame below the tools.
The tools' reserved trash slot and the frame's 4px gap supply 8px between visible
controls. Session-user name actions retain horizontal ellipsis and a 20px
line with vertical paint room, so descenders such as `g` fit without increasing
the badge's height.

| Surface | Placement and scroll owner |
| --- | --- |
| Queue and History | Direct destinations on an independent fixed right-side tool rail. Queue's Now Playing card owns the current-song actions; the waiting queue and history list own their scrolling. |
| Request workspaces | Use the same width at a fixed viewport. Search, discovery and source detail keep one scroll owner for the active list, without scrolling their controls away. |
| Player Stage | Uses width-and-height measured Stage modes. Song and playback controls fit the available frame; they do not change the workspace width or replace media nodes. |
| Global toolbar | Keeps one-line icon-plus-label controls. Anchored menus remain viewport-clamped and retain their nodes through exit. |
| Window frame | Uses platform-specific integrated window chrome. Native fullscreen hides the toolbar, tool rail and workspace at every desktop width and restores their existing nodes on exit. |

Common components have one maintained structure, action definition and base
style, rather than a shared initial render followed by a separate phone render:

Source management combines ordering with selection on both pointer types.
Checkbox regions select without starting a drag; the rest of each selected-mode
card uses the grab cursor and moves the selected group, with a translucent
preview. Clicking anywhere still selects. Ordinary mouse clicks browse, and
phone holds enter selection. Both source and session-user selections use an
inset border without changing their outer dimensions.
Footer actions use the shared localized help bubble, including the inert
source trash target. Switching workspaces or UP/favorites tabs exits selection;
pagination retains it. Automatic source-completion reloads coalesce while a
card is held or dragged, then resume after release/cancellation. Actual source
version conflicts still reject edits. Both detail views keep their header and
search controls fixed with hover paint room; only the result list scrolls.
Interior insertion guides bisect the measured card gap; row edges keep their
guides within the scroll boundary. Existing card/media nodes remain stable.
Bounded local source edits use the repository commit lock without replacing a
network refresh's status lease. Refresh publication retains the latest source
membership, including during schema rebuilds, so deleted sources stay deleted.
Deletion also prunes active queue placeholders and failure retry entries while
retaining the in-flight worker's lease until it retires; late completion uses
only the remaining source selection.
The favorite chooser presents its folder count beside the section heading using
the shared small count style. Its single body/footer gap equals the outer inset.
UP/favorites details hide the outer source-add row and retain their own search.
Returning restores the same add-input nodes and their unsubmitted drafts.
Android and iOS source lists share horizontal pagination and selection tools.
Their browse pages measure the available viewport and fit complete card rows;
desktop retains its existing workspace layout. Background source metadata that
does not change visible card content must retain the card's image nodes.
Search results fill the panel's remaining height after visible query/status
content; empty status nodes leave neither a track nor a gap. Native name/artist
contextual navigation stays above its result frame in portrait, landscape and
two-column tablet layouts, including when a session-user notice is visible.
Category pagination uses the server's exact matched count when supplied; when
the provider omits it, keep navigation available without displaying a guessed
total. Phone category switches use ordinary 44px controls and 16px text, with
accent color and bold text for the selected category, without a glow.
Mobile Host song details use a page-wide backdrop, dialog semantics and a
contained keyboard focus cycle; desktop details retain their contextual
workspace surface. The same detail node survives reopening and layout changes.
Phone queue action menus use equal 12px gaps between visible controls, wrapping
when translated labels need more room. Their compact 32px visuals retain 44px
touch targets. Shared Host/Remote toasts fit their content up to 75% of viewport
width, retaining at least 16px at each viewport edge; short notices stay compact.
Remote keeps its playback dock visible without a song: it opens a localized
empty sheet with disabled transport/seek/rating controls. New snapshots and
reconnections reuse that sheet; a missing item cannot submit playback commands.

- `session-user-editor.js` owns shared stable-ID roster editing, selection, rename,
  ordered batch dragging and deletion. `app.js` connects it to authoritative
  snapshots and HTTP actions,
  including pending state, translations and retry feedback. Existing badge and
  button nodes survive reordering and responsive changes. Both layouts expose
  the same keyboard-accessible actions; pointer layouts also retain dragging.
  Touch targets adapt to input capability; narrow width alone does not disable
  desktop dragging. A mixed mouse/touch device retains its mouse operations.
  Tags keep the same 36px pill body on touch devices, with a separate 44px hit
  region. In ordinary mode a 350ms hold anywhere on the tag starts its visible
  drag; movement before the hold belongs to native scrolling. Selection mode
  retains immediate group dragging outside the checkbox. Ordinary short taps
  no longer open a second action menu: Rename and Select remain explicit tools.
  Alt+Up/Down on a focused name reorders by stable ID through the same
  version-checked command. Roster changes and interrupted gestures cancel holds
  and drags without submitting an edit.
  These rules implement V6 N04 and C01/C02: application long-press dragging is
  retained, while browser text selection/callouts are suppressed on tags and
  editing-tool chrome, including tool-row gaps and trash icons. Source tools
  use the same distinction. Editable fields, page numbers and copyable URLs
  retain native selection. Shared surfaces suppress the browser's default tap
  tint while preserving application pressed states and keyboard focus outlines.
- `index.html` groups account status and login into one section. Layout code
  moves that section and the cache-settings container as units. Cache fields
  retain their common order and wrap through shared Flex rules; a new field
  does not need adding to a second phone placement list.
- The desktop workspace rail defines equivalent navigation labels, icons,
  targets and compact-page grouping. The dock and compact workspace tabs reuse
  those definitions. Playback and My remain compact outer-page entries.
  Phone navigation selects the accent-colored icon and bold label without a
  filled tile; all five complete button targets and pressed/focus states remain.
  V7 restores visible localized title pairs on phone pages; queue actions and
  contextual tabs retain their own rows. Existing headings are reused and their
  measured space participates in result capacity. Desktop headings stay visible.
- `styles.css` owns component visuals and tokens. `host-layout.css` adapts
  placement, available space and touch geometry without a second component
  renderer. A shared component change must reach both native Hosts from that
  shared definition; a layout preference alone does not establish this.

Platform adapters stay narrow:

- Android links the shared Rust application services in process, with no Python
  backend, sidecar or media-CLI requirement. Pure domain logic stays independent
  of Tauri, FFI transport and platform adapters.
- Desktop Tauri owns window preferences, native dialogs, exports, validated
  external links and update activation. Shell commands verify the main window
  and its native Host origin; a frontend capability flag grants no permission.
- Android owns orientation/fullscreen, background playback handling,
  permission/share dialogs and APK verification/system installation consent.
  `android-host.js` contains only Android window/display hooks. Its playback,
  export and presentation adapters remain separate from the shared UI.
- `host-updates.js` supplies one update action interface to the shared controls.
  Desktop uses the private shell activation boundary; Android uses its APK
  adapter and Rust operation settlement. Neither can enter the other's installer.
  See [native desktop deployment](native-desktop.md) for supported installation
  layouts and the Preview 1 macOS transition limitation.

Tauri embeds the same maintained `static/` directory for Android. Desktop
bundles stage that directory alongside the native backend. The desktop startup
and update validators require the shared layout/session/update modules, so a
package missing these resources fails explicitly.

Android remains a preview. Background playback, external display/audio routing
and device-specific WebView behavior retain their documented limitations;
sharing the interface does not certify long sessions or casting. Desktop
feature parity and platform acceptance remain separate from UI convergence.

### V7 scanner, selection and bounded result geometry

The shared live scanner reserves its stage before acquisition and paints the
first frame with centered `object-fit: cover`, without scale/size transitions.
The decoder receives that same visible source rectangle; image imports still
use their entire image. Lens autofocus/zoom behavior is a separate device gate.

Closed runtime selects retain native selection semantics, 34px pill geometry
and a 1px `--line` boundary in each theme. Fixed heading/label/status chrome
suppresses selection; inputs, copyable links, user prose and diagnostic/error
details retain native copying. This does not install a document-wide gesture
blocker.

Bounded result grids measure layout border boxes rather than animated paint
bounds. The first card is observed alongside viewport/content/font changes.
Headings, footer, safe area and native dock occupy their existing layout tracks
once. Complete rows are selected with the existing floor policy, never a forced
three-row rule. Numeric recent geometry is available through the shared pager's
bounded diagnostic snapshot; no query or source identity is recorded.
