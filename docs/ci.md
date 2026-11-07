# CI and Bundle

CI checks source behavior; Bundle constructs and verifies install packages.
Release calls Full CI before Bundle and retains the six-target artifact and
publication integrity gates. The six distributable targets are Windows x64,
Windows ARM64, macOS ARM64, macOS Intel, Android ARM64 and iOS ARM64 unsigned.
The original unsigned IPA is a direct GitHub Release asset and is included in
the R2 mirror, metadata and checksums; it normally needs signing before device
installation. A manual Bundle is independent of CI, defaults to all six targets
and never publishes a release. Optional iOS Ad Hoc signing adds a package;
the unsigned IPA remains available regardless.

CI runs only in the public `VZRXS/bilikara` repository. Private development in
`VZRXS/bilikara-next` uses local checks; keep its CI workflow disabled. Both
Plan and Gate are also rejected by
job conditions before runner allocation, and all other CI jobs depend on Plan.
This also applies to manual and reusable CI calls in the private repository.
Public CI, Bundle and Release validation retain their existing gates.

Automatic CI requires a complete pull-request or push comparison. Plain Markdown
documentation uses the docs job. Top-level shared CSS and the existing Host,
Remote, controller and audience HTML use the Linux frontend job and auxiliary
contracts. This lane exercises Chromium/WebKit and the actual native Linux Host,
without scheduling the Full CI platform matrix. Full CI uses one five-platform
matrix: Linux (`ubuntu-latest`), Windows (`windows-latest`) and macOS
(`macos-latest`) invoke desktop checks; Android (`ubuntu-latest`) and iOS
(`xcode-27`) invoke mobile checks. JavaScript, generated
compatibility assets, platform/build/dependency/security paths and unknown changes
use Full CI. Missing, truncated or failed comparisons also use Full. Docs-only
and eligible Frontend-only plans skip the entire platform matrix. Manual CI has
no scope selector and always runs Full, as do explicit Full and Release calls.

The preflight emits an explicit job plan. CI Gate rejects failures, cancellations,
missing jobs, unexpected successes and unplanned skips. It validates the actual
five-platform matrix definition and retains the aggregate result check. Full
plans additionally read paginated Jobs API results for the current run using
the existing `actions: read` permission. Each platform's latest execution must
be completed and successful, even if the aggregate reports success. All attempts
are read so partial reruns can reuse older successful jobs that were not rerun;
newer failed, cancelled, skipped or incomplete executions cannot be masked by
older successes. Duplicate latest executions, missing jobs, malformed responses
and API failures fail closed. Exact job names share the running Gate's
workflow-call prefix, preventing unrelated jobs from satisfying the check.
Lightweight plans keep their explicit expected skips without a Jobs API call.
Branch/PR deduplication
requires an open PR for the same repository, branch and commit; release and
explicit Full calls bypass this optimization.
Explicit Full calls have separate concurrency groups so they cannot cancel a
caller's parallel package construction. Automatic branch/PR checks still cancel
stale automatic runs.

Shared Node suites retain their ordinary npm entry points. CI uses
`node scripts/ci_tests.mjs shared` to select their union, retaining test-worker
isolation while removing repeated source and browser tests. Use `--list` to
inspect selections without running them. The frontend and tooling groups follow
the same rules. Linux native-host Cargo tests belong to Desktop/Linux; iOS keeps
its Apple SDK and native-host checks.
The update-preferences browser fixture compiles the shell's actual file adapter
as a test-only Runtime example, reusing the prepared Host graph without building
unrelated Linux windowing dependencies. Browser teardown stops polling before
retiring its Host and isolated data.

Native desktop dev builds and Node's explicit `host-tuple` builds share one
native target directory; Bundle also passes that target to the Tauri CLI so
artifact discovery uses the same directory. The retained Python FFI release
builds keep their original implicit output paths. Bundle's timestamp regression reuses the
release/native-host test profile prepared by `libav-finish`; Cargo still selects
the current artifact. Release, debug, target and feature distinctions remain
under Cargo's validation.

iOS Check caches the Tauri graph and keeps its store separate from unsigned
Bundle, so an immutable Check save cannot prevent storing compiled app artifacts.
SDK/target identities are part of the effective Rust shared keys, including the
partial-restore boundary; the action ignores a separate `key` alongside
`shared-key`. Android caches include xtask and distinguish API/NDK/ABI and debug
from release. Gradle, npm and pip retain their independent dependency caches.
Ad Hoc/release profiles remain separate. The cached XcodeGen archive is hashed before every
extraction. FFmpeg/libav caches remain verified upstream C libraries only;
companions, native drivers and package metadata are rebuilt after restore.
Linux saves its verified C cache after the real prerequisite contracts pass,
so a later unrelated frontend or Python failure does not discard that build.
CI also saves Cargo compiler artifacts after a later test failure; Cargo still
validates every selected artifact and no successful test result is cached.

iOS puts `--standalone-icon-behavior all` in the generated Xcode project's
`ASSETCATALOG_OTHER_FLAGS` before building, retaining
both primary icon PNG scales alongside `Assets.car` for
exact pixel verification without changing the sealed app. Before the direct iOS
Cargo check, the pinned Tauri CLI initializes the project and aligns manifest
features with the iOS configuration. Desktop Cargo checks retain their existing
manifest and features.

Actions summaries record selected jobs/targets, removed duplicate selections,
cache restore outcomes, completed step timings and native test Cargo freshness.
Post-job logs remain authoritative for cache save results and transfer overhead.
Compare matching targets, profiles, inputs and cache states before attributing
wall-clock changes to an optimization. No additional compiler cache is enabled
without evidence that its transfer/setup cost benefits the remaining workload.

Validate workflow changes with `npm run test:auxiliary`,
`node scripts/ci_tests.mjs tooling` and actionlint. Platform and extracted-package
checks still require their actual operating systems and native prerequisites.
